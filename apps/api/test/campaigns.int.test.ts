import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { RfmService } from '../src/modules/customers/rfm.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P9f (docs/p9-plan.md §39–46): campaigns and coupons with the conflict rule, consent-gated campaign messages,
// RFM and the built-in B2C automations.

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
const K = '/v1/sales/b2c/campaigns';
const O = '/v1/sales/b2c/orders';
const C = '/v1/sales/b2c/customers';
const today = new Date().toISOString().slice(0, 10);

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
  const tax = String(ok(await admin.c.post('/v1/tax-rates', { name: 'KDV', rate: '20' }), 201).id);
  const product = String(ok(await admin.c.post('/v1/products', { sku: 'AYK-1', name: 'Koşu ayakkabısı', unit: 'adet', segments: ['b2c'], taxRateId: tax }), 201).id);
  const list = String(ok(await admin.c.post('/v1/price-lists', { name: 'Perakende', currency: 'TRY' }), 201).id);
  ok(await admin.c.put(`/v1/price-lists/${list}/products/${product}`, { breaks: [{ minQty: '1', unitPrice: '100' }] }), 204);
  const customer = async (first: string, email: string, opts: { tags?: string[]; consent?: boolean } = {}) => {
    const id = String(ok(await rep.c.post('/v1/contacts', { firstName: first, lastName: 'Müşteri', segments: ['b2c'], contactPoints: [{ kind: 'email', value: email }] }), 201).id);
    if (opts.tags) ok(await rep.c.req('PUT', `${C}/${id}/profile`, { preferredChannel: null, language: null, tags: opts.tags }, { 'if-match': '"0"' }));
    if (opts.consent) ok(await rep.c.post(`${C}/${id}/consents`, { channel: 'email', status: 'granted', source: 'web_form' }));
    return id;
  };
  return { ...admin, mgr, rep, product, customer };
}
type W = Awaited<ReturnType<typeof setup>>;
const order = (w: W, customerId: string, extra: Json = {}) => w.rep.c.post(O, { customerId, channel: 'web', lines: [{ productId: w.product, quantity: '2' }], ...extra });
const campaign = (c: Client, extra: Json = {}) => c.post(K, { name: 'Yaz', startsOn: today, endsOn: '2099-12-31', ...extra });

describe('campaigns and coupons (B2C-04)', () => {
  it('a Manager’s campaign waits for an Admin; reps only read', async () => {
    const w = await setup();
    expect((await campaign(w.rep.c)).status).toBe(403);
    const draft = ok(await campaign(w.mgr.c, { discountPercent: '5' }), 201);
    expect(draft).toMatchObject({ status: 'draft', canSubmit: true, canApprove: false });
    expect(ok(await w.mgr.c.post(`${K}/${String(draft.id)}/submit`))).toMatchObject({ status: 'pending_approval' });
    expect((await w.mgr.c.post(`${K}/${String(draft.id)}/approve`)).status).toBe(403);
    expect((await w.mgr.c.req('PATCH', `${K}/${String(draft.id)}`, { name: 'x' }, { 'if-match': `"${String(Number(draft.version) + 1)}"` })).body.code).toBe('CAMPAIGN_STATE');
    const notes = await sql(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND source_type = 'campaign'`, [w.tenantId]);
    expect(notes[0]?.n).toBe(1);
    expect(ok(await w.c.get(`${K}/${String(draft.id)}`)).canApprove).toBe(true);
    expect(ok(await w.c.post(`${K}/${String(draft.id)}/approve`))).toMatchObject({ status: 'active', approvedBy: { id: expect.any(String) } });
    expect((ok(await w.rep.c.get(K)).data as Json[]).map((c) => c.status)).toEqual(['active']);
    // An Admin's own campaign starts at once.
    const own = ok(await campaign(w.c), 201);
    expect(ok(await w.c.post(`${K}/${String(own.id)}/submit`))).toMatchObject({ status: 'active' });
  });

  it('a coupon applies within its limits; discounts add up unless one is exclusive', async () => {
    const w = await setup();
    const a = await w.customer('Ayşe', 'ayse@ornek.test');
    const b = await w.customer('Burak', 'burak@ornek.test');
    const k = ok(await campaign(w.c, { name: 'Kupon' }), 201);
    ok(await w.c.post(`${K}/${String(k.id)}/submit`));
    const coupon = ok(await w.c.post(`${K}/${String(k.id)}/coupons`, { code: 'yaz10', discountPercent: '10', maxUses: 1 }), 201);
    expect(coupon).toMatchObject({ code: 'YAZ10', uses: 0 });
    expect((await w.c.post(`${K}/${String(k.id)}/coupons`, { code: 'YAZ10', discountPercent: '5' })).status).toBe(409);
    expect(ok(await w.rep.c.get(`/v1/sales/b2c/coupons/check?code=YAZ10&customerId=${a}`))).toMatchObject({ valid: true, discountPercent: '10' });
    expect(ok(await w.rep.c.get(`/v1/sales/b2c/coupons/check?code=YOK&customerId=${a}`))).toMatchObject({ valid: false, reason: 'unknown' });
    const o = ok(await order(w, a, { couponCode: 'yaz10' }), 201);
    expect(o).toMatchObject({ totals: { subtotal: '200.00', discount: '20.00', net: '180.00', tax: '36.00', total: '216.00' }, discount: { percent: '10', coupon: 'YAZ10', campaign: { id: k.id } } });
    expect((await order(w, b, { couponCode: 'YAZ10' })).body).toMatchObject({ code: 'COUPON_INVALID', reason: 'used_up' });
    expect(ok(await w.c.get(`${K}/${String(k.id)}`)).coupons).toMatchObject([{ uses: 1 }]);

    // An automatic 5 % campaign for everyone plus a 10 % coupon: 15 %; an exclusive one: the larger alone.
    const auto = ok(await campaign(w.c, { name: 'Herkese', discountPercent: '5' }), 201);
    ok(await w.c.post(`${K}/${String(auto.id)}/submit`));
    const k2 = ok(await campaign(w.c, { name: 'Kupon 2' }), 201);
    ok(await w.c.post(`${K}/${String(k2.id)}/submit`));
    ok(await w.c.post(`${K}/${String(k2.id)}/coupons`, { code: 'EK10', discountPercent: '10', perCustomerLimit: 5 }), 201);
    expect(ok(await order(w, b), 201).discount).toMatchObject({ percent: '5', campaign: { id: auto.id }, coupon: null });
    expect(ok(await order(w, b, { couponCode: 'EK10' }), 201).discount).toMatchObject({ percent: '15' });
    const ex = ok(await campaign(w.c, { name: 'Tek', exclusive: true }), 201);
    ok(await w.c.post(`${K}/${String(ex.id)}/submit`));
    ok(await w.c.post(`${K}/${String(ex.id)}/coupons`, { code: 'TEK20', discountPercent: '20', perCustomerLimit: 5 }), 201);
    expect(ok(await order(w, b, { couponCode: 'TEK20' }), 201).discount).toMatchObject({ percent: '20', coupon: 'TEK20' });
    ok(await w.c.post(`${K}/${String(ex.id)}/cancel`));
    expect((await order(w, b, { couponCode: 'TEK20' })).body).toMatchObject({ code: 'COUPON_INVALID', reason: 'inactive' });
  });

  it('the message reaches only targeted customers with e-mail consent; the others are counted with the reason (AC-G5-2)', async () => {
    const w = await setup();
    const vipOk = await w.customer('Ayşe', 'ayse@ornek.test', { tags: ['VIP'], consent: true });
    await w.customer('Burak', 'burak@ornek.test', { tags: ['VIP'] });
    await w.customer('Cem', 'cem@ornek.test', { consent: true });
    const k = ok(await campaign(w.c, { name: 'VIP', audienceTags: ['VIP'], message: { subject: 'VIP fırsatı', body: 'Size özel.' } }), 201);
    expect((await w.c.post(`${K}/${String(k.id)}/send`)).body.code).toBe('CAMPAIGN_STATE');
    ok(await w.c.post(`${K}/${String(k.id)}/submit`));
    const aud = ok(await w.c.get(`${K}/${String(k.id)}/audience`));
    expect(aud).toMatchObject({ total: 2, reachable: 1, blocked: { no_consent: 1 } });
    expect(ok(await w.c.post(`${K}/${String(k.id)}/send`))).toEqual({ sent: 1, blocked: { no_consent: 1 } });
    expect(h.mailer.jobs.filter((j) => j.template === 'customer_message' && j.vars.subject === 'VIP fırsatı').map((j) => j.to)).toEqual(['ayse@ornek.test']);
    expect((await w.c.post(`${K}/${String(k.id)}/send`)).body.code).toBe('CAMPAIGN_STATE');
    expect(ok(await w.c.get(`${K}/${String(k.id)}`))).toMatchObject({ deliveries: { sent: 1, blocked: { no_consent: 1 } }, canSend: false });
    const rows = await sql(`SELECT customer_id::text AS c, outcome FROM campaign_deliveries WHERE tenant_id = $1 AND outcome = 'sent'`, [w.tenantId]);
    expect(rows.map((r) => r.c)).toEqual([vipOk]);
  });
});

describe('RFM and B2C automations (B2C-07)', () => {
  const backdate = (orderId: string, days: number) => sql(`
    SET session_replication_role = replica;
    UPDATE orders SET created_at = now() - interval '${String(days)} days' WHERE id = '${orderId}';
    UPDATE order_status_history SET at = now() - interval '${String(days)} days' WHERE order_id = '${orderId}';
    SET session_replication_role = origin;`);

  it('segments from recency and frequency; entering "hibernating" opens a win-back task and e-mails only with consent', async () => {
    const w = await setup();
    ok(await w.c.req('PUT', '/v1/config/sales_b2c.automations?scope=tenant', { value: { winback: { enabled: true, task: true, subject: 'Sizi özledik', body: 'Geri dönün.' } } }, { 'if-match': '0' }));
    const sleepy = await w.customer('Uyku', 'uyku@ornek.test', { consent: true });
    const quiet = await w.customer('Sessiz', 'sessiz@ornek.test');
    const fresh = await w.customer('Yeni', 'yeni@ornek.test');
    for (const id of [sleepy, quiet]) await backdate(String(ok(await order(w, id), 201).id), 130);
    ok(await order(w, fresh), 201);
    expect((await w.rep.c.post('/v1/sales/b2c/rfm/recompute')).status).toBe(403);
    const s = ok(await w.c.post('/v1/sales/b2c/rfm/recompute'));
    expect((s.segments as Json[]).map((x) => [x.segment, x.count])).toEqual([['hibernating', 2], ['new', 1]]);
    expect(ok(await w.rep.c.get(`${C}/${sleepy}`)).rfm).toMatchObject({ segment: 'hibernating', frequency: 1, recencyDays: 130 });
    const tasks = await sql(`SELECT title FROM tasks WHERE tenant_id = $1 AND title LIKE 'Geri kazanım:%' ORDER BY title`, [w.tenantId]);
    expect(tasks.map((x) => x.title)).toEqual(['Geri kazanım: Sessiz Müşteri', 'Geri kazanım: Uyku Müşteri']);
    expect(h.mailer.jobs.filter((j) => j.template === 'customer_message' && j.vars.subject === 'Sizi özledik').map((j) => j.to)).toEqual(['uyku@ornek.test']);
    const runs = await sql(`SELECT emailed, blocked FROM b2c_automation_runs WHERE tenant_id = $1 AND kind = 'winback' ORDER BY emailed`, [w.tenantId]);
    expect(runs).toEqual([{ emailed: false, blocked: 'no_consent' }, { emailed: true, blocked: null }]);
    // Run again: nothing new.
    await h.app.get(RfmService).recomputeTenant(w.tenantId);
    expect((await sql(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1 AND title LIKE 'Geri kazanım:%'`, [w.tenantId]))[0]?.n).toBe(2);
    expect(ok(await w.rep.c.get('/v1/sales/b2c/rfm?segment=hibernating')).customers).toHaveLength(2);
  });

  it('an abandoned order and a repeat purchase reminder, once each, with consent only', async () => {
    const w = await setup();
    ok(await w.c.req('PUT', '/v1/config/sales_b2c.automations?scope=tenant', { value: {
      abandonedOrder: { enabled: true, afterHours: 24, subject: 'Sepet', body: 'Siparişiniz bekliyor.' },
      repeatPurchase: { enabled: true, afterDays: 30, subject: 'Tekrar', body: 'Yeniden bekleriz.' },
    } }, { 'if-match': '0' }));
    const a = await w.customer('Ayşe', 'ayse@ornek.test', { consent: true });
    const b = await w.customer('Burak', 'burak@ornek.test');
    const open = String(ok(await order(w, a), 201).id);
    await backdate(open, 2);
    await backdate(String(ok(await order(w, b), 201).id), 2);
    // Cem bought once, long ago, and nothing since: a repeat-purchase reminder (Ayşe's open order is newer than any of hers).
    const c = await w.customer('Cem', 'cem@ornek.test', { consent: true });
    const done = ok(await order(w, c), 201);
    ok(await w.rep.c.post(`${O}/${String(done.id)}/step`, { step: 'confirm' }));
    for (const s of ['prepare', 'ship', 'deliver']) ok(await w.mgr.c.post(`${O}/${String(done.id)}/step`, { step: s }));
    await backdate(String(done.id), 31);
    const svc = h.app.get(RfmService);
    expect(await svc.automateTenant(w.tenantId)).toBe(3);
    expect(await svc.automateTenant(w.tenantId)).toBe(0);
    const mails = h.mailer.jobs.filter((j) => j.template === 'customer_message' && ['Sepet', 'Tekrar'].includes(j.vars.subject)).map((j) => `${"subject" in j.vars ? j.vars.subject : ""}:${j.to}`);
    expect(mails.sort()).toEqual(['Sepet:ayse@ornek.test', 'Tekrar:cem@ornek.test']);
  });
});
