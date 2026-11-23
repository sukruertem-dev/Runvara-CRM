import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DbHandle } from '@flexa/db';
import { effectiveLimits, getPlan, isPlanId, QUOTA_DIMENSIONS, quotaLevel } from '@flexa/modules';
import { authorize } from '../../common/authorize';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, REDIS, type Redis } from '../../infra/tokens';
import { GAUGES, measureAll } from './measure';
import { QuotaService } from './quota.service';
import { today, USAGE_PENDING, usageKey } from './rate-limit';

const COUNTER_FIELDS = new Set(['api_requests', 'call_minutes', 'ai_tokens']);
const HISTORY_DAYS = 30;

/** Usage metering (TEN-09): Redis counters → `tenant_usage_counters`, daily gauge snapshots, and the
 *  usage summary of the settings screen. */
@Injectable()
export class UsageService {
  private readonly log = new Logger('usage');

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly quota: QuotaService,
  ) {}

  /** Adds to a counter dimension (call minutes, AI tokens) for today; flushed within a minute. */
  async count(tenantId: string, field: 'call_minutes' | 'ai_tokens', amount: number): Promise<void> {
    const day = today();
    await this.redis.multi().hincrby(usageKey(tenantId, day), field, amount).expire(usageKey(tenantId, day), 259_200).sadd(USAGE_PENDING, `${tenantId}|${day}`).exec();
  }

  /** Moves the Redis counters into the daily table. Each key is read and removed atomically; when the
   *  database write fails the values are put back so they are counted on the next run. */
  async flushCounters(): Promise<number> {
    const members = await this.redis.smembers(USAGE_PENDING);
    let flushed = 0;
    for (const m of members) {
      const [tenantId, day] = m.split('|');
      if (!tenantId || !day) continue;
      const key = usageKey(tenantId, day);
      const res = await this.redis.multi().hgetall(key).del(key).srem(USAGE_PENDING, m).exec();
      const values = (res?.[0]?.[1] ?? {}) as Record<string, string>;
      const entries = Object.entries(values).filter(([f, v]) => COUNTER_FIELDS.has(f) && Number(v) > 0);
      if (entries.length === 0) continue;
      try {
        await this.db.withTenant({ tenantId, userId: null }, async (tx) => {
          for (const [dimension, v] of entries) {
            await tx.execute(sql`INSERT INTO tenant_usage_counters (tenant_id, day, dimension, value) VALUES (${tenantId}, ${day}::date, ${dimension}, ${Number(v)})
              ON CONFLICT (tenant_id, day, dimension) DO UPDATE SET value = tenant_usage_counters.value + EXCLUDED.value, updated_at = now()`);
          }
        });
        flushed += 1;
      } catch (e) {
        const back = this.redis.multi();
        for (const [f, v] of entries) back.hincrby(key, f, Number(v));
        await back.expire(key, 259_200).sadd(USAGE_PENDING, m).exec();
        this.log.warn(`usage flush for ${tenantId} failed, kept in Redis: ${(e as Error).message}`);
      }
    }
    return flushed;
  }

  /** Hourly: today's gauge values for every live tenant, and the quota thresholds they cross. */
  async snapshotAll(): Promise<number> {
    const ids = await this.db.withAnonymous(async (tx) => (await tx.execute<{ id: string }>(sql`SELECT app.live_tenant_ids() AS id`)).rows.map((r) => r.id));
    for (const tenantId of ids) {
      await this.snapshot(tenantId).catch((e: unknown) => { this.log.warn(`usage snapshot for ${tenantId} failed: ${(e as Error).message}`); });
    }
    return ids.length;
  }

  async snapshot(tenantId: string): Promise<void> {
    await this.db.withTenant({ tenantId, userId: null }, async (tx) => {
      const plan = (await tx.execute<{ plan_id: string; limit_overrides: Record<string, unknown> }>(sql`SELECT plan_id, limit_overrides FROM tenant_plans`)).rows[0];
      if (!plan || !isPlanId(plan.plan_id)) return;
      const limits = effectiveLimits(plan.plan_id, plan.limit_overrides);
      const usage = await measureAll(tx, this.redis, tenantId);
      for (const g of GAUGES) {
        await tx.execute(sql`INSERT INTO tenant_usage_counters (tenant_id, day, dimension, value) VALUES (${tenantId}, current_date, ${g}, ${usage[g]})
          ON CONFLICT (tenant_id, day, dimension) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
      }
      for (const d of QUOTA_DIMENSIONS) await this.quota.thresholds(tx, tenantId, d, usage[d], limits[d], null);
    });
  }

  /** Plan, usage per dimension and 30 days of API requests (`tenant.config.read`). */
  async summary(t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const usage = await measureAll(tx, this.redis, t.tenant.id);
      const days = await tx.execute<{ day: string; value: string }>(sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, value FROM tenant_usage_counters
        WHERE dimension = 'api_requests' AND day > current_date - ${HISTORY_DAYS}::int ORDER BY day`);
      const byDay = new Map(days.rows.map((r) => [r.day, Number(r.value)]));
      const pendingToday = Number((await this.redis.hget(usageKey(t.tenant.id, today()), 'api_requests')) ?? 0);
      const apiRequests = Array.from({ length: HISTORY_DAYS }, (_, i) => {
        const d = new Date(Date.now() - (HISTORY_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10);
        return { day: d, count: (byDay.get(d) ?? 0) + (d === today() ? pendingToday : 0) };
      });
      const plan = getPlan(t.plan.id);
      return {
        plan: { id: plan.id, displayNameKey: plan.displayNameKey, tier: plan.tier, addOns: [...t.plan.addOns], trialEndsAt: t.plan.trialEndsAt?.toISOString() ?? null },
        dimensions: QUOTA_DIMENSIONS.map((d) => ({ dimension: d, used: usage[d], limit: t.plan.limits[d], level: quotaLevel(usage[d], t.plan.limits[d]) })),
        rates: { apiRpm: t.plan.limits.api_rpm, apiRpmPerUser: t.plan.limits.api_rpm_per_user },
        apiRequests,
      };
    });
  }
}
