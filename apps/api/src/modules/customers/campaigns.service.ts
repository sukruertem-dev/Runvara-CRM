import { Inject, Injectable } from '@nestjs/common';
import { can } from '@flexa/authz';
import type { CampaignCreate, CampaignPatch, CouponCreate, z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { notify } from '../../common/notify';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { recordPredicate } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, MAILER, type Mailer } from '../../infra/tokens';
import { CRM } from '../crm/crm-objects';
import { contactMask } from './customer-mask';
import { reachability } from './customers.service';

// P9f (docs/p9-plan.md §39–42): B2C campaigns — dates, a discount with a conflict rule, target customers by tag and
// RFM segment, a message — and their coupons. A Manager's campaign waits for an Admin (A26 `requires_approval`).
// The message goes only to targeted customers with e-mail consent; the others are recorded with the reason.

type CampaignRow = {
  id: string; name: string; status: 'draft' | 'pending_approval' | 'active' | 'ended' | 'cancelled'; starts_on: string; ends_on: string; discount_percent: string;
  exclusive: boolean; audience_tags: string[]; audience_rfm: string[]; message_subject: string | null; message_body: string | null; sent_at: string | null;
  approved_by: string | null; approver_name: string | null; created_by: string; creator_name: string; version: number; ended: boolean;
};
type CouponRow = { id: string; code: string; discount_percent: string; max_uses: number | null; per_customer_limit: number; uses: number; active: boolean };
export type CouponReason = 'unknown' | 'inactive' | 'not_started' | 'expired' | 'used_up' | 'customer_limit' | 'not_in_audience';
type Audience = { tags: string[]; rfm: string[] };

const iso = (v: string | Date): string => new Date(v).toISOString();
const pct = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

/** Customers a campaign targets (alias `t`): B2C, still identifiable, with any of the tags and any of the segments. */
function audienceSql(a: Audience): SQL {
  const terms: SQL[] = [sql`'b2c' = ANY (t.segments)`, sql`t.deleted_at IS NULL`, sql`t.merged_into IS NULL`, sql`t.anonymized_at IS NULL`];
  if (a.tags.length) terms.push(sql`EXISTS (SELECT 1 FROM customer_profiles cp WHERE cp.contact_id = t.id AND cp.tags && ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(a.tags)}::jsonb)))`);
  if (a.rfm.length) terms.push(sql`EXISTS (SELECT 1 FROM customer_profiles cp WHERE cp.contact_id = t.id AND cp.rfm_segment = ANY(ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(a.rfm)}::jsonb))))`);
  return sql.join(terms, sql` AND `);
}

async function inAudience(tx: Db, customerId: string, a: Audience): Promise<boolean> {
  return ((await tx.execute(sql`SELECT 1 FROM contacts t WHERE t.id = ${customerId} AND ${audienceSql(a)}`)).rowCount ?? 0) > 0;
}

/** Today in the tenant's time zone. */
async function today(tx: Db, timezone: string): Promise<string> {
  return (await tx.execute<{ d: string }>(sql`SELECT (now() AT TIME ZONE ${timezone})::date::text AS d`)).rows[0]?.d ?? '';
}

/** The discount an order of the customer gets now: the best matching active campaign, and the coupon if given.
 *  Conflict rule: two discounts add up unless one of them is exclusive; then the larger one alone applies. */
export async function discountFor(tx: Db, t: TenantRequestContext, customerId: string, couponCode: string | undefined): Promise<{
  percent: string; campaignId: string | null; couponId: string | null;
}> {
  const d = await today(tx, t.tenant.timezone);
  const campaigns = (await tx.execute<{ id: string; discount_percent: string; exclusive: boolean; audience_tags: string[]; audience_rfm: string[] }>(sql`
    SELECT id, discount_percent::text AS discount_percent, exclusive, audience_tags, audience_rfm FROM campaigns
    WHERE status = 'active' AND starts_on <= ${d}::date AND ends_on >= ${d}::date AND discount_percent > 0 ORDER BY discount_percent DESC, id`)).rows;
  let auto: { id: string; percent: number; exclusive: boolean } | null = null;
  for (const c of campaigns) {
    if (await inAudience(tx, customerId, { tags: c.audience_tags, rfm: c.audience_rfm })) {
      auto = { id: c.id, percent: Number(c.discount_percent), exclusive: c.exclusive };
      break;
    }
  }
  let coupon: { id: string; campaignId: string; percent: number; exclusive: boolean } | null = null;
  if (couponCode) {
    const r = await checkCoupon(tx, t, couponCode, customerId, true);
    if (!r.valid || !r.coupon) throw new ProblemError('COUPON_INVALID', r.reason ?? 'unknown', { reason: r.reason });
    coupon = { id: r.coupon.id, campaignId: r.coupon.campaignId, percent: Number(r.coupon.percent), exclusive: r.coupon.exclusive };
  }
  // The coupon's own campaign does not also count as an automatic discount.
  if (auto && coupon && auto.id === coupon.campaignId) auto = null;
  const parts = [auto, coupon].filter((x): x is NonNullable<typeof x> => x !== null);
  if (parts.length === 0) return { percent: '0', campaignId: null, couponId: null };
  const best = parts.reduce((a, b) => (b.percent > a.percent ? b : a));
  const percent = parts.some((p) => p.exclusive) ? best.percent : Math.min(100, parts.reduce((s, p) => s + p.percent, 0));
  const used = parts.some((p) => p.exclusive) ? [best] : parts;
  return {
    percent: String(Math.round(percent * 1000) / 1000),
    campaignId: coupon && used.includes(coupon) ? coupon.campaignId : (auto?.id ?? null),
    couponId: coupon && used.includes(coupon) ? coupon.id : null,
  };
}

/** Would the coupon apply to the customer now? `lock` holds the coupon row for the order that redeems it. */
export async function checkCoupon(tx: Db, t: TenantRequestContext, code: string, customerId: string, lock = false): Promise<{
  valid: boolean; reason: CouponReason | null; coupon: { id: string; campaignId: string; percent: string; exclusive: boolean; campaignName: string } | null;
}> {
  const [c] = (await tx.execute<{ id: string; campaign_id: string; discount_percent: string; max_uses: number | null; per_customer_limit: number; uses: number; active: boolean;
    status: string; starts_on: string; ends_on: string; exclusive: boolean; name: string; audience_tags: string[]; audience_rfm: string[] }>(sql`
    SELECT k.id, k.campaign_id, k.discount_percent::text AS discount_percent, k.max_uses, k.per_customer_limit, k.uses, k.active,
      c.status, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, c.exclusive, c.name, c.audience_tags, c.audience_rfm
    FROM coupons k JOIN campaigns c ON c.id = k.campaign_id WHERE k.code = ${code.trim().toUpperCase()} ${lock ? sql`FOR UPDATE OF k` : sql``}`)).rows;
  if (!c) return { valid: false, reason: 'unknown', coupon: null };
  const coupon = { id: c.id, campaignId: c.campaign_id, percent: pct(c.discount_percent), exclusive: c.exclusive, campaignName: c.name };
  const d = await today(tx, t.tenant.timezone);
  const fail = (reason: CouponReason) => ({ valid: false, reason, coupon });
  if (!c.active || c.status !== 'active') return fail('inactive');
  if (d < c.starts_on) return fail('not_started');
  if (d > c.ends_on) return fail('expired');
  if (c.max_uses !== null && c.uses >= c.max_uses) return fail('used_up');
  const mine = (await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM coupon_redemptions WHERE coupon_id = ${c.id} AND customer_id = ${customerId}`)).rows[0]?.n ?? 0;
  if (mine >= c.per_customer_limit) return fail('customer_limit');
  if (!(await inAudience(tx, customerId, { tags: c.audience_tags, rfm: c.audience_rfm }))) return fail('not_in_audience');
  return { valid: true, reason: null, coupon };
}

/** Counts one use of the coupon by the order (inside the order's transaction; the coupon row is already locked). */
export async function redeemCoupon(tx: Db, t: TenantRequestContext, couponId: string, orderId: string, customerId: string): Promise<void> {
  const r = await tx.execute(sql`UPDATE coupons SET uses = uses + 1 WHERE id = ${couponId} AND (max_uses IS NULL OR uses < max_uses)`);
  if ((r.rowCount ?? 0) === 0) throw new ProblemError('COUPON_INVALID', 'used_up', { reason: 'used_up' });
  await tx.execute(sql`INSERT INTO coupon_redemptions (tenant_id, coupon_id, order_id, customer_id) VALUES (${t.tenant.id}, ${couponId}, ${orderId}, ${customerId})`);
}

@Injectable()
export class CampaignsService {
  constructor(@Inject(DB) private readonly db: DbHandle, @Inject(MAILER) private readonly mailer: Mailer) {}

  private b2c(t: TenantRequestContext): void {
    if (!t.segments.includes('b2c')) throw new ProblemError('NOT_FOUND');
  }

  /** A26: full grant writes; a grant with `requires_approval` (Manager) needs an Admin to start the campaign. */
  private writeGrant(t: TenantRequestContext, permission: 'sales_b2c.campaign.manage' | 'sales_b2c.coupon.manage') {
    const d = can(t.authz, permission, 'full');
    return d.allow ? { approvalNeeded: (d.grant.constraints ?? []).includes('requires_approval') } : null;
  }

  private async rows(tx: Db, where: SQL): Promise<CampaignRow[]> {
    const d = sql`(now() AT TIME ZONE (SELECT timezone FROM tenants))::date`;
    return (await tx.execute<CampaignRow>(sql`
      SELECT c.id, c.name, c.status, c.starts_on::text AS starts_on, c.ends_on::text AS ends_on, c.discount_percent::text AS discount_percent, c.exclusive,
        c.audience_tags, c.audience_rfm, c.message_subject, c.message_body, c.sent_at, c.approved_by, a.display_name AS approver_name, c.created_by,
        u.display_name AS creator_name, c.version, c.ends_on < ${d} AS ended
      FROM campaigns c JOIN users u ON u.id = c.created_by LEFT JOIN users a ON a.id = c.approved_by WHERE ${where} ORDER BY c.starts_on DESC, c.id DESC LIMIT 200`)).rows;
  }

  private async view(tx: Db, t: TenantRequestContext, c: CampaignRow, withCoupons: boolean) {
    const status = c.status === 'active' && c.ended ? 'ended' : c.status;
    const deliveries = (await tx.execute<{ outcome: string; reason: string | null; n: number }>(sql`
      SELECT outcome, reason, count(*)::int AS n FROM campaign_deliveries WHERE campaign_id = ${c.id} GROUP BY outcome, reason`)).rows;
    const coupons = withCoupons ? (await tx.execute<CouponRow>(sql`
      SELECT id, code, discount_percent::text AS discount_percent, max_uses, per_customer_limit, uses, active FROM coupons WHERE campaign_id = ${c.id} ORDER BY created_at, id`)).rows : [];
    const w = this.writeGrant(t, 'sales_b2c.campaign.manage');
    const admin = w !== null && !w.approvalNeeded;
    return {
      id: c.id, name: c.name, status, startsOn: c.starts_on, endsOn: c.ends_on, discountPercent: pct(c.discount_percent), exclusive: c.exclusive,
      audienceTags: c.audience_tags, audienceRfm: c.audience_rfm as ('champions' | 'loyal' | 'new' | 'at_risk' | 'hibernating' | 'regular')[],
      message: c.message_subject && c.message_body ? { subject: c.message_subject, body: c.message_body } : null,
      sentAt: c.sent_at ? iso(c.sent_at) : null, createdBy: { id: c.created_by, displayName: c.creator_name },
      approvedBy: c.approved_by ? { id: c.approved_by, displayName: c.approver_name ?? '' } : null,
      coupons: coupons.map((k) => ({ id: k.id, code: k.code, discountPercent: pct(k.discount_percent), maxUses: k.max_uses, perCustomerLimit: k.per_customer_limit, uses: k.uses, active: k.active })),
      deliveries: {
        sent: deliveries.filter((x) => x.outcome === 'sent').reduce((s, x) => s + x.n, 0),
        blocked: Object.fromEntries(deliveries.filter((x) => x.outcome === 'blocked').map((x) => [x.reason ?? 'unknown', x.n])),
      },
      canEdit: w !== null && status === 'draft',
      canSubmit: w !== null && status === 'draft',
      canApprove: admin && status === 'pending_approval',
      canSend: w !== null && status === 'active' && !c.sent_at && c.message_subject !== null,
      version: c.version,
    };
  }

  private async one(tx: Db, id: string): Promise<CampaignRow> {
    const [c] = await this.rows(tx, sql`c.id = ${id}`);
    if (!c) throw new ProblemError('NOT_FOUND');
    return c;
  }

  async list(t: TenantRequestContext, status: string | undefined) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const rows = await this.rows(tx, sql`TRUE`);
      const views = await Promise.all(rows.map((c) => this.view(tx, t, c, false)));
      return { data: views.filter((v) => !status || v.status === status).map(({ coupons: _c, ...v }) => v) };
    });
  }

  async get(t: TenantRequestContext, id: string) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => this.view(tx, t, await this.one(tx, id), true));
  }

  async create(t: TenantRequestContext, body: z.infer<typeof CampaignCreate>) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [r] = (await tx.execute<{ id: string }>(sql`
        INSERT INTO campaigns (tenant_id, name, starts_on, ends_on, discount_percent, exclusive, audience_tags, audience_rfm, message_subject, message_body, created_by)
        VALUES (${t.tenant.id}, ${body.name}, ${body.startsOn}::date, ${body.endsOn}::date, ${body.discountPercent}::numeric, ${body.exclusive},
          ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(body.audienceTags)}::jsonb)), ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(body.audienceRfm)}::jsonb)),
          ${body.message?.subject ?? null}, ${body.message?.body ?? null}, ${t.principal.userId}) RETURNING id`)).rows;
      if (!r) throw new Error('campaign not written');
      await audit(tx, t.tenant.id, { action: 'campaign.created', actorType: 'user', actorId: t.principal.userId, targetType: 'campaign', targetId: r.id });
      return this.view(tx, t, await this.one(tx, r.id), true);
    });
  }

  async patch(t: TenantRequestContext, id: string, ifMatch: number, body: z.infer<typeof CampaignPatch>) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      // Locked first: the version and the draft state hold until this update commits.
      await tx.execute(sql`SELECT 1 FROM campaigns WHERE id = ${id} FOR UPDATE`);
      const c = await this.one(tx, id);
      if (c.version !== ifMatch) throw new ProblemError('PRECONDITION_FAILED');
      if (c.status !== 'draft') throw new ProblemError('CAMPAIGN_STATE', 'only a draft is changed', { campaignStatus: c.status });
      const startsOn = body.startsOn ?? c.starts_on;
      const endsOn = body.endsOn ?? c.ends_on;
      if (startsOn > endsOn) throw new ProblemError('VALIDATION_FAILED', 'endsOn before startsOn');
      const message = body.message === undefined ? (c.message_subject && c.message_body ? { subject: c.message_subject, body: c.message_body } : null) : body.message;
      await tx.execute(sql`UPDATE campaigns SET name = ${body.name ?? c.name}, starts_on = ${startsOn}::date, ends_on = ${endsOn}::date,
        discount_percent = ${body.discountPercent ?? c.discount_percent}::numeric, exclusive = ${body.exclusive ?? c.exclusive},
        audience_tags = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(body.audienceTags ?? c.audience_tags)}::jsonb)),
        audience_rfm = ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(body.audienceRfm ?? c.audience_rfm)}::jsonb)),
        message_subject = ${message?.subject ?? null}, message_body = ${message?.body ?? null}, version = version + 1 WHERE id = ${id}`);
      return this.view(tx, t, await this.one(tx, id), true);
    });
  }

  private async move(t: TenantRequestContext, id: string, from: readonly string[], to: string, extra: SQL = sql``): Promise<void> {
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM campaigns WHERE id = ${id} FOR UPDATE`);
      const c = await this.one(tx, id);
      if (!from.includes(c.status) || (c.status === 'active' && c.ended && to !== 'ended')) throw new ProblemError('CAMPAIGN_STATE', undefined, { campaignStatus: c.ended && c.status === 'active' ? 'ended' : c.status });
      await tx.execute(sql`UPDATE campaigns SET status = ${to}, version = version + 1 ${extra} WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: `campaign.${to}`, actorType: 'user', actorId: t.principal.userId, targetType: 'campaign', targetId: id });
    });
  }

  async submit(t: TenantRequestContext, id: string) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage');
    const w = this.writeGrant(t, 'sales_b2c.campaign.manage');
    const to = w?.approvalNeeded ? 'pending_approval' : 'active';
    await this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM campaigns WHERE id = ${id} FOR UPDATE`);
      const c = await this.one(tx, id);
      if (c.status !== 'draft') throw new ProblemError('CAMPAIGN_STATE', undefined, { campaignStatus: c.status });
      await tx.execute(sql`UPDATE campaigns SET status = ${to}, version = version + 1 ${to === 'active' ? sql`, approved_by = ${t.principal.userId}` : sql``} WHERE id = ${id}`);
      await audit(tx, t.tenant.id, { action: `campaign.${to === 'active' ? 'started' : 'submitted'}`, actorType: 'user', actorId: t.principal.userId, targetType: 'campaign', targetId: id });
      if (to === 'pending_approval') {
        const admins = await tx.execute<{ u: string }>(sql`SELECT ur.user_id::text AS u FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN memberships m ON m.user_id = ur.user_id AND m.status = 'active' WHERE r.key = 'admin'`);
        await notify(tx, t, { users: admins.rows.map((a) => a.u), kind: 'approval', sourceType: 'campaign', sourceId: id, recordType: 'campaign', recordId: id, message: c.name.slice(0, 400) });
      }
    });
    return this.get(t, id);
  }

  private assertAdmin(t: TenantRequestContext): void {
    const w = this.writeGrant(t, 'sales_b2c.campaign.manage');
    if (!w || w.approvalNeeded) throw new ProblemError('FORBIDDEN');
  }

  async approve(t: TenantRequestContext, id: string) {
    this.b2c(t);
    this.assertAdmin(t);
    await this.move(t, id, ['pending_approval'], 'active', sql`, approved_by = ${t.principal.userId}`);
    return this.get(t, id);
  }

  async reject(t: TenantRequestContext, id: string) {
    this.b2c(t);
    this.assertAdmin(t);
    await this.move(t, id, ['pending_approval'], 'draft');
    return this.get(t, id);
  }

  async cancel(t: TenantRequestContext, id: string) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage');
    await this.move(t, id, ['draft', 'pending_approval', 'active'], 'cancelled');
    return this.get(t, id);
  }

  // ------------------------------------------------------------------ audience and message
  private async audienceRows(tx: Db, t: TenantRequestContext, c: CampaignRow) {
    return (await tx.execute<{ id: string; full_name: string }>(sql`
      SELECT t.id, t.full_name FROM ${CRM.contact.from} WHERE ${audienceSql({ tags: c.audience_tags, rfm: c.audience_rfm })}
        AND ${await recordPredicate(tx, t, CRM.contact.shape, 'read')} ORDER BY t.id LIMIT 100000`)).rows;
  }

  async audience(t: TenantRequestContext, id: string) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage', 'read');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const c = await this.one(tx, id);
      const people = await this.audienceRows(tx, t, c);
      const blocked: Record<string, number> = {};
      const sample: { id: string; fullName: string; allowed: boolean; reason: string | null }[] = [];
      let reachable = 0;
      const mask = contactMask(t);
      for (const p of people) {
        const r = await reachability(tx, t.tenant.id, p.id, 'email');
        if (r.allowed) reachable += 1;
        else blocked[r.reason ?? 'no_consent'] = (blocked[r.reason ?? 'no_consent'] ?? 0) + 1;
        if (sample.length < 50) sample.push({ id: p.id, fullName: mask.name ? p.full_name : '', allowed: r.allowed, reason: r.reason });
      }
      return { total: people.length, reachable, blocked, sample };
    });
  }

  /** Once per campaign: every targeted customer gets a delivery record — sent with consent, blocked (with the reason)
   *  without. The mails are queued after the transaction. */
  async send(t: TenantRequestContext, id: string) {
    this.b2c(t);
    authorize(t, 'sales_b2c.campaign.manage');
    const { mails, result } = await this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM campaigns WHERE id = ${id} FOR UPDATE`);
      const c = await this.one(tx, id);
      if (c.status !== 'active' || c.ended || c.sent_at || !c.message_subject || !c.message_body) throw new ProblemError('CAMPAIGN_STATE', 'an active campaign with a message, sent once', { campaignStatus: c.status });
      const out: { to: string; jobId: string; customerId: string }[] = [];
      const blocked: Record<string, number> = {};
      for (const p of await this.audienceRows(tx, t, c)) {
        const r = await reachability(tx, t.tenant.id, p.id, 'email');
        if (r.allowed && r.address) out.push({ to: r.address, jobId: `campaign-${id}-${p.id}`, customerId: p.id });
        else blocked[r.reason ?? 'no_consent'] = (blocked[r.reason ?? 'no_consent'] ?? 0) + 1;
        await tx.execute(sql`INSERT INTO campaign_deliveries (tenant_id, campaign_id, customer_id, outcome, reason) VALUES (${t.tenant.id}, ${id}, ${p.id},
          ${r.allowed ? 'sent' : 'blocked'}, ${r.allowed ? null : (r.reason ?? 'no_consent')})`);
      }
      await tx.execute(sql`UPDATE campaigns SET sent_at = now(), version = version + 1 WHERE id = ${id}`);
      await tx.execute(sql`INSERT INTO outbox_events (tenant_id, type, segment, actor, payload, correlation_id)
        VALUES (${t.tenant.id}, 'campaign.started', 'b2c', ${JSON.stringify({ type: 'user', id: t.principal.userId })}::jsonb,
          ${JSON.stringify({ campaignId: id, sent: out.length })}::jsonb, gen_random_uuid())`);
      await audit(tx, t.tenant.id, { action: 'campaign.sent', actorType: 'user', actorId: t.principal.userId, targetType: 'campaign', targetId: id, details: { sent: out.length, blocked } });
      return { mails: out.map((m) => ({ ...m, subject: c.message_subject ?? '', body: c.message_body ?? '' })), result: { sent: out.length, blocked } };
    });
    for (const m of mails) {
      await this.mailer.send({ template: 'customer_message', to: m.to, locale: 'tr-TR', vars: { tenantName: t.tenant.name, subject: m.subject, body: m.body } }, { jobId: m.jobId });
      await this.db.withTenant(dbCtx(t), (tx) => tx.execute(sql`UPDATE campaign_deliveries SET queued_at = now() WHERE campaign_id = ${id} AND customer_id = ${m.customerId}`));
    }
    return result;
  }

  /** Hourly: campaign mails that never reached the queue (a crash or a queue outage after the commit) are queued
   *  again, with the consent asked again; the queue de-duplicates by job id. */
  async requeue(tenantId: string): Promise<number> {
    const due = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, async (tx) => (await tx.execute<{ campaign_id: string; customer_id: string; subject: string; body: string; tenant_name: string }>(sql`
      SELECT d.campaign_id, d.customer_id, c.message_subject AS subject, c.message_body AS body, (SELECT name FROM tenants) AS tenant_name
      FROM campaign_deliveries d JOIN campaigns c ON c.id = d.campaign_id
      WHERE d.outcome = 'sent' AND d.queued_at IS NULL AND d.at < now() - interval '5 minutes' ORDER BY d.at LIMIT 1000`)).rows);
    let n = 0;
    for (const d of due) {
      const r = await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, (tx) => reachability(tx, tenantId, d.customer_id, 'email'));
      if (r.allowed && r.address) {
        await this.mailer.send({ template: 'customer_message', to: r.address, locale: 'tr-TR', vars: { tenantName: d.tenant_name, subject: d.subject, body: d.body } }, { jobId: `campaign-${d.campaign_id}-${d.customer_id}` });
        n += 1;
      }
      // Withdrawn meanwhile: nothing goes out; the row is settled either way.
      await this.db.withTenant({ tenantId, userId: null, segments: ['b2c'] }, (tx) => tx.execute(sql`
        UPDATE campaign_deliveries SET queued_at = now() WHERE campaign_id = ${d.campaign_id} AND customer_id = ${d.customer_id}`));
    }
    return n;
  }

  // ------------------------------------------------------------------ coupons
  async addCoupon(t: TenantRequestContext, campaignId: string, body: z.infer<typeof CouponCreate>) {
    this.b2c(t);
    authorize(t, 'sales_b2c.coupon.manage');
    // A26 `requires_approval`: a Manager's coupon on a campaign already approved or waiting is created off; an Admin
    // turns it on. On a draft it goes through the campaign's own approval.
    const needsApproval = this.writeGrant(t, 'sales_b2c.coupon.manage')?.approvalNeeded ?? true;
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await tx.execute(sql`SELECT 1 FROM campaigns WHERE id = ${campaignId} FOR UPDATE`);
      const c = await this.one(tx, campaignId);
      if (c.status === 'cancelled' || c.status === 'ended' || c.ended) throw new ProblemError('CAMPAIGN_STATE', undefined, { campaignStatus: c.status });
      const active = !needsApproval || c.status === 'draft';
      try {
        const [k] = (await tx.execute<CouponRow>(sql`
          INSERT INTO coupons (tenant_id, campaign_id, code, discount_percent, max_uses, per_customer_limit, active)
          VALUES (${t.tenant.id}, ${campaignId}, ${body.code}, ${body.discountPercent}::numeric, ${body.maxUses}, ${body.perCustomerLimit}, ${active})
          RETURNING id, code, discount_percent::text AS discount_percent, max_uses, per_customer_limit, uses, active`)).rows;
        if (!k) throw new Error('coupon not written');
        await audit(tx, t.tenant.id, { action: 'coupon.created', actorType: 'user', actorId: t.principal.userId, targetType: 'coupon', targetId: k.id, details: { code: k.code, active } });
        if (!active) {
          const admins = await tx.execute<{ u: string }>(sql`SELECT ur.user_id::text AS u FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN memberships m ON m.user_id = ur.user_id AND m.status = 'active' WHERE r.key = 'admin'`);
          await notify(tx, t, { users: admins.rows.map((a) => a.u), kind: 'approval', sourceType: 'coupon', sourceId: k.id, recordType: 'campaign', recordId: campaignId, message: `${c.name.slice(0, 300)} · ${k.code}` });
        }
        return { id: k.id, code: k.code, discountPercent: pct(k.discount_percent), maxUses: k.max_uses, perCustomerLimit: k.per_customer_limit, uses: k.uses, active: k.active };
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError('CONFLICT', 'a coupon with this code exists');
        throw e;
      }
    });
  }

  async patchCoupon(t: TenantRequestContext, id: string, active: boolean) {
    this.b2c(t);
    authorize(t, 'sales_b2c.coupon.manage');
    // Turning a coupon on is the approval: not for a grant that needs one (a Manager may still turn it off).
    if (active && (this.writeGrant(t, 'sales_b2c.coupon.manage')?.approvalNeeded ?? true)) {
      const draft = await this.db.withTenant(dbCtx(t), async (tx) => (await tx.execute(sql`
        SELECT 1 FROM coupons k JOIN campaigns c ON c.id = k.campaign_id WHERE k.id = ${id} AND c.status = 'draft'`)).rowCount ?? 0);
      if (draft === 0) throw new ProblemError('FORBIDDEN', 'an Admin turns this coupon on');
    }
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [k] = (await tx.execute<CouponRow>(sql`UPDATE coupons SET active = ${active} WHERE id = ${id}
        RETURNING id, code, discount_percent::text AS discount_percent, max_uses, per_customer_limit, uses, active`)).rows;
      if (!k) throw new ProblemError('NOT_FOUND');
      return { id: k.id, code: k.code, discountPercent: pct(k.discount_percent), maxUses: k.max_uses, perCustomerLimit: k.per_customer_limit, uses: k.uses, active: k.active };
    });
  }

  async check(t: TenantRequestContext, code: string, customerId: string) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute(sql`SELECT 1 FROM ${CRM.contact.from} WHERE t.id = ${customerId} AND ${await recordPredicate(tx, t, CRM.contact.shape, 'read')}`);
      if ((r.rowCount ?? 0) === 0) throw new ProblemError('NOT_FOUND');
      const c = await checkCoupon(tx, t, code, customerId);
      return {
        valid: c.valid, reason: c.reason, discountPercent: c.coupon?.percent ?? null,
        campaign: c.coupon ? { id: c.coupon.campaignId, name: c.coupon.campaignName, exclusive: c.coupon.exclusive } : null,
      };
    });
  }
}
