import { Inject, Injectable, Logger } from '@nestjs/common';
import { configKey, isQuiet, mergeLayer, type JsonObject, type QuietHours } from '@flexa/config';
import { sql, type Db, type DbHandle } from '@flexa/db';
import { DB } from '../../infra/tokens';

// Measurements and personal delivery rules shared by the channels (docs/p8-plan.md §17–19, MEN-06/07).

export type DeliveryChannel = 'stream' | 'client' | 'push' | 'email';
export type DeliveryStatus = 'delivered' | 'failed' | 'gone' | 'quiet' | 'no_access';

/** SLO (MEN-06) and when the alarm speaks. */
const P95_MS = 2_000;
const MIN_SAMPLES = 20;
const FAILURE_SHARE = 0.2;
const MIN_FAILURES = 5;
const KEEP_DAYS = 30;

export interface PersonalDelivery { language: 'tr' | 'en'; timezone: string; quiet: QuietHours }

/** Time zone, language and quiet hours of the transaction's user (tenant layer under the user's own). */
export async function personalDelivery(tx: Db, tenantId: string, userId: string): Promise<PersonalDelivery> {
  const r = await tx.execute<{ key: string; scope_type: 'tenant' | 'user'; value: JsonObject }>(sql`
    SELECT h.key, h.scope_type, s.value FROM tenant_settings_head h JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.key IN ('locale', 'notifications.quiet')
      AND ((h.scope_type = 'tenant' AND h.scope_id = ${tenantId}) OR (h.scope_type = 'user' AND h.scope_id = ${userId}))`);
  const read = (key: string): JsonObject => {
    const def = configKey(key);
    if (!def) throw new Error(`${key} config key is not registered`);
    return (['tenant', 'user'] as const).reduce((v, scope) => mergeLayer(v, r.rows.find((x) => x.key === key && x.scope_type === scope)?.value ?? {}), def.default);
  };
  const locale = read('locale');
  return {
    language: locale.language === 'en' ? 'en' : 'tr',
    timezone: typeof locale.timezone === 'string' ? locale.timezone : 'Europe/Istanbul',
    quiet: read('notifications.quiet') as unknown as QuietHours,
  };
}

export const quietNow = (p: PersonalDelivery, now = new Date()): boolean => isQuiet(p.quiet, p.timezone, now);

@Injectable()
export class DeliveryService {
  private readonly log = new Logger('delivery');

  constructor(@Inject(DB) private readonly db: DbHandle) {}

  /** Best effort: a measurement never fails the delivery it measures. */
  async record(tenantId: string, userId: string, channel: DeliveryChannel, status: DeliveryStatus, since: Date | null = null): Promise<void> {
    const latency = since ? Math.max(0, Date.now() - since.getTime()) : null;
    await this.db.withTenant({ tenantId, userId }, (tx) => tx.execute(sql`
      INSERT INTO notification_deliveries (tenant_id, user_id, channel, status, latency_ms) VALUES (${tenantId}, ${userId}, ${channel}, ${status}, ${latency})`))
      .catch((e: unknown) => { this.log.warn(`delivery not recorded: ${(e as Error).message}`); });
  }

  async stats(minutes: number) {
    return this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ channel: string; delivered: string; failed: string; p50: number | null; p95: number | null }>(sql`SELECT * FROM app.delivery_stats(${minutes})`)).rows.map((r) => ({
        channel: r.channel, delivered: Number(r.delivered), failed: Number(r.failed), p50Ms: r.p50 === null ? null : Math.round(r.p50), p95Ms: r.p95 === null ? null : Math.round(r.p95),
      })));
  }

  /** Every five minutes: an error log line is the alarm (the log pipeline pages on `ALERT`). Returns what it raised. */
  async watch(): Promise<string[]> {
    const alerts: string[] = [];
    for (const s of await this.stats(5)) {
      if ((s.channel === 'stream' || s.channel === 'client') && s.delivered >= MIN_SAMPLES && (s.p95Ms ?? 0) > P95_MS) alerts.push(`ALERT notification_latency channel=${s.channel} p95=${String(s.p95Ms)}ms samples=${String(s.delivered)}`);
      if (s.failed >= MIN_FAILURES && s.failed > (s.failed + s.delivered) * FAILURE_SHARE) alerts.push(`ALERT notification_failures channel=${s.channel} failed=${String(s.failed)} delivered=${String(s.delivered)}`);
    }
    for (const a of alerts) this.log.error(a);
    await this.db.withAnonymous((tx) => tx.execute(sql`SELECT app.prune_deliveries(${KEEP_DAYS})`));
    return alerts;
  }
}
