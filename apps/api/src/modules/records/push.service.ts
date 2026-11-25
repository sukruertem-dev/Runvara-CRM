import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { DomainEvent, PushSubscribe, z } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import { Queue, Worker, type Job } from 'bullmq';
import webpush from 'web-push';
import { assertSafeOutboundUrl, safePost } from '../../common/egress';
import { buildTenantContext } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, ENV, REDIS, type ApiEnv, type Redis } from '../../infra/tokens';
import { DeliveryService, personalDelivery, quietNow, type PersonalDelivery } from './delivery.service';
import { NotificationsService } from './notifications.service';

// Web push (MEN-07, ADR-0017 §3): the message names who acted and opens the notice; what it is about is read
// through the API when it opens, with the rights of that moment. Endpoints come from browsers, so they follow
// the outbound rules (ADR-0013): https, public addresses, no redirects.

export const PUSH_QUEUE = 'push';
const MAX_SUBSCRIPTIONS = 10;
const TTL_SECONDS = 24 * 3600;

interface PushJob { tenantId: string; userId: string; kind: string; sourceType: string; sourceId: string; occurredAt: string }

const TEXT = {
  tr: { mention: '{actor} sizi bir kayıtta andı', assigned: '{actor} size bir kayıt atadı', ask: 'Onayınızı bekleyen bir talep var', decided: 'Onay talebiniz sonuçlandı', other: 'Yeni bir bildiriminiz var', someone: 'Biri' },
  en: { mention: '{actor} mentioned you on a record', assigned: '{actor} assigned you a record', ask: 'A request is waiting for your approval', decided: 'Your approval request was decided', other: 'You have a new notification', someone: 'Someone' },
} as const;

function titleOf(p: PersonalDelivery, kind: string, sourceType: string, actor: string | null): string {
  const t = TEXT[p.language];
  const text = kind === 'mention' ? t.mention : kind === 'assigned' ? t.assigned : kind === 'approval' ? (sourceType === 'approval_request' ? t.ask : t.decided) : t.other;
  return text.replace('{actor}', actor ?? t.someone);
}

@Injectable()
export class PushService implements OnApplicationShutdown {
  private readonly log = new Logger('push');
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: ApiEnv,
    private readonly notifications: NotificationsService,
    private readonly delivery: DeliveryService,
  ) {
    this.queue = new Queue(PUSH_QUEUE, { connection: redis, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 1000 } });
  }

  private vapid(): { subject: string; publicKey: string; privateKey: string } | null {
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey } = this.env;
    return publicKey && privateKey ? { subject: this.env.VAPID_SUBJECT, publicKey, privateKey } : null;
  }

  // ------------------------------------------------------------------ a person's browsers
  config(): { publicKey: string | null } {
    return { publicKey: this.vapid()?.publicKey ?? null };
  }

  async subscribe(t: TenantRequestContext, body: z.infer<typeof PushSubscribe>, userAgent: string | null): Promise<void> {
    if (!this.vapid()) throw new ProblemError('UPSTREAM_UNAVAILABLE', 'web push is not configured');
    await assertSafeOutboundUrl(body.endpoint, { allowInsecureLocalhost: this.env.EGRESS_ALLOW_INSECURE_LOCALHOST });
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT app.claim_push_endpoint(${body.endpoint})`);
      await tx.execute(sql`
        INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
        VALUES (${t.tenant.id}, ${t.principal.userId}, ${body.endpoint}, ${body.keys.p256dh}, ${body.keys.auth}, ${userAgent})
        ON CONFLICT (tenant_id, user_id, endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, created_at = now()`);
      // The oldest browsers make room.
      await tx.execute(sql`DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions ORDER BY created_at DESC, id DESC OFFSET ${MAX_SUBSCRIPTIONS})`);
    });
  }

  async unsubscribe(t: TenantRequestContext, endpoint: string): Promise<void> {
    await this.db.withTenant(dbCtx(t), (tx) => tx.execute(sql`DELETE FROM push_subscriptions WHERE endpoint = ${endpoint}`));
  }

  // ------------------------------------------------------------------ delivery
  /** Event consumer: one job per recipient; a repeated event finds its job already there. */
  async process(event: DomainEvent): Promise<void> {
    if (event.type !== 'notification.created' || !this.vapid()) return;
    const p = event.payload;
    if (typeof p.kind !== 'string' || typeof p.sourceType !== 'string' || typeof p.sourceId !== 'string') return;
    const users = [p.userIds, p.silentUserIds].flatMap((x) => (Array.isArray(x) ? (x as string[]) : []));
    for (const userId of users) {
      const data: PushJob = { tenantId: event.tenantId, userId, kind: p.kind, sourceType: p.sourceType, sourceId: p.sourceId, occurredAt: event.occurredAt };
      await this.queue.add('push', data, { jobId: `push-${event.id}-${userId}` });
    }
  }

  startWorker(): void {
    this.worker ??= new Worker(PUSH_QUEUE, async (job: Job<PushJob>) => { await this.deliver(job.data); }, { connection: this.redis.duplicate(), concurrency: 8 });
  }

  /** To every browser of one person. Quiet hours and lost access end it; a browser that is gone is forgotten. */
  async deliver(job: PushJob): Promise<void> {
    const vapid = this.vapid();
    if (!vapid) return;
    const ctx = await buildTenantContext(this.db, { userId: job.userId, sessionId: 'push', tenantId: job.tenantId, amr: [] }).catch(() => null);
    if (!ctx) return;
    const found = await this.db.withTenant(dbCtx(ctx), async (tx) => {
      const wants = await tx.execute(sql`SELECT 1 WHERE 'push' = ANY (COALESCE(
        (SELECT channels FROM notification_preferences WHERE user_id = ${job.userId} AND kind = ${job.kind}), app.default_channels(${job.tenantId}, ${job.kind})))`);
      if ((wants.rowCount ?? 0) === 0) return null;
      const subs = await tx.execute<{ id: string; endpoint: string; p256dh: string; auth: string }>(sql`SELECT id, endpoint, p256dh, auth FROM push_subscriptions`);
      return subs.rows.length === 0 ? null : { subs: subs.rows, personal: await personalDelivery(tx, job.tenantId, job.userId) };
    });
    if (!found) return;
    if (quietNow(found.personal)) {
      await this.delivery.record(job.tenantId, job.userId, 'push', 'quiet');
      return;
    }
    const notice = await this.notifications.bySource(ctx, job.kind, job.sourceType, job.sourceId);
    // Withdrawn or read meanwhile: nothing to announce.
    if (!notice || notice.readAt) return;
    if (!notice.accessible) {
      await this.delivery.record(job.tenantId, job.userId, 'push', 'no_access');
      return;
    }
    const payload = JSON.stringify({ title: titleOf(found.personal, job.kind, job.sourceType, notice.actor?.displayName ?? null), body: ctx.tenant.name, url: `/n/${notice.id}`, tag: notice.id });
    let retry = false;
    for (const s of found.subs) {
      const status = await this.send(vapid, s, payload);
      await this.delivery.record(job.tenantId, job.userId, 'push', status, status === 'delivered' ? new Date(job.occurredAt) : null);
      if (status === 'gone') await this.db.withTenant(dbCtx(ctx), (tx) => tx.execute(sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`));
      else if (status === 'delivered') await this.db.withTenant(dbCtx(ctx), (tx) => tx.execute(sql`UPDATE push_subscriptions SET last_ok_at = now() WHERE id = ${s.id}`));
      else retry = true;
    }
    // A retry reaches every browser again; the tag makes a repeated message replace itself.
    if (retry) throw new Error('push delivery failed');
  }

  private async send(vapid: { subject: string; publicKey: string; privateKey: string }, s: { endpoint: string; p256dh: string; auth: string }, payload: string): Promise<'delivered' | 'failed' | 'gone'> {
    try {
      const req = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { vapidDetails: vapid, TTL: TTL_SECONDS, contentEncoding: 'aes128gcm', urgency: 'normal' });
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-length'));
      const res = await safePost(s.endpoint, req.body, headers, { allowInsecureLocalhost: this.env.EGRESS_ALLOW_INSECURE_LOCALHOST, timeoutMs: 5_000 });
      if (res.status === 404 || res.status === 410) return 'gone';
      return res.status >= 200 && res.status < 300 ? 'delivered' : 'failed';
    } catch (e) {
      this.log.warn(`push request failed: ${(e as Error).message}`);
      return 'failed';
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
