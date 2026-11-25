import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { DomainEvent } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import type { ServerResponse } from 'node:http';
import { buildTenantContext } from '../../common/guards';
import type { ShareType } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, REDIS, type Redis } from '../../infra/tokens';
import { DeliveryService } from './delivery.service';
import { canReadRecord } from './mentions';
import { RECORD_TYPES } from './records.service';

const HEARTBEAT_MS = 20_000;
const CONTEXT_TTL_MS = 15_000;
const REPLAY_WINDOW = '72 hours';
const REPLAY_LIMIT = 500;
export const presenceKey = (tenantId: string, userId: string) => `presence:${tenantId}:${userId}`;
export const realtimeChannel = (tenantId: string) => `rt:${tenantId}`;

interface Connection {
  res: ServerResponse;
  ctx: TenantRequestContext;
  loadedAt: number;
  queue: Promise<void>;
}

/** Server-sent events (ADR-0007). Every event of the tenant reaches the API instances through Redis pub/sub;
 *  each connection decides per event whether its user may see it (record read access or notification
 *  recipient), so the stream never carries what the REST API would hide. Payloads are minimal (type, record
 *  reference, changed field names); clients fetch details through REST. */
@Injectable()
export class StreamService implements OnApplicationShutdown {
  private readonly log = new Logger('stream');
  private readonly byTenant = new Map<string, Set<Connection>>();
  private subscriber: Redis | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(@Inject(DB) private readonly db: DbHandle, @Inject(REDIS) private readonly redis: Redis, private readonly delivery: DeliveryService) {}

  private ensureSubscriber(): Redis {
    if (this.subscriber) return this.subscriber;
    const sub = this.redis.duplicate();
    sub.on('message', (channel: string, message: string) => { this.onMessage(channel, message); });
    this.subscriber = sub;
    this.heartbeat = setInterval(() => {
      for (const set of this.byTenant.values()) {
        for (const c of set) {
          c.res.write(': keep-alive\n\n');
          this.present(c);
        }
      }
    }, HEARTBEAT_MS);
    return sub;
  }

  async open(t: TenantRequestContext, res: ServerResponse, lastEventId: string | undefined): Promise<void> {
    const conn: Connection = { res, ctx: t, loadedAt: Date.now(), queue: Promise.resolve() };
    const sub = this.ensureSubscriber();
    // Subscribed before the headers go out: a client that has the response misses no later event.
    await sub.subscribe(realtimeChannel(t.tenant.id));
    // no-transform: compressing proxies (the web app's /api rewrite) must not buffer the stream (P6a finding).
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    let set = this.byTenant.get(t.tenant.id);
    if (!set) {
      set = new Set();
      this.byTenant.set(t.tenant.id, set);
    }
    set.add(conn);
    this.present(conn);
    res.on('close', () => {
      const s = this.byTenant.get(t.tenant.id);
      s?.delete(conn);
      if (s && s.size === 0) {
        this.byTenant.delete(t.tenant.id);
        void sub.unsubscribe(realtimeChannel(t.tenant.id));
      }
    });
    if (lastEventId) conn.queue = conn.queue.then(() => this.replay(conn, lastEventId));
  }

  /** Online mark (e-mail goes to people who are away): renewed by the heartbeat, gone soon after the last stream. */
  private present(conn: Connection): void {
    void this.redis.set(presenceKey(conn.ctx.tenant.id, conn.ctx.principal.userId), '1', 'PX', HEARTBEAT_MS * 2).catch(() => undefined);
  }

  /** A client reports it received a notification event: the latency a person sees. */
  async ack(t: TenantRequestContext, eventId: string): Promise<void> {
    const me = t.principal.userId;
    const r = await this.db.withTenant(dbCtx(t), (tx) => tx.execute<{ occurred_at: string }>(sql`
      SELECT occurred_at FROM outbox_events WHERE id = ${eventId} AND type = 'notification.created' AND payload -> 'userIds' ? ${me} AND occurred_at > now() - interval '10 minutes'`));
    const at = r.rows[0]?.occurred_at;
    if (at) await this.delivery.record(t.tenant.id, me, 'client', 'delivered', new Date(at));
  }

  /** Missed events since `Last-Event-ID`, filtered exactly like live ones; too old → `resync.required`. */
  private async replay(conn: Connection, lastEventId: string): Promise<void> {
    const rows = await this.db.withTenant(dbCtx(conn.ctx), async (tx) => {
      const known = await tx.execute(sql`SELECT 1 FROM outbox_events WHERE id = ${lastEventId} AND occurred_at > now() - ${REPLAY_WINDOW}::interval`);
      if ((known.rowCount ?? 0) === 0) return null;
      return (await tx.execute<{ id: string; type: string; version: number; tenant_id: string; occurred_at: string; actor: DomainEvent['actor']; resource_type: string | null; resource_id: string | null; segment: 'b2b' | 'b2c' | null; payload: Record<string, unknown>; causation_id: string | null; correlation_id: string; depth: number }>(sql`
        SELECT id, type, version, tenant_id, occurred_at, actor, resource_type, resource_id, segment, payload, causation_id, correlation_id, depth FROM outbox_events
        WHERE id > ${lastEventId} AND occurred_at > now() - ${REPLAY_WINDOW}::interval ORDER BY id LIMIT ${REPLAY_LIMIT}`)).rows;
    }).catch(() => null);
    if (!rows || rows.length === REPLAY_LIMIT) {
      conn.res.write('event: resync.required\ndata: {}\n\n');
      if (!rows) return;
    }
    for (const r of rows) {
      await this.deliver(conn, {
        id: r.id, type: r.type, version: r.version, tenantId: r.tenant_id, occurredAt: new Date(r.occurred_at).toISOString(), actor: r.actor,
        resource: r.resource_type && r.resource_id ? { type: r.resource_type, id: r.resource_id, segment: r.segment } : null,
        causationId: r.causation_id, correlationId: r.correlation_id, depth: r.depth, payload: r.payload,
      });
    }
  }

  private onMessage(channel: string, message: string): void {
    const tenantId = channel.slice('rt:'.length);
    const set = this.byTenant.get(tenantId);
    if (!set) return;
    let event: DomainEvent;
    try {
      event = DomainEvent.parse(JSON.parse(message));
    } catch {
      return;
    }
    // Per connection, in order: a slow permission check for one user never reorders another user's stream.
    for (const c of set) c.queue = c.queue.then(() => this.deliver(c, event, true)).catch((e: unknown) => { this.log.warn(`stream delivery failed: ${(e as Error).message}`); });
  }

  /** May this connection's user see the event? Notifications: only their recipients. Records: read access now. */
  private async visible(conn: Connection, event: DomainEvent): Promise<boolean> {
    if (event.type.startsWith('notification.')) {
      const to = Array.isArray(event.payload.userIds) ? (event.payload.userIds as string[]) : [];
      return to.includes(conn.ctx.principal.userId);
    }
    if (event.type === 'config.changed') {
      // Tenant layer: every member reloads the effective configuration; user layer: only that user.
      return event.payload.scope !== 'user' || event.payload.userId === conn.ctx.principal.userId;
    }
    if (!event.resource || !(RECORD_TYPES as readonly string[]).includes(event.resource.type)) return false;
    if (Date.now() - conn.loadedAt > CONTEXT_TTL_MS) {
      // Rights may have changed (role, team, share, segment): reload, and close the stream if membership ended.
      try {
        conn.ctx = await buildTenantContext(this.db, { ...conn.ctx.principal, tenantId: conn.ctx.tenant.id });
        conn.loadedAt = Date.now();
      } catch {
        conn.res.end();
        return false;
      }
    }
    const resource = event.resource;
    return this.db.withTenant(dbCtx(conn.ctx), (tx) => canReadRecord(tx, conn.ctx, resource.type as ShareType, resource.id));
  }

  private async deliver(conn: Connection, event: DomainEvent, live = false): Promise<void> {
    if (conn.res.writableEnded || !(await this.visible(conn, event))) return;
    const data = event.type.startsWith('notification.')
      ? { type: event.type, notificationIds: event.payload.notificationIds ?? [] }
      : event.type === 'config.changed'
        ? { type: event.type, key: event.payload.key, scope: event.payload.scope, version: event.payload.version }
        : {
          type: event.type,
          resource: event.resource ? { type: event.resource.type, id: event.resource.id } : null,
          changedFields: event.payload.changedFields ?? undefined,
          // Who acted, so a client can tell its own edits from someone else's (the timeline shows the same).
          actor: { type: event.actor.type, id: event.actor.type === 'user' ? event.actor.id : null },
          occurredAt: event.occurredAt,
        };
    conn.res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`);
    // A replay is as late as its reader was away: only live deliveries are measured.
    if (live && event.type === 'notification.created') void this.delivery.record(conn.ctx.tenant.id, conn.ctx.principal.userId, 'stream', 'delivered', new Date(event.occurredAt));
  }

  /** Called by the event consumer after an event was processed. */
  async publish(event: DomainEvent): Promise<void> {
    await this.redis.publish(realtimeChannel(event.tenantId), JSON.stringify(event));
  }

  onApplicationShutdown(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.byTenant.values()) for (const c of set) c.res.end();
    this.subscriber?.disconnect();
  }
}
