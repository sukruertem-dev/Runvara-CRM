import { Inject, Injectable } from '@nestjs/common';
import { can, scopesOf } from '@flexa/authz';
import { configKey, mergeLayer, type JsonObject } from '@flexa/config';
import { minorDigits, priceQuote, type B2cOrderBulkStep, type B2cOrderCreate, type B2cOrderListQuery, type B2cOrderPayment, type B2cOrderStepRequest, type ReturnCreate, type ReturnDecision, type ReturnListQuery, type z } from '@flexa/contracts';
import { sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import { b2cDeliveryStatus, b2cOrderStep, b2cOrderSteps, type B2cOrderRoles, type B2cOrderStatus, type B2cOrderStep } from '@flexa/workflow';
import { recordActivity } from '../../common/activity';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { nextDocumentNumber } from '../../common/document-number';
import { notify } from '../../common/notify';
import { ProblemError } from '../../common/problem';
import { recordPredicate, uuidArray } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { PricingService } from '../catalog/pricing.service';
import { CRM, readCrmRow, type CrmRow } from '../crm/crm-objects';
import { contactMask } from './customer-mask';

// P9e (docs/p9-plan.md §30–35): B2C orders — catalogue lines priced from the B2C price lists, channel, payment status,
// the role-based workflow of B2C-03 — and returns with their approval (A16, B2C-05). An order is as visible as its
// customer; creating one needs the right to edit the customer.

type OrderRow = {
  id: string; number: string; customer_id: string; full_name: string; owner_user_id: string; channel: 'web' | 'store' | 'phone' | 'social'; status: B2cOrderStatus;
  payment_status: 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded'; currency: string; totals: { net?: string; tax?: string; total?: string };
  shipping_address: Record<string, string> | null; carrier: string | null; tracking_number: string | null; note: string; created_by: string; creator_name: string;
  created_at: string; version: number;
};
type ReturnRow = {
  id: string; number: string; order_id: string; order_number: string; customer_id: string; full_name: string; owner_user_id: string; reason_code: 'other'; reason: string;
  amount: string; currency: string; status: 'requested' | 'approved' | 'rejected' | 'cancelled'; requested_by: string; requester_name: string; decided_by: string | null;
  decider_name: string | null; decided_at: string | null; decision_note: string | null; created_at: string;
};

const iso = (v: string | Date): string => new Date(v).toISOString();
const money = (v: string | null | undefined, digits = 2): string => {
  const [i = '0', f = ''] = (v ?? '0').split('.');
  return digits === 0 ? i : `${i}.${f.padEnd(digits, '0').slice(0, digits)}`;
};
const trimQty = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);

async function setting<T>(tx: Db, tenantId: string, key: string): Promise<T> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT v.value FROM tenant_settings_head h JOIN tenant_settings v USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = ${key}`);
  const def = configKey(key);
  if (!def) throw new Error(`${key} is not registered`);
  return mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as T;
}

@Injectable()
export class OrdersService {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly pricing: PricingService) {}

  // ------------------------------------------------------------------ access
  private b2c(t: TenantRequestContext): void {
    if (!t.segments.includes('b2c')) throw new ProblemError('NOT_FOUND');
  }

  /** Orders whose customer the caller may read (alias `o` for the order, `t` for the customer). */
  private async visible(tx: Db, t: TenantRequestContext): Promise<SQL> {
    return sql`o.segment = 'b2c' AND t.deleted_at IS NULL AND ${await recordPredicate(tx, t, CRM.contact.shape, 'read')}`;
  }

  private async mayEditCustomer(tx: Db, t: TenantRequestContext, customerId: string): Promise<boolean> {
    const r = await tx.execute(sql`SELECT 1 FROM ${CRM.contact.from} WHERE t.id = ${customerId} AND ${await recordPredicate(tx, t, CRM.contact.shape, 'update')}`);
    return (r.rowCount ?? 0) > 0;
  }

  private roles(tx: Db, t: TenantRequestContext): Promise<B2cOrderRoles> {
    return setting<B2cOrderRoles>(tx, t.tenant.id, 'sales_b2c.order_workflow');
  }

  // ------------------------------------------------------------------ orders: reading
  private async orderRows(tx: Db, t: TenantRequestContext, where: SQL, limit = 100): Promise<OrderRow[]> {
    return (await tx.execute<OrderRow>(sql`
      SELECT o.id, o.number, o.customer_id, t.full_name, t.owner_user_id, o.channel, o.status, o.payment_status, o.currency, o.totals, o.shipping_address,
        o.carrier, o.tracking_number, o.note, o.created_by, u.display_name AS creator_name, o.created_at, o.version
      FROM orders o JOIN contacts t ON t.tenant_id = o.tenant_id AND t.id = o.customer_id JOIN users u ON u.id = o.created_by
      WHERE ${await this.visible(tx, t)} AND ${where} ORDER BY o.id DESC LIMIT ${limit}`)).rows;
  }

  private summary(t: TenantRequestContext, o: OrderRow) {
    return {
      id: o.id, number: o.number, customer: { id: o.customer_id, fullName: contactMask(t).name ? o.full_name : '' }, channel: o.channel, status: o.status,
      paymentStatus: o.payment_status, currency: o.currency, total: money(o.totals.total, minorDigits(o.currency)), createdAt: iso(o.created_at),
    };
  }

  private async view(tx: Db, t: TenantRequestContext, id: string) {
    const [o] = await this.orderRows(tx, t, sql`o.id = ${id}`, 1);
    if (!o) throw new ProblemError('NOT_FOUND');
    const d = minorDigits(o.currency);
    const lines = (await tx.execute<{ id: string; product_id: string; sku: string; name: string; unit: string; quantity: string; unit_price: string; tax_percent: string; net: string; tax: string; returned: string }>(sql`
      SELECT l.id, l.product_id, l.sku, l.name, l.unit, l.quantity::text AS quantity, trim_scale(l.unit_price)::text AS unit_price, trim_scale(l.tax_percent)::text AS tax_percent,
        l.net::text AS net, l.tax::text AS tax,
        COALESCE((SELECT sum(rl.quantity) FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE rl.order_line_id = l.id AND r.status IN ('requested', 'approved')), 0)::text AS returned
      FROM order_lines l WHERE l.order_id = ${id} ORDER BY l.position`)).rows;
    const history = (await tx.execute<{ kind: 'status' | 'payment'; from_value: string | null; to_value: string; note: string; actor_id: string | null; actor_name: string | null; at: string }>(sql`
      SELECT h.kind, h.from_value, h.to_value, h.note, h.actor_id, u.display_name AS actor_name, h.at FROM order_status_history h LEFT JOIN users u ON u.id = h.actor_id
      WHERE h.order_id = ${id} ORDER BY h.at, h.id`)).rows;
    const returns = await this.returnRows(tx, t, sql`r.order_id = ${id}`, 50);
    const roles = await this.roles(tx, t);
    const editable = await this.mayEditCustomer(tx, t, o.customer_id);
    return {
      ...this.summary(t, o),
      deliveryStatus: b2cDeliveryStatus(o.status),
      totals: { net: money(o.totals.net, d), tax: money(o.totals.tax, d), total: money(o.totals.total, d) },
      lines: lines.map((l) => ({
        id: l.id, productId: l.product_id, sku: l.sku, name: l.name, unit: l.unit, quantity: trimQty(l.quantity), unitPrice: l.unit_price, taxPercent: l.tax_percent,
        net: money(l.net, d), tax: money(l.tax, d), total: money((Number(l.net) + Number(l.tax)).toFixed(d), d), returnedQuantity: trimQty(l.returned),
      })),
      shippingAddress: o.shipping_address && Object.keys(o.shipping_address).length ? {
        label: o.shipping_address['label'] ?? '', recipient: o.shipping_address['recipient'] ?? '', line1: o.shipping_address['line1'] ?? '', line2: o.shipping_address['line2'] ?? '',
        district: o.shipping_address['district'] ?? '', city: o.shipping_address['city'] ?? '', postalCode: o.shipping_address['postalCode'] ?? '', country: o.shipping_address['country'] ?? '',
      } : null,
      carrier: o.carrier, trackingNumber: o.tracking_number, note: o.note,
      history: history.map((h) => ({ kind: h.kind, from: h.from_value, to: h.to_value, note: h.note, actor: h.actor_id ? { id: h.actor_id, displayName: h.actor_name ?? '' } : null, at: iso(h.at) })),
      returns: returns.map((r) => this.returnSummary(t, r)),
      steps: b2cOrderSteps(o.status, t.authz.roleKeys, roles),
      canPay: t.authz.roleKeys.some((k) => roles.payment.includes(k)) && o.status !== 'cancelled',
      canRequestReturn: o.status === 'delivered' && editable && can(t.authz, 'sales_b2c.return.create', 'request').allow
        && lines.some((l) => Number(l.returned) < Number(l.quantity)),
      createdBy: { id: o.created_by, displayName: o.creator_name },
      version: o.version,
    };
  }

  async getOrder(t: TenantRequestContext, id: string) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), (tx) => this.view(tx, t, id));
  }

  async listOrders(t: TenantRequestContext, q: z.infer<typeof B2cOrderListQuery>) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const terms: SQL[] = [sql`TRUE`];
      if (q.status) terms.push(sql`o.status = ${q.status}`);
      if (q.channel) terms.push(sql`o.channel = ${q.channel}`);
      if (q.customerId) terms.push(sql`o.customer_id = ${q.customerId}`);
      if (q.q) terms.push(sql`o.number ILIKE ${`%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`);
      if (q.cursor) terms.push(sql`o.id < ${q.cursor}`);
      const rows = await this.orderRows(tx, t, sql.join(terms, sql` AND `), q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { data: page.map((o) => this.summary(t, o)), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
    });
  }

  // ------------------------------------------------------------------ orders: writing
  async createOrder(t: TenantRequestContext, body: z.infer<typeof B2cOrderCreate>) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const c = await readCrmRow(tx, t, CRM.contact, body.customerId);
      if (!(c['segments'] as string[] | undefined)?.includes('b2c') || c['merged_into']) throw new ProblemError('NOT_FOUND');
      if (c['anonymized_at']) throw new ProblemError('NOT_A_CUSTOMER', 'the customer was anonymized');
      if (!(await this.mayEditCustomer(tx, t, body.customerId))) throw new ProblemError('FORBIDDEN');
      const currency = body.currency ?? t.tenant.currency;
      const roles = await this.roles(tx, t);
      const products = new Map((await tx.execute<{ id: string; sku: string; name: string; unit: string; active: boolean; tax: string | null }>(sql`
        SELECT p.id, p.sku, p.name, p.unit, p.active, trim_scale(r.rate)::text AS tax FROM products p LEFT JOIN tax_rates r ON r.tenant_id = p.tenant_id AND r.id = p.tax_rate_id
        WHERE p.id = ANY(${uuidArray([...new Set(body.lines.map((l) => l.productId))])}) AND 'b2c' = ANY (p.segments)`)).rows.map((p) => [p.id, p]));
      if (body.lines.some((l) => !products.get(l.productId)?.active)) throw new ProblemError('VALIDATION_FAILED', 'lines: unknown or inactive product');
      // Starting with anything but `pending` is a payment change: it needs the payment roles too.
      if (body.paymentStatus !== 'pending' && !t.authz.roleKeys.some((k) => roles.payment.includes(k))) throw new ProblemError('FORBIDDEN', 'payment status: not for your role');
      const prices = await this.pricing.resolveTx(tx, t, { segment: 'b2c', currency, accountId: null, items: body.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
      const missing = body.lines.filter((_, i) => !prices.data[i]?.price);
      if (missing.length) throw new ProblemError('QUOTE_PRICE_MISSING', undefined, { productIds: missing.map((l) => l.productId) });
      const lines = body.lines.map((l, i) => {
        const p = products.get(l.productId);
        const unitPrice = prices.data[i]?.price?.unitPrice ?? '0';
        return { ...l, sku: p?.sku ?? '', name: p?.name ?? '', unit: p?.unit ?? '', unitPrice, taxPercent: p?.tax ?? '0' };
      });
      const priced = priceQuote(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, listPrice: l.unitPrice, discountPercent: '0', taxPercent: l.taxPercent })), '0', currency);
      let address: Record<string, string> | null = null;
      if (body.shippingAddressId) {
        const [a] = (await tx.execute<Record<string, string>>(sql`
          SELECT label, recipient, line1, line2, district, city, postal_code AS "postalCode", country FROM customer_addresses WHERE id = ${body.shippingAddressId} AND contact_id = ${body.customerId}`)).rows;
        if (!a) throw new ProblemError('VALIDATION_FAILED', 'shippingAddressId: not an address of the customer');
        address = a;
      }
      const number = await nextDocumentNumber(tx, t, 'order');
      const [o] = (await tx.execute<{ id: string }>(sql`
        INSERT INTO orders (tenant_id, number, segment, customer_id, channel, status, payment_status, currency, totals, shipping_address, note, created_by)
        VALUES (${t.tenant.id}, ${number}, 'b2c', ${body.customerId}, ${body.channel}, 'new', ${body.paymentStatus}, ${currency},
          ${JSON.stringify({ net: priced.totals.net, tax: priced.totals.tax, total: priced.totals.total })}::jsonb, ${address ? JSON.stringify(address) : null}::jsonb, ${body.note}, ${t.principal.userId})
        RETURNING id`)).rows;
      if (!o) throw new Error('order not written');
      for (const [i, l] of lines.entries()) {
        const x = priced.lines[i];
        await tx.execute(sql`INSERT INTO order_lines (tenant_id, order_id, position, product_id, sku, name, unit, quantity, unit_price, discount_percent, tax_percent, net, tax)
          VALUES (${t.tenant.id}, ${o.id}, ${i}, ${l.productId}, ${l.sku}, ${l.name}, ${l.unit}, ${l.quantity}::numeric, ${l.unitPrice}::numeric, 0, ${l.taxPercent}::numeric, ${x?.net ?? '0'}::numeric, ${x?.tax ?? '0'}::numeric)`);
      }
      await this.history(tx, t, o.id, 'status', null, 'new', '');
      await this.history(tx, t, o.id, 'payment', null, body.paymentStatus, '');
      await recordActivity(tx, t, { type: 'contact', id: body.customerId, kind: 'order', data: { action: 'created', orderId: o.id, number }, segment: 'b2c' });
      return this.view(tx, t, o.id);
    });
  }

  private async history(tx: Db, t: TenantRequestContext, orderId: string, kind: 'status' | 'payment', from: string | null, to: string, note: string): Promise<void> {
    await tx.execute(sql`INSERT INTO order_status_history (tenant_id, order_id, kind, from_value, to_value, note, actor_id)
      VALUES (${t.tenant.id}, ${orderId}, ${kind}, ${from}, ${to}, ${note}, ${t.principal.userId})`);
  }

  private async lockOrder(tx: Db, t: TenantRequestContext, id: string): Promise<OrderRow> {
    const [o] = await this.orderRows(tx, t, sql`o.id = ${id}`, 1);
    if (!o) throw new ProblemError('NOT_FOUND');
    await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${id} FOR UPDATE`);
    const [fresh] = await this.orderRows(tx, t, sql`o.id = ${id}`, 1);
    if (!fresh) throw new ProblemError('NOT_FOUND');
    return fresh;
  }

  private async stepIn(tx: Db, t: TenantRequestContext, id: string, body: { step: B2cOrderStep; note: string; carrier?: string | undefined; trackingNumber?: string | undefined }): Promise<void> {
    const o = await this.lockOrder(tx, t, id);
    const r = b2cOrderStep(o.status, body.step, t.authz.roleKeys, await this.roles(tx, t));
    if (!r.ok) throw new ProblemError(r.code, r.reason, { orderStatus: o.status });
    const shipping = body.step === 'ship' ? sql`, carrier = ${body.carrier ?? o.carrier}, tracking_number = ${body.trackingNumber ?? o.tracking_number}` : sql``;
    await tx.execute(sql`UPDATE orders SET status = ${r.to}, version = version + 1 ${shipping}${body.step === 'cancel' ? sql`, status_reason = ${body.note}` : sql``} WHERE id = ${id}`);
    await this.history(tx, t, id, 'status', o.status, r.to, body.note);
    await recordActivity(tx, t, { type: 'contact', id: o.customer_id, kind: 'order', data: { action: 'status_changed', orderId: id, from: o.status, to: r.to }, segment: 'b2c' });
  }

  async step(t: TenantRequestContext, id: string, body: z.infer<typeof B2cOrderStepRequest>) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.stepIn(tx, t, id, body);
      return this.view(tx, t, id);
    });
  }

  /** Each order in its own transaction: one that may not move does not hold the others back. */
  async bulkStep(t: TenantRequestContext, body: z.infer<typeof B2cOrderBulkStep>) {
    this.b2c(t);
    const data: { id: string; ok: boolean; code: string | null }[] = [];
    for (const id of [...new Set(body.ids)]) {
      try {
        await this.db.withTenant(dbCtx(t), (tx) => this.stepIn(tx, t, id, { step: body.step, note: body.note }));
        data.push({ id, ok: true, code: null });
      } catch (e) {
        if (!(e instanceof ProblemError)) throw e;
        data.push({ id, ok: false, code: e.code });
      }
    }
    return { data };
  }

  async payment(t: TenantRequestContext, id: string, body: z.infer<typeof B2cOrderPayment>) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const o = await this.lockOrder(tx, t, id);
      const roles = await this.roles(tx, t);
      if (!t.authz.roleKeys.some((k) => roles.payment.includes(k))) throw new ProblemError('FORBIDDEN');
      if (o.status === 'cancelled') throw new ProblemError('ORDER_STATE', 'the order is cancelled', { orderStatus: o.status });
      if (o.payment_status !== body.status) {
        await tx.execute(sql`UPDATE orders SET payment_status = ${body.status}, version = version + 1 WHERE id = ${id}`);
        await this.history(tx, t, id, 'payment', o.payment_status, body.status, body.note);
        await recordActivity(tx, t, { type: 'contact', id: o.customer_id, kind: 'order', data: { action: 'payment_changed', orderId: id, from: o.payment_status, to: body.status }, segment: 'b2c' });
      }
      return this.view(tx, t, id);
    });
  }

  // ------------------------------------------------------------------ returns
  private async returnRows(tx: Db, t: TenantRequestContext, where: SQL, limit = 100): Promise<ReturnRow[]> {
    return (await tx.execute<ReturnRow>(sql`
      SELECT r.id, r.number, r.order_id, o.number AS order_number, o.customer_id, t.full_name, t.owner_user_id, r.reason_code, r.reason, r.amount::text AS amount, r.currency,
        r.status, r.requested_by, rq.display_name AS requester_name, r.decided_by, dc.display_name AS decider_name, r.decided_at, r.decision_note, r.created_at
      FROM returns r JOIN orders o ON o.tenant_id = r.tenant_id AND o.id = r.order_id JOIN contacts t ON t.tenant_id = o.tenant_id AND t.id = o.customer_id
        JOIN users rq ON rq.id = r.requested_by LEFT JOIN users dc ON dc.id = r.decided_by
      WHERE ${await this.visible(tx, t)} AND ${where} ORDER BY r.id DESC LIMIT ${limit}`)).rows;
  }

  private returnSummary(t: TenantRequestContext, r: ReturnRow) {
    return {
      id: r.id, number: r.number, order: { id: r.order_id, number: r.order_number }, customer: { id: r.customer_id, fullName: contactMask(t).name ? r.full_name : '' },
      reasonCode: r.reason_code, amount: money(r.amount, minorDigits(r.currency)), currency: r.currency, status: r.status,
      requestedBy: { id: r.requested_by, displayName: r.requester_name }, createdAt: iso(r.created_at),
    };
  }

  /** A16: Admin decides any return; a team Manager those of their people's customers up to the limit; never one's own. */
  private async mayDecide(tx: Db, t: TenantRequestContext, r: ReturnRow): Promise<boolean> {
    if (r.requested_by === t.principal.userId) return false;
    const d = can(t.authz, 'sales_b2c.return.approve', 'approve');
    if (!d.allow) return false;
    const scopes = scopesOf(d.grant);
    const within = !(d.grant.constraints ?? []).includes('approve_within_limit')
      || Number(r.amount) <= Number((await setting<{ managerLimit: string }>(tx, t.tenant.id, 'sales_b2c.returns')).managerLimit);
    if (scopes.includes('all')) return within;
    return scopes.includes('team') && t.access.managedMemberIds.includes(r.owner_user_id) && r.owner_user_id !== t.principal.userId && within;
  }

  private async returnView(tx: Db, t: TenantRequestContext, id: string) {
    const [r] = await this.returnRows(tx, t, sql`r.id = ${id}`, 1);
    if (!r) throw new ProblemError('NOT_FOUND');
    const d = minorDigits(r.currency);
    const lines = (await tx.execute<{ order_line_id: string; name: string; quantity: string; amount: string }>(sql`
      SELECT rl.order_line_id, l.name, rl.quantity::text AS quantity, rl.amount::text AS amount FROM return_lines rl JOIN order_lines l ON l.id = rl.order_line_id
      WHERE rl.return_id = ${id} ORDER BY l.position`)).rows;
    return {
      ...this.returnSummary(t, r), reason: r.reason,
      lines: lines.map((l) => ({ orderLineId: l.order_line_id, name: l.name, quantity: trimQty(l.quantity), amount: money(l.amount, d) })),
      decidedBy: r.decided_by ? { id: r.decided_by, displayName: r.decider_name ?? '' } : null, decidedAt: r.decided_at ? iso(r.decided_at) : null, decisionNote: r.decision_note,
      canDecide: r.status === 'requested' && (await this.mayDecide(tx, t, r)),
      canCancel: r.status === 'requested' && r.requested_by === t.principal.userId,
    };
  }

  async getReturn(t: TenantRequestContext, id: string) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), (tx) => this.returnView(tx, t, id));
  }

  async listReturns(t: TenantRequestContext, q: z.infer<typeof ReturnListQuery>) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const terms: SQL[] = [sql`TRUE`];
      if (q.status) terms.push(sql`r.status = ${q.status}`);
      if (q.orderId) terms.push(sql`r.order_id = ${q.orderId}`);
      if (q.cursor) terms.push(sql`r.id < ${q.cursor}`);
      const rows = await this.returnRows(tx, t, sql.join(terms, sql` AND `), q.limit + 1);
      const page = rows.slice(0, q.limit);
      return { data: page.map((r) => this.returnSummary(t, r)), nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null };
    });
  }

  async createReturn(t: TenantRequestContext, body: z.infer<typeof ReturnCreate>) {
    this.b2c(t);
    authorize(t, 'sales_b2c.return.create', 'request');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const o = await this.lockOrder(tx, t, body.orderId);
      if (!(await this.mayEditCustomer(tx, t, o.customer_id))) throw new ProblemError('FORBIDDEN');
      if (o.status !== 'delivered') throw new ProblemError('RETURN_STATE', 'only a delivered order can be returned', { orderStatus: o.status });
      const d = minorDigits(o.currency);
      const lines = new Map((await tx.execute<{ id: string; quantity: string; net: string; tax: string; returned: string }>(sql`
        SELECT l.id, l.quantity::text AS quantity, l.net::text AS net, l.tax::text AS tax,
          COALESCE((SELECT sum(rl.quantity) FROM return_lines rl JOIN returns r ON r.id = rl.return_id WHERE rl.order_line_id = l.id AND r.status IN ('requested', 'approved')), 0)::text AS returned
        FROM order_lines l WHERE l.order_id = ${o.id}`)).rows.map((l) => [l.id, l]));
      const asked = new Map<string, number>();
      for (const l of body.lines) asked.set(l.orderLineId, (asked.get(l.orderLineId) ?? 0) + Number(l.quantity));
      for (const [lineId, qty] of asked) {
        const l = lines.get(lineId);
        if (!l) throw new ProblemError('VALIDATION_FAILED', 'lines: not a line of the order');
        if (qty > Number(l.quantity) - Number(l.returned) + 1e-9) throw new ProblemError('RETURN_QUANTITY', undefined, { orderLineId: lineId, left: trimQty((Number(l.quantity) - Number(l.returned)).toFixed(3)) });
      }
      const number = await nextDocumentNumber(tx, t, 'return');
      // A line's share of its total (net + tax) for the returned quantity, in the currency's minor unit.
      const parts = [...asked].map(([lineId, qty]) => ({ lineId, qty }));
      const [ret] = (await tx.execute<{ id: string }>(sql`
        INSERT INTO returns (tenant_id, number, order_id, reason_code, reason, amount, currency, requested_by)
        VALUES (${t.tenant.id}, ${number}, ${o.id}, ${body.reasonCode}, ${body.reason}, 0, ${o.currency}, ${t.principal.userId}) RETURNING id`)).rows;
      if (!ret) throw new Error('return not written');
      for (const p of parts) {
        await tx.execute(sql`INSERT INTO return_lines (tenant_id, return_id, order_line_id, quantity, amount)
          SELECT ${t.tenant.id}, ${ret.id}, l.id, ${String(p.qty)}::numeric,
            -- Cumulative rounding: the share of everything returned so far, minus what earlier returns already took, so the
            -- returns of a line never add up to more than the line and a complete return refunds it exactly.
            round((l.net + l.tax) * (prev.qty + ${String(p.qty)}::numeric) / l.quantity, ${d}) - prev.amount
          FROM order_lines l CROSS JOIN LATERAL (
            SELECT COALESCE(sum(rl.quantity), 0) AS qty, COALESCE(sum(rl.amount), 0) AS amount FROM return_lines rl JOIN returns r ON r.id = rl.return_id
            WHERE rl.order_line_id = l.id AND r.status IN ('requested', 'approved')) prev
          WHERE l.id = ${p.lineId}`);
      }
      await tx.execute(sql`UPDATE returns SET amount = (SELECT COALESCE(sum(amount), 0) FROM return_lines WHERE return_id = ${ret.id}) WHERE id = ${ret.id}`);
      await recordActivity(tx, t, { type: 'contact', id: o.customer_id, kind: 'return', data: { action: 'requested', returnId: ret.id, orderId: o.id }, segment: 'b2c' });
      const [r] = await this.returnRows(tx, t, sql`r.id = ${ret.id}`, 1);
      if (r) await this.notifyApprovers(tx, t, r);
      return this.returnView(tx, t, ret.id);
    });
  }

  /** The Managers of the teams of the customer's owner (and the teams above), and the Admins when beyond their limit. */
  private async notifyApprovers(tx: Db, t: TenantRequestContext, r: ReturnRow): Promise<void> {
    const limit = (await setting<{ managerLimit: string }>(tx, t.tenant.id, 'sales_b2c.returns')).managerLimit;
    const beyond = Number(r.amount) > Number(limit);
    const people = await tx.execute<{ u: string }>(sql`
      WITH RECURSIVE up(id) AS (
        SELECT m.primary_team_id FROM memberships m WHERE m.user_id = ${r.owner_user_id}::uuid AND m.primary_team_id IS NOT NULL
        UNION SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${r.owner_user_id}::uuid
        UNION SELECT c.parent_team_id FROM teams c JOIN up ON c.id = up.id WHERE c.parent_team_id IS NOT NULL
      )
      SELECT DISTINCT tm.user_id::text AS u FROM team_members tm JOIN memberships m ON m.user_id = tm.user_id AND m.status = 'active'
      WHERE ${beyond ? sql`FALSE` : sql`tm.role = 'manager' AND tm.team_id IN (SELECT id FROM up)`}
      UNION
      SELECT ur.user_id::text FROM user_roles ur JOIN roles ro ON ro.id = ur.role_id JOIN memberships m ON m.user_id = ur.user_id AND m.status = 'active'
      WHERE ro.key = 'admin' AND (${beyond} OR NOT EXISTS (SELECT 1 FROM team_members tm2 WHERE tm2.role = 'manager' AND tm2.team_id IN (SELECT id FROM up)))`);
    await notify(tx, t, { users: people.rows.map((p) => p.u).filter((u) => u !== r.requested_by), kind: 'approval', sourceType: 'return', sourceId: r.id, recordType: 'contact', recordId: r.customer_id });
  }

  async decide(t: TenantRequestContext, id: string, body: z.infer<typeof ReturnDecision>) {
    this.b2c(t);
    authorize(t, 'sales_b2c.return.approve', 'approve');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [visible] = await this.returnRows(tx, t, sql`r.id = ${id}`, 1);
      if (!visible) throw new ProblemError('NOT_FOUND');
      await tx.execute(sql`SELECT 1 FROM returns WHERE id = ${id} FOR UPDATE`);
      const [r] = await this.returnRows(tx, t, sql`r.id = ${id}`, 1);
      if (!r) throw new ProblemError('NOT_FOUND');
      if (r.status !== 'requested') throw new ProblemError('RETURN_STATE', undefined, { returnStatus: r.status });
      if (!(await this.mayDecide(tx, t, r))) throw new ProblemError('FORBIDDEN', r.requested_by === t.principal.userId ? 'not your own request' : 'beyond your authority');
      const status = body.decision === 'approve' ? 'approved' : 'rejected';
      await tx.execute(sql`UPDATE returns SET status = ${status}, decided_by = ${t.principal.userId}, decided_at = now(), decision_note = ${body.note || null}, version = version + 1 WHERE id = ${id}`);
      if (status === 'approved') await this.applyReturn(tx, t, r);
      await recordActivity(tx, t, { type: 'contact', id: r.customer_id, kind: 'return', data: { action: status, returnId: id, orderId: r.order_id }, segment: 'b2c' });
      await audit(tx, t.tenant.id, { action: `return.${status}`, actorType: 'user', actorId: t.principal.userId, targetType: 'return', targetId: id, details: { amount: r.amount, currency: r.currency } });
      await notify(tx, t, { users: [r.requested_by], kind: 'approval', sourceType: 'return_decision', sourceId: id, recordType: 'contact', recordId: r.customer_id });
      return this.returnView(tx, t, id);
    });
  }

  /** An approved return: everything back → the order is `returned`; a paid order is refunded in full or in part. */
  private async applyReturn(tx: Db, t: TenantRequestContext, r: ReturnRow): Promise<void> {
    // The order lock first, then the totals in a new statement: a return approved at the same time is seen after it.
    await tx.execute(sql`SELECT 1 FROM orders WHERE id = ${r.order_id} FOR UPDATE`);
    const [o] = (await tx.execute<{ status: B2cOrderStatus; payment_status: string; all_back: boolean }>(sql`
      SELECT o.status, o.payment_status, NOT EXISTS (
        SELECT 1 FROM order_lines l WHERE l.order_id = o.id AND l.quantity > COALESCE((
          SELECT sum(rl.quantity) FROM return_lines rl JOIN returns x ON x.id = rl.return_id WHERE rl.order_line_id = l.id AND x.status = 'approved'), 0)) AS all_back
      FROM orders o WHERE o.id = ${r.order_id}`)).rows;
    if (!o) return;
    const status: B2cOrderStatus = o.all_back ? 'returned' : o.status;
    const pay = ['paid', 'partially_refunded'].includes(o.payment_status) ? (o.all_back ? 'refunded' : 'partially_refunded') : o.payment_status;
    await tx.execute(sql`UPDATE orders SET status = ${status}, payment_status = ${pay}, version = version + 1 WHERE id = ${r.order_id}`);
    if (status !== o.status) await this.history(tx, t, r.order_id, 'status', o.status, status, r.number);
    if (pay !== o.payment_status) await this.history(tx, t, r.order_id, 'payment', o.payment_status, pay, r.number);
  }

  async cancelReturn(t: TenantRequestContext, id: string) {
    this.b2c(t);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const [r] = await this.returnRows(tx, t, sql`r.id = ${id}`, 1);
      if (!r) throw new ProblemError('NOT_FOUND');
      if (r.requested_by !== t.principal.userId) throw new ProblemError('FORBIDDEN');
      const done = await tx.execute(sql`UPDATE returns SET status = 'cancelled', version = version + 1 WHERE id = ${id} AND status = 'requested'`);
      if ((done.rowCount ?? 0) === 0) throw new ProblemError('RETURN_STATE', undefined, { returnStatus: r.status });
      await recordActivity(tx, t, { type: 'contact', id: r.customer_id, kind: 'return', data: { action: 'cancelled', returnId: id, orderId: r.order_id }, segment: 'b2c' });
      return this.returnView(tx, t, id);
    });
  }

  /** Orders and returns of a customer for a data subject export (KVKK); the caller has already been authorized. */
  async exportFor(tx: Db, t: TenantRequestContext, customer: CrmRow) {
    const orders = await this.orderRows(tx, t, sql`o.customer_id = ${customer.id}`, 10_000);
    return Promise.all(orders.map(async (o) => this.view(tx, t, o.id)));
  }
}
