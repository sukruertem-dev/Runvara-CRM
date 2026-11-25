import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { QuotesService } from '../src/modules/quotes/quotes.service';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P9a (docs/p9-plan.md §1–6, ADR-0021): quotes, immutable versions, discount approval, PDF, sending.

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

async function member(admin: Client, role: string, teamId?: string, teamRole = 'member') {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: email.split('@')[0] }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  if (teamId) ok(await admin.put(`/v1/teams/${teamId}/members/${userId}`, { role: teamRole }));
  return { c, userId, email };
}

/** Team with a manager and two reps; two priced products (100 with 20 % tax, 50 without); the rep's opportunity. */
async function setup() {
  const admin = await signupAndLogin(h);
  for (const m of ['crm', 'sales_b2b', 'sales_tracking']) ok(await admin.c.post(`/v1/modules/${m}/enable`));
  const team = String(ok(await admin.c.post('/v1/teams', { name: 'Saha' }), 201).id);
  const lead = await member(admin.c, 'manager', team, 'manager');
  const rep = await member(admin.c, 'sales_rep', team);
  const peer = await member(admin.c, 'sales_rep', team);
  const tax = String(ok(await admin.c.post('/v1/tax-rates', { name: 'KDV', rate: '20' }), 201).id);
  const product = async (sku: string, taxRateId: string | null) => String(ok(await admin.c.post('/v1/products', { sku, name: `Ürün ${sku}`, unit: 'adet', segments: ['b2b'], taxRateId }), 201).id);
  const a = await product('A-1', tax);
  const b = await product('B-1', null);
  const unpriced = await product('C-1', null);
  const list = String(ok(await admin.c.post('/v1/price-lists', { name: 'Genel', currency: 'TRY' }), 201).id);
  ok(await admin.c.put(`/v1/price-lists/${list}/products/${a}`, { breaks: [{ minQty: '1', unitPrice: '100' }] }), 204);
  ok(await admin.c.put(`/v1/price-lists/${list}/products/${b}`, { breaks: [{ minQty: '1', unitPrice: '50' }] }), 204);
  const account = String(ok(await rep.c.post('/v1/accounts', { name: 'Anadolu Lojistik', segments: ['b2b'] }), 201).id);
  const opp = String(ok(await rep.c.post('/v1/opportunities', { name: 'Filo anlaşması', segment: 'b2b', amount: '1000', currency: 'TRY', accountId: account }), 201).id);
  return { ...admin, team, lead, rep, peer, a, b, unpriced, list, opp, account };
}
type W = Awaited<ReturnType<typeof setup>>;
const VALID = '2099-12-31';
const start = async (w: W) => ok(await w.rep.c.post(Q, { opportunityId: w.opp }), 201);
const save = (c: Client, q: Json, body: Json) => c.req('PUT', `${Q}/${String(q.id)}/draft`, { validUntil: VALID, ...body }, { 'if-match': `"${String(q.version)}"` });
/** A draft with two of A and one of B, with `discount` on the first line. */
async function drafted(w: W, discount = '0') {
  return ok(await save(w.rep.c, await start(w), { lines: [{ productId: w.a, quantity: '2', discountPercent: discount }, { productId: w.b, quantity: '1' }] }));
}
const submit = (w: W, q: Json, reason?: string) => w.rep.c.post(`${Q}/${String(q.id)}/submit`, reason ? { reason } : {});
const send = (w: W, q: Json, to = ['musteri@firma.test']) => w.rep.c.post(`${Q}/${String(q.id)}/send`, { to, message: 'Merhaba' });

describe('quote draft', () => {
  it('numbers quotes, takes prices and taxes from the catalogue and computes totals', async () => {
    const w = await setup();
    const q = await drafted(w, '5');
    expect(q.number).toMatch(/^T-\d{4}-00001$/);
    expect(q).toMatchObject({ status: 'draft', currentVersion: 1, currency: 'TRY', total: '278.00', canEdit: true });
    expect(q.content).toMatchObject({
      totals: { subtotal: '250.00', discount: '10.00', net: '240.00', tax: '38.00', total: '278.00' }, approvalPercent: '5.00',
      customer: { account: 'Anadolu Lojistik' }, lines: [{ sku: 'A-1', listPrice: '100', unitPrice: '100', net: '190.00', tax: '38.00' }, { sku: 'B-1', net: '50.00', tax: '0.00' }],
    });
    expect((await start(w)).number).toMatch(/-00002$/);
    // A price below the list counts as a discount; a product without a price needs one.
    const cut = ok(await save(w.rep.c, q, { lines: [{ productId: w.a, quantity: '1', unitPrice: '70' }] }));
    expect((cut.content as Json).approvalPercent).toBe('30.00');
    expect((await save(w.rep.c, cut, { lines: [{ productId: w.unpriced, quantity: '1' }] })).body).toMatchObject({ code: 'QUOTE_PRICE_MISSING', line: 0 });
    ok(await save(w.rep.c, cut, { lines: [{ productId: w.unpriced, quantity: '1', unitPrice: '9.5' }] }));
    // Optimistic concurrency.
    expect((await save(w.rep.c, cut, { lines: [] })).status).toBe(412);
    expect((await w.rep.c.put(`${Q}/${String(cut.id)}/draft`, { validUntil: VALID, lines: [] })).status).toBe(428);
  });

  it('is as visible as the opportunity; module, segment, permission and amount rules hold', async () => {
    const w = await setup();
    const q = await drafted(w);
    const url = `${Q}/${String(q.id)}`;
    for (const path of [url, `${url}/versions/1`, `${url}/versions/1/pdf`]) expect((await w.peer.c.get(path)).status, path).toBe(404);
    expect(rows(ok(await w.peer.c.get(Q)))).toEqual([]);
    expect((await w.peer.c.get(`${Q}?opportunityId=${w.opp}`)).status).toBe(404);
    expect((await w.peer.c.post(`${url}/submit`, {})).status).toBe(404);
    expect(rows(ok(await w.lead.c.get(`${Q}?opportunityId=${w.opp}&status=draft`)))).toHaveLength(1);
    // A reader without the quote permission sees it and may not change it.
    const analyst = await member(w.c, 'analyst');
    expect(ok(await analyst.c.get(url)).canEdit).toBe(false);
    expect((await analyst.c.post(`${url}/submit`, {})).status).toBe(403);
    expect((await analyst.c.post(Q, { opportunityId: w.opp })).status).toBe(403);
    // B2C opportunities have no quotes; another tenant sees nothing.
    const b2c = String(ok(await w.rep.c.post('/v1/opportunities', { name: 'Perakende', segment: 'b2c' }), 201).id);
    expect((await w.rep.c.post(Q, { opportunityId: b2c })).body.code).toBe('SEGMENT_NOT_ALLOWED');
    const other = await setup();
    expect((await other.c.get(url)).status).toBe(404);
    // The opportunity in the bin takes its quotes with it; the module switched off closes the door.
    ok(await w.c.post('/v1/modules/sales_b2b/disable?cascade=true'));
    expect((await w.rep.c.get(url)).body.code).toBe('MODULE_DISABLED');
  });
});

describe('approval and versions', () => {
  it('within the own authority it is approved at once; above it goes to the manager and locks the version', async () => {
    const w = await setup();
    expect(ok(await submit(w, await drafted(w, '8')))).toMatchObject({ status: 'approved' });
    const q = await drafted(w, '12');
    expect((await submit(w, q)).body).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'approval_reason_required', percent: '12.00' });
    const waiting = ok(await submit(w, q, 'Rakip teklifi'));
    expect(waiting.status).toBe('pending_approval');
    expect((await save(w.rep.c, waiting, { lines: [] })).body).toMatchObject({ code: 'QUOTE_STATE', quoteStatus: 'pending_approval' });
    expect((await send(w, q)).body.code).toBe('QUOTE_STATE');
    const [req] = rows(ok(await w.lead.c.get('/v1/approvals')));
    expect(req).toMatchObject({ percent: '12.00', quote: { id: q.id, number: q.number, version: 1 }, canDecide: true });

    // Rejected: the same version opens again; asked anew and approved: it may be sent.
    ok(await w.lead.c.post(`/v1/approvals/${String(req?.id)}/decision`, { decision: 'reject' }));
    const back = ok(await w.rep.c.get(`${Q}/${String(q.id)}`));
    expect(back).toMatchObject({ status: 'draft', currentVersion: 1 });
    const again = ok(await save(w.rep.c, back, { lines: [{ productId: w.a, quantity: '2', discountPercent: '10' }] }));
    ok(await submit(w, again, 'Yeniden'));
    const [second] = rows(ok(await w.lead.c.get('/v1/approvals')));
    ok(await w.lead.c.post(`/v1/approvals/${String(second?.id)}/decision`, { decision: 'approve' }));
    expect(ok(await w.rep.c.get(`${Q}/${String(q.id)}`)).status).toBe('approved');
  });

  it('two quotes of one opportunity may wait at once; withdrawing reopens its own', async () => {
    const w = await setup();
    const one = await drafted(w, '12');
    const two = await drafted(w, '13');
    ok(await submit(w, one, 'a'));
    ok(await submit(w, two, 'b'));
    const mine = rows(ok(await w.rep.c.get('/v1/approvals?box=mine')));
    expect(mine).toHaveLength(2);
    const first = mine.find((x) => (x.quote as Json).id === one.id);
    ok(await w.rep.c.post(`/v1/approvals/${String(first?.id)}/cancel`));
    expect(ok(await w.rep.c.get(`${Q}/${String(one.id)}`)).status).toBe('draft');
    expect(ok(await w.rep.c.get(`${Q}/${String(two.id)}`)).status).toBe('pending_approval');
  });

  it('the discount is measured against the list prices at submission', async () => {
    const w = await setup();
    const q = await drafted(w);
    ok(await w.c.put(`/v1/price-lists/${w.list}/products/${w.a}`, { breaks: [{ minQty: '1', unitPrice: '125' }] }), 204);
    expect((await submit(w, q)).body).toMatchObject({ reason: 'approval_reason_required', percent: '20.00' });
    expect(ok(await w.rep.c.get(`${Q}/${String(q.id)}`)).total).toBe('290.00');
  });

  it('a sent version cannot be changed, not even by the application role; a revision is a new draft', async () => {
    const w = await setup();
    const q = await drafted(w);
    ok(await submit(w, q));
    const sent = ok(await send(w, q));
    expect(sent).toMatchObject({ status: 'sent', content: { sentTo: ['musteri@firma.test'], sentBy: { id: w.rep.userId } } });
    const version = String((await sql(`SELECT id FROM quote_versions WHERE quote_id = $1`, [q.id]))[0]?.id);
    const run = (text: string) => h.db.withTenant({ tenantId: w.tenantId, userId: w.rep.userId, segments: ['b2b'] }, (tx) => tx.execute(text)).then(() => 'changed', (e: unknown) => String((e as { cause?: Error }).cause?.message ?? e));
    expect(await run(`UPDATE quote_versions SET intro = 'x' WHERE id = '${version}'`)).toMatch(/immutable/);
    expect(await run(`UPDATE quote_versions SET locked_at = NULL, sent_at = NULL WHERE id = '${version}'`)).toMatch(/immutable/);
    expect(await run(`DELETE FROM quote_versions WHERE id = '${version}'`)).toMatch(/permission denied|not deleted/);
    expect(await run(`DELETE FROM quote_lines WHERE quote_version_id = '${version}'`)).toMatch(/locked/);
    expect(await run(`UPDATE quote_lines SET unit_price = 1 WHERE quote_version_id = '${version}'`)).toMatch(/permission denied|replaced/);
    expect(await run(`DELETE FROM quote_documents WHERE quote_version_id = '${version}'`)).toMatch(/permission denied|append-only/);

    const next = ok(await w.rep.c.post(`${Q}/${String(q.id)}/versions`), 201);
    expect(next).toMatchObject({ status: 'draft', currentVersion: 2, total: '290.00' });
    ok(await save(w.rep.c, next, { lines: [{ productId: w.a, quantity: '1' }] }));
    expect(ok(await w.rep.c.get(`${Q}/${String(q.id)}/versions/1`))).toMatchObject({ totals: { total: '290.00' } });
    expect((ok(await w.rep.c.get(`${Q}/${String(q.id)}`)).versions as Json[]).map((v) => [v.version, v.total])).toEqual([[2, '120.00'], [1, '290.00']]);
  });

  it('a locked version keeps its content while it waits', async () => {
    const w = await setup();
    const q = await drafted(w, '12');
    ok(await submit(w, q, 'x'));
    const run = (text: string) => h.db.withTenant({ tenantId: w.tenantId, userId: w.rep.userId, segments: ['b2b'] }, (tx) => tx.execute(text)).then(() => 'changed', (e: unknown) => String((e as { cause?: Error }).cause?.message ?? e));
    expect(await run(`UPDATE quote_versions SET discount_percent = 5 WHERE quote_id = '${String(q.id)}'`)).toMatch(/locked/);
    expect(await run(`DELETE FROM quote_lines WHERE quote_version_id IN (SELECT id FROM quote_versions WHERE quote_id = '${String(q.id)}')`)).toMatch(/locked/);
  });
});

describe('document, sending, outcome', () => {
  it('previews a draft, stores the sent document and mails it with the sender as reply address', async () => {
    const w = await setup();
    const q = await drafted(w);
    const pdf = (c: Client) => c.raw('GET', `${Q}/${String(q.id)}/versions/1/pdf`);
    const preview = await pdf(w.rep.c);
    expect([preview.statusCode, preview.headers['content-type']]).toEqual([200, 'application/pdf']);
    expect(preview.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await send(w, q)).body.code).toBe('QUOTE_STATE');
    ok(await submit(w, q));
    ok(await send(w, q, ['Musteri@Firma.test', 'musteri@firma.test', 'ikinci@firma.test']));
    expect((await send(w, q)).body.code).toBe('QUOTE_STATE');
    const job = h.mailer.last('quote', 'musteri@firma.test');
    if (job.template !== 'quote') throw new Error('wrong mail');
    expect(job).toMatchObject({ replyTo: w.rep.email, vars: { number: q.number, message: 'Merhaba', total: '290.00 TRY' }, attachment: { fileName: `${String(q.number)}-v1.pdf` } });
    expect(h.mailer.jobs.filter((j) => j.template === 'quote' && j.vars.number === q.number && j.vars.tenantName === job.vars.tenantName)).toHaveLength(2);
    const stored = await pdf(w.lead.c);
    expect(stored.rawPayload.equals(Buffer.from(job.attachment.base64, 'base64'))).toBe(true);
    expect((await pdf(w.peer.c)).statusCode).toBe(404);
  });

  it('records the answer once, writes timeline and events without amounts, and expires on time', async () => {
    const w = await setup();
    const q = await drafted(w);
    ok(await submit(w, q));
    expect((await w.rep.c.post(`${Q}/${String(q.id)}/outcome`, { outcome: 'accepted' })).body.code).toBe('QUOTE_STATE');
    ok(await send(w, q));
    expect(ok(await w.rep.c.post(`${Q}/${String(q.id)}/outcome`, { outcome: 'accepted', reason: 'İmzalandı' }))).toMatchObject({ status: 'accepted', outcomeReason: 'İmzalandı' });
    expect((await w.rep.c.post(`${Q}/${String(q.id)}/outcome`, { outcome: 'rejected' })).body.code).toBe('QUOTE_STATE');
    expect((await w.rep.c.post(`${Q}/${String(q.id)}/versions`)).body.code).toBe('QUOTE_STATE');
    const timeline = rows(ok(await w.rep.c.get(`/v1/opportunities/${w.opp}/timeline`))).filter((e) => e.kind === 'quote').map((e) => (e.data as Json).action);
    expect(timeline).toEqual(['accepted', 'sent', 'submitted', 'created']);
    const events = await sql(`SELECT type, payload FROM outbox_events WHERE tenant_id = $1 AND type LIKE 'quote.%' ORDER BY id`, [w.tenantId]);
    expect(events.map((e) => e.type)).toEqual(['quote.created', 'quote.submitted', 'quote.sent', 'quote.accepted']);
    expect(JSON.stringify(events)).not.toMatch(/290|musteri/);

    const late = await drafted(w);
    ok(await submit(w, late));
    ok(await send(w, late));
    await sql(`ALTER TABLE quote_versions DISABLE TRIGGER quote_versions_guard`);
    await sql(`UPDATE quote_versions SET valid_until = '2020-01-01' WHERE quote_id = $1`, [late.id]);
    await sql(`ALTER TABLE quote_versions ENABLE TRIGGER quote_versions_guard`);
    expect((await w.rep.c.post(`${Q}/${String(late.id)}/outcome`, { outcome: 'accepted' })).body).toMatchObject({ code: 'QUOTE_STATE', quoteStatus: 'expired' });
    expect(await h.app.get(QuotesService).expireDue()).toBeGreaterThan(0);
    expect(ok(await w.rep.c.get(`${Q}/${String(late.id)}`)).status).toBe('expired');
    const revived = ok(await w.rep.c.post(`${Q}/${String(late.id)}/versions`), 201);
    expect(String(revived.validUntil) > '2026-01-01').toBe(true);
  });

  it('the internal note mentions people who can see the opportunity', async () => {
    const w = await setup();
    const q = await drafted(w);
    const note = (id: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { kind: 'user', id } }] }] });
    expect((await w.rep.c.put(`${Q}/${String(q.id)}/note`, { note: note(w.peer.userId) })).body.code).toBe('MENTION_TARGET_NO_ACCESS');
    ok(await w.rep.c.put(`${Q}/${String(q.id)}/note`, { note: note(w.lead.userId) }));
    const [n] = rows(ok(await w.lead.c.get('/v1/notifications'))).filter((x) => x.kind === 'mention');
    expect(n).toMatchObject({ source: { type: 'quote', id: q.id }, link: `/sales/b2b/quotes/${String(q.id)}` });
    ok(await w.rep.c.put(`${Q}/${String(q.id)}/note`, { note: null }));
    expect(rows(ok(await w.lead.c.get('/v1/notifications'))).filter((x) => x.kind === 'mention')).toEqual([]);
  });

  it('the template decides prefix, validity and standard texts', async () => {
    const w = await setup();
    ok(await w.c.req('PUT', '/v1/config/sales_b2b.quote_template?scope=tenant', { value: { prefix: 'FLX', validDays: 10, terms: 'Peşin' } }, { 'if-match': '0' }));
    const q = await start(w);
    expect(q.number).toMatch(/^FLX-/);
    expect(q.content).toMatchObject({ terms: 'Peşin' });
  });
});
