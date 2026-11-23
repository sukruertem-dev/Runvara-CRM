import { Inject, Injectable } from '@nestjs/common';
import type { DomainEvent } from '@flexa/contracts';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { QUOTA_THRESHOLDS, quotaAllows, quotaLevel, type QuotaDimension, type QuotaLevel } from '@flexa/modules';
import { audit } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import type { TenantRequestContext } from '../../common/request-context';
import { DB, ENV, MAILER, REDIS, type ApiEnv, type Mailer, type Redis } from '../../infra/tokens';
import { measure } from './measure';

// Quota enforcement (TEN-09, ADR-0014 §3). 80 % warns, 100 % refuses new invitations and uploads (`soft`
// checks), 120 % refuses record creation (`hard` checks). Reads and exports are never checked. Each level is
// announced once per dimension and month: audit, a `quota.threshold` event and an e-mail to the Admins.

const QUOTA_CONSUMER = 'quota_mail';
const LEVELS: readonly Exclude<QuotaLevel, 'ok'>[] = ['warning', 'soft', 'hard'];
/** Record creation is frequent: while a cached count stays below the warning level it is trusted; from
 *  there on every creation counts exactly, so no threshold is missed. */
const RECORDS_CACHE_SECONDS = 60;

const fmt = (dimension: QuotaDimension, v: number): string =>
  dimension === 'storage_bytes' ? `${(v / 1_073_741_824).toFixed(2)} GB` : new Intl.NumberFormat('tr-TR').format(v);

@Injectable()
export class QuotaService {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  /** Refuses with 402 QUOTA_EXCEEDED unless `increment` more of `dimension` stays within what a write of
   *  this kind tolerates. Runs inside the write's transaction; crossing a threshold is recorded there too. */
  async assert(tx: Db, t: TenantRequestContext, dimension: QuotaDimension, increment: number, check: 'soft' | 'hard'): Promise<void> {
    const limit = t.plan.limits[dimension];
    const cacheKey = `quota:${t.tenant.id}:records`;
    if (dimension === 'records') {
      const cached = await this.redis.get(cacheKey);
      if (cached !== null && Number(cached) + increment < Math.floor(limit * QUOTA_THRESHOLDS.warning)) {
        await this.redis.incrby(cacheKey, increment);
        return;
      }
    }
    const used = await measure(tx, this.redis, t.tenant.id, dimension);
    if (dimension === 'records') await this.redis.set(cacheKey, String(used + increment), 'EX', RECORDS_CACHE_SECONDS);
    if (!quotaAllows(used, limit, increment, check)) {
      throw new ProblemError('QUOTA_EXCEEDED', `${dimension} quota exceeded`, { dimension, used, limit });
    }
    await this.thresholds(tx, t.tenant.id, dimension, used + increment, limit, t.principal.userId);
  }

  /** Records newly crossed levels for this month. Only the highest new level is announced (one e-mail even
   *  when a measurement jumps from below 80 % straight past 120 %). */
  async thresholds(tx: Db, tenantId: string, dimension: QuotaDimension, used: number, limit: number, actorId: string | null): Promise<void> {
    const level = quotaLevel(used, limit);
    if (level === 'ok') return;
    const period = new Date().toISOString().slice(0, 7);
    const reached = LEVELS.slice(0, LEVELS.indexOf(level) + 1);
    let announce: Exclude<QuotaLevel, 'ok'> | null = null;
    for (const lv of reached) {
      const r = await tx.execute(sql`INSERT INTO tenant_quota_alerts (tenant_id, dimension, level, period, used, quota_limit)
        VALUES (${tenantId}, ${dimension}, ${lv}, ${period}, ${used}, ${limit}) ON CONFLICT DO NOTHING RETURNING 1`);
      if ((r.rowCount ?? 0) > 0) announce = lv;
    }
    if (!announce) return;
    const details = { dimension, level: announce, used, limit, period };
    await audit(tx, tenantId, { action: 'quota.threshold', actorType: actorId ? 'user' : 'system', actorId, targetType: 'quota', details });
    await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, actor, payload, correlation_id)
      VALUES (${tenantId}, 'quota.threshold', ${JSON.stringify({ type: 'system', id: null })}::jsonb, ${JSON.stringify(details)}::jsonb, gen_random_uuid())`);
  }

  /** Event consumer: e-mails the tenant's Admins about a crossed threshold (once per event). */
  async process(event: DomainEvent): Promise<void> {
    if (event.type !== 'quota.threshold') return;
    const p = event.payload as { dimension?: QuotaDimension; level?: Exclude<QuotaLevel, 'ok'>; used?: number; limit?: number };
    const { dimension, level } = p;
    if (!dimension || !level || typeof p.used !== 'number' || typeof p.limit !== 'number') return;
    const { used, limit } = p;
    const target = await this.db.withTenant({ tenantId: event.tenantId, userId: null }, async (tx) => {
      const done = await tx.execute(sql`INSERT INTO processed_events (tenant_id, consumer, event_id) VALUES (${event.tenantId}, ${QUOTA_CONSUMER}, ${event.id}) ON CONFLICT DO NOTHING RETURNING 1`);
      if ((done.rowCount ?? 0) === 0) return null;
      const admins = await tx.execute<{ user_id: string }>(sql`SELECT DISTINCT ur.user_id FROM user_roles ur
        JOIN roles r ON r.id = ur.role_id AND r.key = 'admin'
        JOIN memberships m ON m.user_id = ur.user_id AND m.status = 'active'
        WHERE ur.valid_until IS NULL OR ur.valid_until > now()`);
      const name = (await tx.execute<{ name: string }>(sql`SELECT name FROM tenants`)).rows[0]?.name ?? '';
      return { admins: admins.rows.map((a) => a.user_id), name };
    });
    if (!target) return;
    const url = new URL('/settings/usage', this.env.WEB_BASE_URL).toString();
    for (const userId of target.admins) {
      const u = await this.db.withUser(userId, async (tx) => (await tx.execute<{ email: string; locale: string }>(sql`SELECT email::text AS email, locale FROM users WHERE id = ${userId} AND status = 'active'`)).rows[0]);
      if (!u) continue;
      await this.mailer.send({
        template: 'quota_warning', to: u.email, locale: u.locale === 'en-US' ? 'en-US' : 'tr-TR',
        vars: { tenantName: target.name, dimension, level, used: fmt(dimension, used), limit: fmt(dimension, limit), url },
      }, { jobId: `quota:${event.id}:${userId}` });
    }
  }
}
