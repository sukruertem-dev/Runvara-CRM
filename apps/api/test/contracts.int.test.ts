import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { B2bService } from '../src/modules/quotes/b2b.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P9b (docs/p9-plan.md §8–13): sales pipelines, contracts with renewal, B2B orders.

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
const rows = (b: Json): Json[] => b.data as Json[];
const Q = '/v1/sales/b2b/quotes';
const C = '/v1/sales/b2b/contracts';
const O = '/v1/sales/b2b/orders';

async function member(admin: Client, role: string) {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: email.split('@')[0] }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  return { c, userId };
}

/** A rep's B2B opportunity with an accepted quote, then won. */
async function setup() {
  const admin = await signupAndLogin(h);
  for (const m of ['crm', 'sales_b2b']) ok(await admin.c.post(`/v1/modules/${m}/enable`));
  const rep = await member(admin.c, 'sales_rep');
  const peer = await member(admin.c, 'sales_rep');
  const product = String(ok(await admin.c.post('/v1/products', { sku: 'P-1', name: 'Hizmet', unit: 'ay', segments: ['b2b'] }), 201).id);
  const list = String(ok(await admin.c.post('/v1/price-lists', { name: 'Genel', currency: 'TRY' }), 201).id);
  ok(await admin.c.put(`/v1/price-lists/${list}/products/${product}`, { breaks: [{ minQty: '1', unitPrice: '100' }] }), 204);
  const account = String(ok(await rep.c.post('/v1/accounts', { name: 'Anadolu Lojistik', segments: ['b2b'] }), 201).id);
  const opp = String(ok(await rep.c.post('/v1/opportunities', { name: 'Yıllık bakım', segment: 'b2b', amount: '1200', currency: 'TRY', accountId: account }), 201).id);
  const q = ok(await rep.c.post(Q, { opportunityId: opp }), 201);
  const saved = ok(await rep.c.req('PUT', `${Q}/${String(q.id)}/draft`, { validUntil: '2099-12-31', lines: [{ productId: product, quantity: '12', discountPercent: '5' }] }, { 'if-match': `"${String(q.version)}"` }));
  ok(await rep.c.post(`${Q}/${String(saved.id)}/submit`, {}));
  ok(await rep.c.post(`${Q}/${String(saved.id)}/send`, { to: ['musteri@firma.test'] }));
  ok(await rep.c.post(`${Q}/${String(saved.id)}/outcome`, { outcome: 'accepted' }));
  return { ...admin, rep, peer, opp, account, quote: String(saved.id), product };
}
type W = Awaited<ReturnType<typeof setup>>;
const win = async (w: W) => ok(await w.rep.c.post(`/v1/opportunities/${w.opp}/transition`, { transitionKey: 'win' }));

describe('pipelines (B2B-02)', () => {
  it('the Admin adds a segment pipeline; new opportunities of the segment use it; probabilities follow the stage', async () => {
    const w = await setup();
    const workflowId = String(rows(ok(await w.c.get('/v1/pipelines')))[0]?.workflowId);
    expect((await w.rep.c.post('/v1/pipelines', { key: 'kurumsal', name: 'Kurumsal', segment: 'b2b', workflowId })).status).toBe(403);
    const { id } = ok(await w.c.post('/v1/pipelines', { key: 'kurumsal', name: 'Kurumsal', segment: 'b2b', workflowId }), 201) as { id: string };
    expect((await w.c.post('/v1/pipelines', { key: 'kurumsal', name: 'İkinci', segment: 'b2b', workflowId })).status).toBe(409);
    const pipe = rows(ok(await w.c.get('/v1/pipelines'))).find((p) => p.id === id);
    const first = (pipe?.stages as Json[]).find((s) => s.key === 'prospecting');
    ok(await w.c.req('PATCH', `/v1/pipelines/${id}`, { stages: [{ statusId: first?.id, probability: 5 }] }), 204);
    ok(await w.c.req('PATCH', `/v1/pipelines/${id}`, { isDefault: true }), 204);
    const opp = ok(await w.rep.c.post('/v1/opportunities', { name: 'Yeni', segment: 'b2b' }), 201);
    expect(opp).toMatchObject({ pipelineId: id, probability: 5 });
    ok(await w.c.req('PATCH', `/v1/pipelines/${id}`, { stages: [{ statusId: first?.id, probability: 15 }] }), 204);
    expect(ok(await w.rep.c.get(`/v1/opportunities/${String(opp.id)}`)).probability).toBe(15);
    expect((await w.c.req('PATCH', `/v1/pipelines/${id}`, { stages: [{ statusId: '00000000-0000-4000-8000-000000000000', probability: 1 }] })).body.code).toBe('PIPELINE_INVALID');
  });
});

describe('contracts (B2B-06)', () => {
  it('only for a won opportunity; from the accepted quote it takes its value and currency', async () => {
    const w = await setup();
    const body = { opportunityId: w.opp, quoteId: w.quote, startDate: '2026-01-01', endDate: '2026-12-31' };
    expect((await w.rep.c.post(C, body)).body.code).toBe('OPPORTUNITY_NOT_WON');
    await win(w);
    const c = ok(await w.rep.c.post(C, body), 201);
    expect(c).toMatchObject({ number: expect.stringMatching(/^S-\d{4}-00001$/), title: 'Yıllık bakım', value: '1140.00', currency: 'TRY', status: 'active', account: { name: 'Anadolu Lojistik' }, renewalDueOn: '2026-12-01', canEdit: true });
    expect((await w.peer.c.get(`${C}/${String(c.id)}`)).status).toBe(404);
    expect(rows(ok(await w.peer.c.get(C)))).toEqual([]);
    const analyst = await member(w.c, 'analyst');
    expect(ok(await analyst.c.get(`${C}/${String(c.id)}`)).canEdit).toBe(false);
    expect((await analyst.c.post(C, body)).status).toBe(403);
    const changed = ok(await w.rep.c.req('PATCH', `${C}/${String(c.id)}`, { renewalNoticeDays: 60, autoRenew: true }, { 'if-match': `"${String(c.version)}"` }));
    expect(changed).toMatchObject({ renewalDueOn: '2026-11-01', autoRenew: true });
    expect((await w.rep.c.req('PATCH', `${C}/${String(c.id)}`, { note: 'x' }, { 'if-match': `"${String(c.version)}"` })).status).toBe(412);
  });

  it('reminds the owner once with a task, then renews itself or ends at the end of the term', async () => {
    const w = await setup();
    await win(w);
    const past = ok(await w.rep.c.post(C, { opportunityId: w.opp, startDate: '2025-01-01', endDate: '2025-06-30', autoRenew: true }), 201);
    const plain = ok(await w.rep.c.post(C, { opportunityId: w.opp, startDate: '2025-01-01', endDate: '2025-03-31' }), 201);
    const svc = h.app.get(B2bService);
    expect(await svc.runDue()).toBeGreaterThanOrEqual(2);
    const tasks = rows(ok(await w.rep.c.get(`/v1/opportunities/${w.opp}/tasks`))).filter((x) => String(x.title).startsWith('Sözleşme yenileme'));
    expect(tasks).toHaveLength(2);
    expect(ok(await w.rep.c.get(`${C}/${String(plain.id)}`))).toMatchObject({ status: 'ended' });
    const renewed = ok(await w.rep.c.get(`${C}/${String(past.id)}`));
    expect(renewed).toMatchObject({ status: 'renewed', renewedBy: { number: expect.any(String) } });
    const next = ok(await w.rep.c.get(`${C}/${String((renewed.renewedBy as Json).id)}`));
    expect(next).toMatchObject({ startDate: '2025-07-01', endDate: '2025-12-31', renewedFrom: { id: past.id } });
    // The next term is also over: renewed again on later runs; reminders are not repeated.
    await svc.runDue();
    const events = await sql(`SELECT type FROM outbox_events WHERE tenant_id = $1 AND type LIKE 'contract.%' ORDER BY id`, [w.tenantId]);
    expect(events.filter((e) => e.type === 'contract.renewal_due').length).toBeGreaterThanOrEqual(3);
    expect(events.map((e) => e.type)).toContain('contract.renewed');
    expect((await w.rep.c.post(`${C}/${String(past.id)}/renew`, {})).body.code).toBe('CONTRACT_STATE');
  });

  it('is renewed by hand once and terminated within its term', async () => {
    const w = await setup();
    await win(w);
    const c = ok(await w.rep.c.post(C, { opportunityId: w.opp, startDate: '2026-01-01', endDate: '2026-12-31', value: '1000' }), 201);
    const next = ok(await w.rep.c.post(`${C}/${String(c.id)}/renew`, { value: '1100' }), 201);
    expect(next).toMatchObject({ startDate: '2027-01-01', endDate: '2027-12-31', value: '1100.00', renewedFrom: { id: c.id } });
    expect((await w.rep.c.post(`${C}/${String(c.id)}/renew`, {})).body.code).toBe('CONTRACT_STATE');
    expect((await w.rep.c.post(`${C}/${String(next.id)}/terminate`, { on: '2026-06-01', reason: 'x' })).body.code).toBe('VALIDATION_FAILED');
    expect(ok(await w.rep.c.post(`${C}/${String(next.id)}/terminate`, { on: '2027-06-30', reason: 'Müşteri feshetti' }))).toMatchObject({ status: 'terminated', terminatedOn: '2027-06-30', canEdit: false });
    expect(rows(ok(await w.rep.c.get(`${C}?opportunityId=${w.opp}&status=terminated`)))).toHaveLength(1);
  });
});

describe('orders (B2B-06)', () => {
  it('one order per accepted quote of a won opportunity, with the quote’s lines and totals', async () => {
    const w = await setup();
    expect((await w.rep.c.post(O, { quoteId: w.quote })).body.code).toBe('OPPORTUNITY_NOT_WON');
    await win(w);
    const o = ok(await w.rep.c.post(O, { quoteId: w.quote }), 201);
    expect(o).toMatchObject({ number: expect.stringMatching(/^SP-\d{4}-00001$/), segment: 'b2b', status: 'open', totals: { net: '1140.00', total: '1140.00' }, lines: [{ sku: 'P-1', quantity: '12', unitPrice: '100', discountPercent: '5', net: '1140.00' }] });
    expect((await w.rep.c.post(O, { quoteId: w.quote })).status).toBe(409);
    expect((await w.peer.c.get(`${O}/${String(o.id)}`)).status).toBe(404);
    expect((await w.rep.c.post(`${O}/${String(o.id)}/status`, { status: 'cancelled' })).status).toBe(400);
    expect(ok(await w.rep.c.post(`${O}/${String(o.id)}/status`, { status: 'fulfilled' }))).toMatchObject({ status: 'fulfilled', canEdit: false });
    expect((await w.rep.c.post(`${O}/${String(o.id)}/status`, { status: 'cancelled', reason: 'x' })).body.code).toBe('ORDER_STATE');
    // Order lines never change.
    const run = (text: string) => h.db.withTenant({ tenantId: w.tenantId, userId: w.rep.userId, segments: ['b2b'] }, (tx) => tx.execute(text)).then(() => 'changed', (e: unknown) => String((e as { cause?: Error }).cause?.message ?? e));
    expect(await run(`UPDATE order_lines SET quantity = 1 WHERE order_id = '${String(o.id)}'`)).toMatch(/permission denied|append-only/);
    const timeline = rows(ok(await w.rep.c.get(`/v1/opportunities/${w.opp}/timeline`))).filter((e) => e.kind === 'order').map((e) => (e.data as Json).action);
    expect(timeline).toEqual(['fulfilled', 'created']);
    // A B2C-only member cannot see B2B orders even with an admin role.
    const b2c = await member(w.c, 'admin');
    ok(await w.c.put(`/v1/users/${b2c.userId}/segments`, { segments: [{ segment: 'b2c' }] }));
    expect((await b2c.c.get(`${O}/${String(o.id)}`)).status).toBe(404);
  });
});
