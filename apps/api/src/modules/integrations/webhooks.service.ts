import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { DomainEvent, WebhookCreate, WebhookPatch, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { decrypt, encrypt, randomToken } from '@flexa/security';
import { Queue, Worker, type Job } from 'bullmq';
import { createHmac, randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { resolveSafeOutbound, safePost } from '../../common/egress';
import { mapDbError } from '../../common/http-helpers';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { uuidArray } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, ENV, REDIS, type ApiEnv, type Redis } from '../../infra/tokens';
import { eventBackoff } from '../automation/backoff';
import { ProvisioningService } from '../tenancy/provisioning.service';

export const WEBHOOK_CONSUMER = 'webhooks';
export const DELIVERY_QUEUE = 'webhook-deliveries';
const DELIVERY_ATTEMPTS = 8;
const AUTO_DISABLE_AFTER_MS = 24 * 3600 * 1000;
const ROTATION_GRACE_MS = 24 * 3600 * 1000;

type SubRow = {
  id: string; name: string; url: string; event_types: string[]; secret_enc: Buffer; previous_secret_enc: Buffer | null; previous_valid_until: string | null;
  enabled: boolean; disabled_reason: string | null; first_failure_at: string | null; consecutive_failures: number; created_at: string; created_by: string;
};
type DeliveryRow = { id: string; subscription_id: string; event_id: string; event_type: string; status: 'pending' | 'succeeded' | 'failed' | 'dead'; attempts: number; response_status: number | null; error: string | null; latency_ms: number | null; created_at: string; last_attempt_at: string | null };
interface DeliveryJob { tenantId: string; deliveryId: string; event: DomainEvent }

/** `*`, `prefix.*` or an exact type. */
export function matchesEventType(patterns: readonly string[], type: string): boolean {
  return patterns.some((p) => p === '*' || p === type || (p.endsWith('.*') && type.startsWith(p.slice(0, -1))));
}

/** ADR-0013 §1: `Flexa-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`; during a rotation both
 *  secrets sign (two v1 values). */
export function signatureHeader(secrets: readonly string[], body: string, unixSeconds: number): string {
  const sigs = secrets.map((s) => `v1=${createHmac('sha256', s).update(`${unixSeconds}.${body}`).digest('hex')}`);
  return [`t=${unixSeconds}`, ...sigs].join(',');
}

const view = (s: SubRow, secret?: string) => ({
  id: s.id, name: s.name, url: s.url, eventTypes: s.event_types, enabled: s.enabled, disabledReason: s.disabled_reason,
  consecutiveFailures: s.consecutive_failures, createdAt: new Date(s.created_at).toISOString(), ...(secret ? { secret } : {}),
});
const deliveryView = (d: DeliveryRow) => ({
  id: d.id, eventId: d.event_id, eventType: d.event_type, status: d.status, attempts: d.attempts, responseStatus: d.response_status, error: d.error,
  latencyMs: d.latency_ms, createdAt: new Date(d.created_at).toISOString(), lastAttemptAt: d.last_attempt_at ? new Date(d.last_attempt_at).toISOString() : null,
});

/** Outgoing webhooks: subscriptions, fan-out from the event bus, signed delivery with retries, delivery
 *  history, automatic disabling after 24 h of failures (ADR-0013 §1). */
@Injectable()
export class WebhooksService implements OnApplicationShutdown {
  private readonly log = new Logger('webhooks');
  readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly provisioning: ProvisioningService,
  ) {
    this.queue = new Queue(DELIVERY_QUEUE, { connection: redis, defaultJobOptions: { attempts: DELIVERY_ATTEMPTS, backoff: { type: 'custom' }, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 1_209_600 } } });
  }

  private get egress() {
    return { allowInsecureLocalhost: this.env.EGRESS_ALLOW_INSECURE_LOCALHOST };
  }

  // ------------------------------------------------------------------ administration
  private async rows(tx: Db, id?: string): Promise<SubRow[]> {
    return (await tx.execute<SubRow>(sql`SELECT * FROM webhook_subscriptions ${id ? sql`WHERE id = ${id}` : sql``} ORDER BY name`)).rows;
  }

  private async one(tx: Db, id: string): Promise<SubRow> {
    const [r] = await this.rows(tx, id);
    if (!r) throw new ProblemError('NOT_FOUND');
    return r;
  }

  private async checkUrl(url: string): Promise<void> {
    try {
      await resolveSafeOutbound(url, this.egress);
    } catch (e) {
      if (e instanceof ProblemError) throw new ProblemError('WEBHOOK_URL_INVALID', e.message);
      throw e;
    }
  }

  async list(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => ({ data: (await this.rows(tx)).map((r) => view(r)) }));
  }

  async create(t: TenantRequestContext, body: z.infer<typeof WebhookCreate>, ip: string) {
    authorize(t, 'tenant.config.manage');
    await this.checkUrl(body.url);
    const secret = `whsec_${randomToken()}`;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const { key, version } = await this.provisioning.tenantKey(tx, t.tenant.id);
      const id = randomUUID();
      try {
        await tx.execute(sql`INSERT INTO webhook_subscriptions (id, tenant_id, name, url, event_types, secret_enc, key_version, created_by)
          VALUES (${id}, ${t.tenant.id}, ${body.name}, ${body.url}, ${`{${body.eventTypes.join(',')}}`}::text[], ${encrypt(key, secret, `webhook:${id}`)}, ${version}, ${t.principal.userId})`);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', `webhook "${body.name}" already exists`);
        mapDbError(e);
      }
      await audit(tx, t.tenant.id, { action: 'webhook.created', actorId: t.principal.userId, targetType: 'webhook', targetId: id, ip, details: { url: body.url, eventTypes: body.eventTypes } });
      return view(await this.one(tx, id), secret);
    });
  }

  async patch(t: TenantRequestContext, id: string, body: z.infer<typeof WebhookPatch>, ip: string) {
    authorize(t, 'tenant.config.manage');
    if (body.url) await this.checkUrl(body.url);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = await this.one(tx, id);
      const reenable = body.enabled === true && !cur.enabled;
      try {
        await tx.execute(sql`UPDATE webhook_subscriptions SET name = ${body.name ?? cur.name}, url = ${body.url ?? cur.url},
          event_types = ${`{${(body.eventTypes ?? cur.event_types).join(',')}}`}::text[], enabled = ${body.enabled ?? cur.enabled},
          disabled_reason = ${body.enabled === false ? 'manual' : reenable ? null : cur.disabled_reason},
          consecutive_failures = ${reenable ? 0 : cur.consecutive_failures}, first_failure_at = ${reenable ? null : cur.first_failure_at}
          WHERE id = ${id}`);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a webhook with that name exists');
        mapDbError(e);
      }
      await audit(tx, t.tenant.id, { action: 'webhook.updated', actorId: t.principal.userId, targetType: 'webhook', targetId: id, ip, details: { fields: Object.keys(body) } });
      return view(await this.one(tx, id));
    });
  }

  async remove(t: TenantRequestContext, id: string, ip: string): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await this.one(tx, id);
      await tx.execute(sql`DELETE FROM webhook_subscriptions WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: 'webhook.deleted', actorId: t.principal.userId, targetType: 'webhook', targetId: id, ip });
    });
  }

  /** New secret; the previous one keeps signing for 24 h so receivers can switch without dropping events. */
  async rotate(t: TenantRequestContext, id: string, ip: string) {
    authorize(t, 'tenant.config.manage');
    const secret = `whsec_${randomToken()}`;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const cur = await this.one(tx, id);
      const { key, version } = await this.provisioning.tenantKey(tx, t.tenant.id);
      await tx.execute(sql`UPDATE webhook_subscriptions SET previous_secret_enc = secret_enc, previous_valid_until = ${new Date(Date.now() + ROTATION_GRACE_MS)},
        secret_enc = ${encrypt(key, secret, `webhook:${cur.id}`)}, key_version = ${version} WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: 'webhook.secret_rotated', actorId: t.principal.userId, targetType: 'webhook', targetId: id, ip });
      return view(await this.one(tx, id), secret);
    });
  }

  async deliveries(t: TenantRequestContext, id: string) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.one(tx, id);
      const r = await tx.execute<DeliveryRow>(sql`SELECT * FROM webhook_deliveries WHERE subscription_id = ${id} ORDER BY created_at DESC, id DESC LIMIT 200`);
      return { data: r.rows.map(deliveryView) };
    });
  }

  async redeliver(t: TenantRequestContext, deliveryId: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<DeliveryRow & { event: DomainEvent | null }>(sql`SELECT d.*, (SELECT to_jsonb(o) FROM (
          SELECT id, type, version, tenant_id AS "tenantId", occurred_at AS "occurredAt", actor, payload, causation_id AS "causationId",
                 correlation_id AS "correlationId", depth,
                 CASE WHEN resource_id IS NULL THEN NULL ELSE jsonb_build_object('type', resource_type, 'id', resource_id, 'segment', segment) END AS resource
          FROM outbox_events WHERE id = d.event_id) o) AS event
        FROM webhook_deliveries d WHERE d.id = ${deliveryId}`);
      const d = r.rows[0];
      if (!d?.event) throw new ProblemError('NOT_FOUND');
      await tx.execute(sql`UPDATE webhook_deliveries SET status = 'pending', error = NULL WHERE id = ${deliveryId}`);
      await this.queue.add('deliver', { tenantId: t.tenant.id, deliveryId, event: d.event } satisfies DeliveryJob, { jobId: `delivery-${deliveryId}-manual-${Date.now()}` });
      return deliveryView({ ...d, status: 'pending', error: null });
    });
  }

  // ------------------------------------------------------------------ fan-out (event consumer)
  /** Creates a delivery per matching enabled subscription and queues it (idempotent per event). */
  async process(event: DomainEvent): Promise<void> {
    const jobs: DeliveryJob[] = [];
    await this.db.withTenant({ tenantId: event.tenantId, userId: null, segments: ['b2b', 'b2c'] }, async (tx) => {
      const done = await tx.execute(sql`INSERT INTO processed_events (tenant_id, consumer, event_id) VALUES (${event.tenantId}, ${WEBHOOK_CONSUMER}, ${event.id}) ON CONFLICT DO NOTHING RETURNING 1`);
      if ((done.rowCount ?? 0) === 0) return;
      const on = await tx.execute(sql`SELECT 1 FROM tenant_modules WHERE module_id = 'api_webhooks' AND enabled`);
      if ((on.rowCount ?? 0) === 0) return;
      const subs = await tx.execute<{ id: string; event_types: string[] }>(sql`SELECT id, event_types FROM webhook_subscriptions WHERE enabled`);
      for (const s of subs.rows) {
        if (!matchesEventType(s.event_types, event.type)) continue;
        jobs.push(await this.createDelivery(tx, event, s.id));
      }
    });
    for (const j of jobs) await this.enqueue(j);
  }

  /** A delivery row for (subscription, event); used by fan-out and by the `call_webhook` rule action. */
  async createDelivery(tx: Db, event: DomainEvent, subscriptionId: string): Promise<DeliveryJob> {
    const r = await tx.execute<{ id: string }>(sql`INSERT INTO webhook_deliveries (tenant_id, subscription_id, event_id, event_type)
      VALUES (${event.tenantId}, ${subscriptionId}, ${event.id}, ${event.type})
      ON CONFLICT (tenant_id, subscription_id, event_id) DO UPDATE SET event_type = EXCLUDED.event_type RETURNING id`);
    return { tenantId: event.tenantId, deliveryId: r.rows[0]?.id ?? '', event };
  }

  async enqueue(j: DeliveryJob): Promise<void> {
    await this.queue.add('deliver', j, { jobId: `delivery-${j.deliveryId}` });
  }

  // ------------------------------------------------------------------ delivery
  startWorker(): void {
    if (this.worker) return;
    this.worker = new Worker(DELIVERY_QUEUE, async (job: Job<DeliveryJob>) => {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? DELIVERY_ATTEMPTS);
      await this.deliver(job.data, final);
    }, { connection: this.redis.duplicate(), concurrency: 16, settings: { backoffStrategy: eventBackoff } });
    this.worker.on('failed', (job: Job<DeliveryJob> | undefined, err: Error) => { this.log.warn(`delivery ${String(job?.data.deliveryId)} attempt ${String(job?.attemptsMade)}: ${err.message}`); });
  }

  /** One attempt. Non-2xx (including redirects) and network errors count as failures and are retried. */
  async deliver(j: DeliveryJob, final: boolean): Promise<'succeeded' | 'skipped'> {
    const ctx = { tenantId: j.tenantId, userId: null, segments: ['b2b', 'b2c'] as const };
    const prep = await this.db.withTenant(ctx, async (tx) => {
      const s = (await tx.execute<SubRow & { status: string }>(sql`SELECT s.*, d.status FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id WHERE d.id = ${j.deliveryId}`)).rows[0];
      if (!s || s.status === 'succeeded') return null;
      if (!s.enabled) {
        await tx.execute(sql`UPDATE webhook_deliveries SET status = 'failed', error = 'subscription disabled' WHERE id = ${j.deliveryId}`);
        return null;
      }
      const { key } = await this.provisioning.tenantKey(tx, j.tenantId);
      const secrets = [decrypt(key, s.secret_enc, `webhook:${s.id}`).toString()];
      if (s.previous_secret_enc && s.previous_valid_until && new Date(s.previous_valid_until) > new Date()) secrets.push(decrypt(key, s.previous_secret_enc, `webhook:${s.id}`).toString());
      return { sub: s, secrets };
    });
    if (!prep) return 'skipped';
    const body = JSON.stringify({ id: j.event.id, type: j.event.type, occurredAt: j.event.occurredAt, tenantId: j.event.tenantId, resource: j.event.resource, payload: j.event.payload, deliveryId: j.deliveryId });
    const started = Date.now();
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await safePost(prep.sub.url, body, {
        'content-type': 'application/json', 'user-agent': 'Flexa-Webhooks/1', 'flexa-event': j.event.type, 'flexa-delivery': j.deliveryId,
        'flexa-signature': signatureHeader(prep.secrets, body, Math.floor(Date.now() / 1000)),
      }, this.egress);
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) {
      error = e instanceof ProblemError ? `${e.code}: ${e.message}` : (e as Error).message;
    }
    const latency = Date.now() - started;
    await this.db.withTenant(ctx, async (tx) => {
      if (!error) {
        await tx.execute(sql`UPDATE webhook_deliveries SET status = 'succeeded', attempts = attempts + 1, response_status = ${status}, error = NULL, latency_ms = ${latency}, last_attempt_at = now() WHERE id = ${j.deliveryId}`);
        await tx.execute(sql`UPDATE webhook_subscriptions SET consecutive_failures = 0, first_failure_at = NULL WHERE id = ${prep.sub.id}`);
        return;
      }
      await tx.execute(sql`UPDATE webhook_deliveries SET status = ${final ? 'dead' : 'failed'}, attempts = attempts + 1, response_status = ${status}, error = ${error.slice(0, 1000)},
        latency_ms = ${latency}, last_attempt_at = now() WHERE id = ${j.deliveryId}`);
      const s = (await tx.execute<{ first_failure_at: string | null; enabled: boolean }>(sql`UPDATE webhook_subscriptions SET consecutive_failures = consecutive_failures + 1,
        first_failure_at = coalesce(first_failure_at, now()) WHERE id = ${prep.sub.id} RETURNING first_failure_at, enabled`)).rows[0];
      if (s?.enabled && s.first_failure_at && Date.now() - new Date(s.first_failure_at).getTime() >= AUTO_DISABLE_AFTER_MS) await this.autoDisable(tx, j.tenantId, prep.sub);
    });
    if (error) throw new Error(`webhook delivery failed: ${error}`);
    return 'succeeded';
  }

  /** 24 h of uninterrupted failures: the subscription is switched off and the Admins are told. */
  private async autoDisable(tx: Db, tenantId: string, sub: SubRow): Promise<void> {
    await tx.execute(sql`UPDATE webhook_subscriptions SET enabled = false, disabled_reason = 'auto_failures' WHERE id = ${sub.id}`);
    await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
      VALUES (${tenantId}, 'webhook.disabled', ${JSON.stringify({ type: 'system', id: null })}::jsonb, ${JSON.stringify({ subscriptionId: sub.id })}::jsonb, gen_random_uuid())`);
    const admins = await tx.execute<{ u: string }>(sql`SELECT ur.user_id::text AS u FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'admin'`);
    if (admins.rows.length) {
      await tx.execute(sql`SELECT app.create_notifications(${uuidArray(admins.rows.map((a) => a.u))}, 'automation', 'webhook', ${sub.id}::uuid, 'webhook', ${sub.id}::uuid,
        ${`Webhook "${sub.name}" was disabled after 24 hours of failed deliveries.`})`);
    }
    await audit(tx, tenantId, { action: 'webhook.disabled', actorType: 'system', actorId: null, targetType: 'webhook', targetId: sub.id, details: { reason: 'auto_failures' } });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
