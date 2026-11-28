import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P9e (docs/p9-plan.md §30–37): B2C orders, the role-based workflow, returns and their approval, KVKK requests.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(process.env.TEST_SUPER_DATABASE_URL!, text, values);
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const O = '/v1/sales/b2c/orders';
const R = '/v1/sales/b2c/returns';
const C = '/v1/sales/b2c/customers';

async function member(admin: Client, role: string, team?: string, teamRole: 'member' | 'manager' = 'member') {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: email.split('@')[0] }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  if (team) ok(await admin.put(`/v1/teams/${team}/members/${userId}`, { role: teamRole }));
  return { c, userId };
}

async function setup() {
  const admin = await signupAndLogin(h);
  for (const m of ['crm', 'sales_b2c']) ok(await admin.c.post(`/v1/modules/${m}/enable`));
  const team = String(ok(await admin.c.post('/v1/teams', { name: uniq('Mağaza ') }), 201).id);
  const mgr = await member(admin.c, 'manager', team, 'manager');
  const rep = await member(admin.c, 'sales_rep', team);
  const peer = await member(admin.c, 'sales_rep');
  const tax = String(ok(await admin.c.post('/v1/tax-rates', { name: 'KDV', rate: '20' }), 201).id);
  const product = String(ok(await admin.c.post('/v1/products', { sku: 'AYK-1', name: 'Koşu ayakkabısı', unit: 'adet', segments: ['b2c'], taxRateId: tax }), 201).id);
  const unpriced = String(ok(await admin.c.post('/v1/products', { sku: 'CRP-1', name: 'Çorap', unit: 'adet', segments: ['b2c'] }), 201).id);
  const list = String(ok(await admin.c.post('/v1/price-lists', { name: 'Perakende', currency: 'TRY' }), 201).id);
  ok(await admin.c.put(`/v1/price-lists/${list}/products/${product}`, { breaks: [{ minQty: '1', unitPrice: '100' }] }), 204);
  const customer = String(ok(await rep.c.post('/v1/contacts', {
    firstName: 'Elif', lastName: 'Demir', segments: ['b2c'], contactPoints: [{ kind: 'email', value: 'elif@ornek.test' }],
  }), 201).id);
  const withAddress = ok(await rep.c.post(`${C}/${customer}/addresses`, { label: 'Ev', line1: 'Atatürk Cad. 10', city: 'İzmir' }), 201);
  const address = String(((withAddress.addresses as Json[])[0] as Json).id);
  return { ...admin, mgr, rep, peer, product, unpriced, customer, address };
}
type W = Awaited<ReturnType<typeof setup>>;
const order = (w: W, extra: Json = {}) => w.rep.c.post(O, { customerId: w.customer, channel: 'phone', lines: [{ productId: w.product, quantity: '2' }], shippingAddressId: w.address, ...extra });
const step = (c: Client, id: unknown, s: string, extra: Json = {}) => c.post(`${O}/${String(id)}/step`, { step: s, ...extra });

describe('B2C orders (B2C-02, B2C-03)', () => {
  it('lines priced from the B2C price list with tax, channel, address and payment status; as visible as the customer', async () => {
    const w = await setup();
    const o = ok(await order(w), 201);
    expect(o).toMatchObject({
      number: expect.stringMatching(/^SP-\d{4}-00001$/), channel: 'phone', status: 'new', deliveryStatus: 'pending', paymentStatus: 'pending', currency: 'TRY',
      totals: { net: '200.00', tax: '40.00', total: '240.00' }, customer: { id: w.customer, fullName: 'Elif Demir' },
      lines: [{ sku: 'AYK-1', quantity: '2', unitPrice: '100', taxPercent: '20', net: '200.00', tax: '40.00', total: '240.00', returnedQuantity: '0' }],
      shippingAddress: { label: 'Ev', city: 'İzmir' }, steps: ['confirm', 'cancel'], canPay: true, canRequestReturn: false,
    });
    expect((o.history as Json[]).map((x) => [x.kind, x.to])).toEqual([['status', 'new'], ['payment', 'pending']]);
    expect((await order(w, { lines: [{ productId: w.unpriced, quantity: '1' }] })).body.code).toBe('QUOTE_PRICE_MISSING');
    expect((await w.peer.c.get(`${O}/${String(o.id)}`)).status).toBe(404);
    expect((ok(await w.peer.c.get(O)).data as Json[])).toEqual([]);
    expect((ok(await w.mgr.c.get(`${O}?customerId=${w.customer}`)).data as Json[]).map((x) => x.id)).toEqual([o.id]);
    const analyst = await member(w.c, 'analyst');
    expect(ok(await analyst.c.get(`${O}/${String(o.id)}`)).steps).toEqual([]);
    expect((await analyst.c.post(O, { customerId: w.customer, channel: 'web', lines: [{ productId: w.product, quantity: '1' }] })).status).toBe(403);
    const b2bOnly = await member(w.c, 'admin');
    ok(await w.c.put(`/v1/users/${b2bOnly.userId}/segments`, { segments: [{ segment: 'b2b' }] }));
    expect((await b2bOnly.c.get(`${O}/${String(o.id)}`)).status).toBe(404);
    const timeline = (ok(await w.rep.c.get(`/v1/contacts/${w.customer}/timeline`)).data as Json[]).filter((e) => e.kind === 'order');
    expect(timeline.map((e) => (e.data as Json).action)).toEqual(['created']);
  });

  it('steps by role: the rep confirms, the Manager prepares, ships and delivers; cancelling needs a reason', async () => {
    const w = await setup();
    const o = ok(await order(w), 201);
    expect(ok(await step(w.rep.c, o.id, 'confirm'))).toMatchObject({ status: 'confirmed', steps: ['cancel'] });
    expect((await step(w.rep.c, o.id, 'prepare')).body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await step(w.mgr.c, o.id, 'ship')).body).toMatchObject({ code: 'ORDER_STATE', orderStatus: 'confirmed' });
    ok(await step(w.mgr.c, o.id, 'prepare'));
    expect(ok(await step(w.mgr.c, o.id, 'ship', { carrier: 'Yurtiçi', trackingNumber: 'YK123' }))).toMatchObject({ status: 'shipped', deliveryStatus: 'shipped', carrier: 'Yurtiçi', trackingNumber: 'YK123' });
    expect((await step(w.mgr.c, o.id, 'cancel', { note: 'x' })).body.code).toBe('ORDER_STATE');
    ok(await w.rep.c.post(`${O}/${String(o.id)}/payment`, { status: 'paid' }));
    const done = ok(await step(w.mgr.c, o.id, 'deliver'));
    expect(done).toMatchObject({ status: 'delivered', paymentStatus: 'paid', canRequestReturn: true });
    expect((done.history as Json[]).map((x) => `${String(x.kind)}:${String(x.to)}`)).toEqual(['status:new', 'payment:pending', 'status:confirmed', 'status:preparing', 'status:shipped', 'payment:paid', 'status:delivered']);

    const a = ok(await order(w), 201);
    const b = ok(await order(w), 201);
    expect((await step(w.rep.c, a.id, 'cancel')).status).toBe(400);
    // Payment roles hold from the start: a restricted rep cannot open an order as paid.
    ok(await w.c.req('PUT', '/v1/config/sales_b2c.order_workflow?scope=tenant', { value: { payment: ['admin', 'manager'] } }, { 'if-match': '0' }));
    expect((await order(w, { paymentStatus: 'paid' })).status).toBe(403);
    expect(ok(await order(w), 201)).toMatchObject({ paymentStatus: 'pending', canPay: false });
    ok(await w.c.req('PUT', '/v1/config/sales_b2c.order_workflow?scope=tenant', { value: {} }, { 'if-match': '1' }));
    expect(ok(await step(w.rep.c, a.id, 'cancel', { note: 'Müşteri vazgeçti' }))).toMatchObject({ status: 'cancelled', deliveryStatus: 'none', steps: [] });
    // In bulk: each order its own answer.
    const bulk = ok(await w.rep.c.post(`${O}/steps`, { ids: [a.id, b.id, '00000000-0000-4000-8000-000000000000'], step: 'confirm' }));
    expect((bulk.data as Json[]).map((x) => [x.id, x.ok, x.code])).toEqual([[a.id, false, 'ORDER_STATE'], [b.id, true, null], ['00000000-0000-4000-8000-000000000000', false, 'NOT_FOUND']]);
    expect((ok(await w.rep.c.get(`${O}?status=confirmed`)).data as Json[]).map((x) => x.id)).toEqual([b.id]);
    const events = await sql(`SELECT type FROM outbox_events WHERE tenant_id = $1 AND type LIKE 'order.%' ORDER BY id`, [w.tenantId]);
    expect(events.map((e) => e.type)).toContain('order.status_changed');
    expect(events.map((e) => e.type)).toContain('order.payment_changed');
  });
});

describe('returns (B2C-05)', () => {
  async function delivered(w: W, qty = '2') {
    const o = ok(await order(w, { lines: [{ productId: w.product, quantity: qty }] }), 201);
    ok(await w.rep.c.post(`${O}/${String(o.id)}/payment`, { status: 'paid' }));
    ok(await step(w.rep.c, o.id, 'confirm'));
    for (const s of ['prepare', 'ship', 'deliver']) ok(await step(w.mgr.c, o.id, s));
    return ok(await w.rep.c.get(`${O}/${String(o.id)}`));
  }
  const line = (o: Json) => String(((o.lines as Json[])[0] as Json).id);

  it('asked for delivered lines, approved by the team Manager within the limit; refunds and the returned status follow', async () => {
    const w = await setup();
    const fresh = ok(await order(w), 201);
    expect((await w.rep.c.post(R, { orderId: fresh.id, reasonCode: 'damaged', lines: [{ orderLineId: line(fresh), quantity: '1' }] })).body).toMatchObject({ code: 'RETURN_STATE' });
    const o = await delivered(w);
    expect((await w.rep.c.post(R, { orderId: o.id, reasonCode: 'damaged', lines: [{ orderLineId: line(o), quantity: '3' }] })).body).toMatchObject({ code: 'RETURN_QUANTITY', left: '2' });
    const r1 = ok(await w.rep.c.post(R, { orderId: o.id, reasonCode: 'damaged', reason: 'Taban ayrıldı', lines: [{ orderLineId: line(o), quantity: '1' }] }), 201);
    expect(r1).toMatchObject({ number: expect.stringMatching(/^IA-\d{4}-00001$/), status: 'requested', amount: '120.00', currency: 'TRY', canDecide: false, canCancel: true });
    expect((ok(await w.rep.c.get(`${O}/${String(o.id)}`)).lines as Json[])[0]).toMatchObject({ returnedQuantity: '1' });
    expect((await w.rep.c.post(`${R}/${String(r1.id)}/decision`, { decision: 'approve' })).status).toBe(403);
    const notes = await sql(`SELECT user_id::text AS u FROM notifications WHERE tenant_id = $1 AND source_type = 'return'`, [w.tenantId]);
    expect(notes.map((n) => n.u)).toEqual([w.mgr.userId]);
    expect(ok(await w.mgr.c.get(`${R}/${String(r1.id)}`)).canDecide).toBe(true);
    expect(ok(await w.mgr.c.post(`${R}/${String(r1.id)}/decision`, { decision: 'approve', note: 'Uygun' }))).toMatchObject({ status: 'approved', decidedBy: { id: w.mgr.userId } });
    expect(ok(await w.rep.c.get(`${O}/${String(o.id)}`))).toMatchObject({ status: 'delivered', paymentStatus: 'partially_refunded' });
    expect((await w.mgr.c.post(`${R}/${String(r1.id)}/decision`, { decision: 'reject' })).body.code).toBe('RETURN_STATE');

    const r2 = ok(await w.rep.c.post(R, { orderId: o.id, reasonCode: 'changed_mind', lines: [{ orderLineId: line(o), quantity: '1' }] }), 201);
    ok(await w.mgr.c.post(`${R}/${String(r2.id)}/decision`, { decision: 'approve' }));
    expect(ok(await w.rep.c.get(`${O}/${String(o.id)}`))).toMatchObject({ status: 'returned', deliveryStatus: 'delivered', paymentStatus: 'refunded', canRequestReturn: false });
    const events = await sql(`SELECT type FROM outbox_events WHERE tenant_id = $1 AND type LIKE 'return.%' ORDER BY id`, [w.tenantId]);
    expect(events.map((e) => e.type)).toEqual(['return.requested', 'return.approved', 'return.requested', 'return.approved']);
    const analyst = await member(w.c, 'analyst');
    expect((await analyst.c.post(R, { orderId: o.id, reasonCode: 'other', lines: [{ orderLineId: line(o), quantity: '1' }] })).status).toBe(403);
  });

  it('partial returns of one line never refund more than the line: rounding is cumulative', async () => {
    const w = await setup();
    const list = String((ok(await w.c.get('/v1/price-lists')).data as Json[])[0]?.id);
    ok(await w.c.put(`/v1/price-lists/${list}/products/${w.product}`, { breaks: [{ minQty: '1', unitPrice: '19.99' }] }), 204);
    const o = await delivered(w, '3');
    expect(o.totals).toMatchObject({ total: '71.96' });
    const amounts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ret = ok(await w.rep.c.post(R, { orderId: o.id, reasonCode: 'other', lines: [{ orderLineId: line(o), quantity: '1' }] }), 201);
      amounts.push(String(ret.amount));
      ok(await w.mgr.c.post(`${R}/${String(ret.id)}/decision`, { decision: 'approve' }));
    }
    expect(amounts).toEqual(['23.99', '23.98', '23.99']);
    expect(ok(await w.rep.c.get(`${O}/${String(o.id)}`))).toMatchObject({ status: 'returned', paymentStatus: 'refunded' });
  });

  it('beyond the Manager limit an Admin decides; a request can be withdrawn by whoever asked', async () => {
    const w = await setup();
    ok(await w.c.req('PUT', '/v1/config/sales_b2c.returns?scope=tenant', { value: { managerLimit: '100' } }, { 'if-match': '0' }));
    const o = await delivered(w);
    const big = ok(await w.rep.c.post(R, { orderId: o.id, reasonCode: 'wrong_item', lines: [{ orderLineId: line(o), quantity: '2' }] }), 201);
    expect(ok(await w.mgr.c.get(`${R}/${String(big.id)}`)).canDecide).toBe(false);
    expect((await w.mgr.c.post(`${R}/${String(big.id)}/decision`, { decision: 'approve' })).status).toBe(403);
    const admins = await sql(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND source_type = 'return'`, [w.tenantId]);
    expect(admins[0]?.n).toBe(1);
    expect(ok(await w.c.post(`${R}/${String(big.id)}/decision`, { decision: 'reject', note: 'Kullanılmış' }))).toMatchObject({ status: 'rejected' });
    expect((ok(await w.rep.c.get(`${O}/${String(o.id)}`)).lines as Json[])[0]).toMatchObject({ returnedQuantity: '0' });
    const again = ok(await w.rep.c.post(R, { orderId: o.id, reasonCode: 'other', lines: [{ orderLineId: line(o), quantity: '1' }] }), 201);
    expect((await w.mgr.c.post(`${R}/${String(again.id)}/cancel`)).status).toBe(403);
    expect(ok(await w.rep.c.post(`${R}/${String(again.id)}/cancel`))).toMatchObject({ status: 'cancelled', canDecide: false });
    expect((ok(await w.rep.c.get(`${R}?orderId=${String(o.id)}`)).data as Json[]).map((x) => x.status)).toEqual(['cancelled', 'rejected']);
  });
});

describe('KVKK requests for a customer', () => {
  it('export holds everything; anonymizing removes the person, keeps the orders, withdraws consent', async () => {
    const w = await setup();
    ok(await w.rep.c.post(`${C}/${w.customer}/consents`, { channel: 'email', status: 'granted', source: 'web_form' }));
    const o = ok(await order(w), 201);
    expect((await w.rep.c.get(`${C}/${w.customer}/export`)).status).toBe(403);
    const v = ok(await w.rep.c.get(`/v1/contacts/${w.customer}`));
    ok(await w.rep.c.req('PATCH', `/v1/contacts/${w.customer}`, { lastName: 'Demirci' }, { 'if-match': `"${String(v.version)}"` }));
    ok(await w.rep.c.req('PATCH', `/v1/contacts/${w.customer}`, { lastName: 'Demir' }, { 'if-match': `"${String(Number(v.version) + 1)}"` }));
    const ex = ok(await w.c.get(`${C}/${w.customer}/export`));
    expect(ex).toMatchObject({ customer: { firstName: 'Elif', lastName: 'Demir', contactPoints: [{ kind: 'email', value: 'elif@ornek.test' }] }, addresses: [{ label: 'Ev' }] });
    expect((ex.orders as Json[]).map((x) => x.id)).toEqual([o.id]);
    expect((ex.consents as Json[]).map((x) => x.status)).toEqual(['granted']);

    expect((await w.c.post(`${C}/${w.customer}/anonymize`, { confirmName: 'Başka Biri' })).body.code).toBe('CONFIRM_MISMATCH');
    const after = ok(await w.c.post(`${C}/${w.customer}/anonymize`, { confirmName: 'elif demir' }));
    expect(after).toMatchObject({ fullName: expect.stringMatching(/^Anonim #/), addresses: [], tags: [] });
    expect((after.consents as Json[]).find((c) => c.channel === 'email')).toMatchObject({ consent: { status: 'withdrawn' } });
    const contact = ok(await w.c.get(`/v1/contacts/${w.customer}`));
    expect(contact.contactPoints).toEqual([]);
    expect(ok(await w.c.get(`${O}/${String(o.id)}`))).toMatchObject({ shippingAddress: null, totals: { total: '240.00' } });
    expect(ok(await w.c.get(`${C}/${w.customer}/reachability?channel=email`))).toMatchObject({ allowed: false });
    expect((await order(w)).body.code).toBe('NOT_A_CUSTOMER');
    const diffs = (ok(await w.c.get(`/v1/contacts/${w.customer}/timeline`)).data as Json[]).filter((e) => e.kind === 'customer').map((e) => Object.values(e.diff as Json));
    expect(diffs.flat().every((d) => JSON.stringify(d) === JSON.stringify({ from: null, to: null }))).toBe(true);
    const audits = await sql(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'customer.%' ORDER BY at`, [w.tenantId]);
    expect(audits.map((a) => a.action)).toEqual(['customer.exported', 'customer.anonymized']);
    // An edit made before the erasure cannot bring the name back through a later export.
    const later = ok(await w.c.get(`${C}/${w.customer}/export`));
    expect(JSON.stringify(later)).not.toMatch(/Elif|Demir|elif@ornek/);
  });
});
