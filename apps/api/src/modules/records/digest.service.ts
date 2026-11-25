import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql, type DbHandle } from '@flexa/db';
import { buildTenantContext } from '../../common/guards';
import { uuidArray } from '../../common/record-access';
import { DB, ENV, MAILER, REDIS, type ApiEnv, type Mailer, type Redis } from '../../infra/tokens';
import { DeliveryService, personalDelivery, quietNow } from './delivery.service';
import { NotificationsService } from './notifications.service';
import { presenceKey } from './stream.service';

const AGE = '10 minutes';
const MAX_ITEMS = 20;

/** Notification e-mail digest (ADR-0017 §3, Faz 5): unread notifications older than 10 minutes that were not
 *  mailed yet, for users who chose e-mail for that kind. Titles are re-authorized when the digest is built
 *  (a record the user lost access to is left out); each notification is mailed at most once. */
@Injectable()
export class DigestService {
  private readonly log = new Logger('digest');

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(MAILER) private readonly mailer: Mailer,
    private readonly notifications: NotificationsService,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly delivery: DeliveryService,
  ) {}

  async run(limit = 200): Promise<number> {
    const candidates = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ tenant_id: string; user_id: string }>(sql`SELECT tenant_id, user_id FROM app.digest_candidates(${AGE}::interval, ${limit})`)).rows);
    let sent = 0;
    for (const c of candidates) {
      try {
        if (await this.digestFor(c.tenant_id, c.user_id)) sent++;
      } catch (e) {
        this.log.warn(`digest for a user failed: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  private async digestFor(tenantId: string, userId: string): Promise<boolean> {
    const ctx = await buildTenantContext(this.db, { userId, sessionId: 'digest', tenantId, amr: [] });
    // Nobody is mailed while they have the app open, or in their quiet hours: the notices wait for the next run.
    if (await this.redis.exists(presenceKey(tenantId, userId))) return false;
    const personal = await this.db.withTenant({ tenantId, userId }, (tx) => personalDelivery(tx, tenantId, userId));
    if (quietNow(personal)) return false;
    const pending = await this.db.withTenant({ tenantId, userId }, async (tx) => (await tx.execute<{ id: string; kind: string }>(sql`
      SELECT n.id, n.kind FROM notifications n
      LEFT JOIN notification_preferences p ON p.user_id = n.user_id AND p.kind = n.kind
      WHERE 'email' = ANY (COALESCE(p.channels, app.default_channels(${tenantId}, n.kind))) AND n.user_id = ${userId} AND n.read_at IS NULL AND n.emailed_at IS NULL AND n.retracted_at IS NULL AND n.created_at <= now() - ${AGE}::interval
      ORDER BY n.created_at DESC`)).rows);
    if (pending.length === 0) return false;
    const ids = new Set(pending.map((p) => p.id));
    const list = await this.notifications.list(ctx, { unread: 'true', limit: '200' }, { outsideApp: true });
    const items = list.data.filter((n) => ids.has(n.id) && n.accessible);
    const userRow = await this.db.withUser(userId, async (tx) => (await tx.execute<{ email: string; locale: string }>(sql`SELECT email::text AS email, locale FROM users WHERE id = ${userId}`)).rows[0]);
    if (items.length > 0 && userRow) {
      const shown = items.slice(0, MAX_ITEMS);
      const base = this.env.WEB_BASE_URL;
      await this.mailer.send({
        template: 'notification_digest', to: userRow.email, locale: userRow.locale === 'en-US' ? 'en-US' : 'tr-TR',
        vars: {
          tenantName: ctx.tenant.name,
          items: shown.map((n) => ({ title: n.title ?? '', message: n.message, url: new URL(n.link ?? '/notifications', base).toString() })),
          more: items.length - shown.length,
          url: new URL('/notifications', base).toString(),
        },
      }, { jobId: `digest-${userId}-${[...ids].sort().at(-1) ?? ''}` });
    }
    if (items.length > 0 && userRow) await this.delivery.record(tenantId, userId, 'email', 'delivered');
    // Every pending notification counts as handled (also those without access: they will never be mailed).
    await this.db.withTenant({ tenantId, userId: null }, (tx) => tx.execute(sql`SELECT app.mark_digested(${userId}::uuid, ${uuidArray([...ids])})`));
    return items.length > 0;
  }
}
