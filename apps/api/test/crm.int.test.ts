import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@flexa/db';
import { superQuery } from '@flexa/db/testing';
import { seedDemo } from '../src/seed/demo';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// Faz 3 kabul kriterleri (docs/p3-plan.md): atomic lead conversion, stage probability, merge moves related
// records, tenant + segment isolation on every CRM object.

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

async function crmTenant() {
  const s = await signupAndLogin(h);
  ok(await s.c.post('/v1/modules/crm/enable'));
  return s;
}

async function member(admin: Client, role: string): Promise<{ c: Client; userId: string }> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role });
  const l = await c.post('/v1/auth/login', { email, password: PASSWORD });
  return { c, userId: (l.body.user as { id: string }).id };
}

const counts = async (tenantId: string) =>
  (await superQuery<{ a: number; c: number; o: number; cp: number; lc: number }>(SUPER(), `
    SELECT (SELECT count(*)::int FROM accounts WHERE tenant_id = $1) AS a, (SELECT count(*)::int FROM contacts WHERE tenant_id = $1) AS c,
           (SELECT count(*)::int FROM opportunities WHERE tenant_id = $1) AS o, (SELECT count(*)::int FROM contact_points WHERE tenant_id = $1) AS cp,
           (SELECT count(*)::int FROM lead_conversions WHERE tenant_id = $1) AS lc`, [tenantId]))[0]!;

describe('module gate and basics', () => {
  it('CRM routes answer 404 MODULE_DISABLED until the module is enabled; new tenants get CRM workflows and a pipeline', async () => {
    const { c } = await signupAndLogin(h);
    const off = await c.get('/v1/accounts');
    expect(off.status).toBe(404);
    expect(off.body.code).toBe('MODULE_DISABLED');
    ok(await c.post('/v1/modules/crm/enable'));
    const p = ok(await c.get('/v1/pipelines'));
    const stages = ((p.data as Json[])[0]!.stages as Json[]).map((s) => [s.key, s.probability]);
    expect(stages).toEqual([['prospecting', 10], ['qualification', 25], ['proposal', 50], ['negotiation', 75], ['won', 100], ['lost', 0]]);
    const wfs = ok(await c.get('/v1/workflows'));
    expect((wfs.data as Json[]).map((w) => w.resourceType).sort()).toEqual(['case', 'lead', 'opportunity', 'task']);
  });

  it('requires a segment when the tenant sells to both, normalises phone numbers and keeps the account tree acyclic', async () => {
    const { c } = await crmTenant();
    expect((await c.post('/v1/accounts', { name: 'Acme' })).body.code).toBe('SEGMENT_REQUIRED');
    const parent = ok(await c.post('/v1/accounts', { name: 'Acme Holding', segments: ['b2b'], domain: 'Acme.com.tr', contactPoints: [{ kind: 'phone', value: '0212 555 12 34' }] }), 201);
    expect(parent).toMatchObject({ domain: 'acme.com.tr', segments: ['b2b'], version: 1 });
    expect((parent.contactPoints as Json[])[0]).toMatchObject({ kind: 'phone', e164: '+902125551234' });
    expect((await c.post('/v1/accounts', { name: 'X', segments: ['b2b'], contactPoints: [{ kind: 'phone', value: '123 45' }] })).body.code).toBe('PHONE_INVALID');
    const child = ok(await c.post('/v1/accounts', { name: 'Acme Enerji', segments: ['b2b'], parentAccountId: parent.id, industry: 'Enerji' }), 201);
    const cyc = await c.patchJson(`/v1/accounts/${String(parent.id)}`, { parentAccountId: child.id }, '"1"');
    expect(cyc.status).toBe(422);
    expect(cyc.body.code).toBe('ACCOUNT_HIERARCHY_CYCLE');
    const l = ok(await c.get(`/v1/accounts?q=${encodeURIComponent('industry = "Enerji"')}&sort=name&count=true`));
    expect((l.data as Json[]).map((a) => a.id)).toEqual([child.id]);
    expect(l.meta).toEqual({ total: 1 });
    expect((await c.patchJson(`/v1/accounts/${String(child.id)}`, { name: 'x' })).status).toBe(428);
    const fields = ok(await c.get('/v1/rql/fields?resource=opportunity'));
    expect((fields.data as Json[]).map((f) => f.name)).toEqual(expect.arrayContaining(['amount', 'probability', 'statusCategory', 'expectedClose']));
  });
});

describe('lead conversion (Faz 3 kabul: atomik; hata durumunda hiçbir kayıt kalmaz)', () => {
  it('creates account, contact (with contact points and role) and opportunity in one step, exactly once', async () => {
    const { c, tenantId } = await crmTenant();
    const lead = ok(await c.post('/v1/leads', {
      firstName: 'Deniz', lastName: 'Kara', company: 'Kara Lojistik', segment: 'b2b', source: 'web',
      contactPoints: [{ kind: 'email', value: 'Deniz@KaraLojistik.com', isPrimary: true }, { kind: 'phone', value: '+90 532 123 45 67' }],
    }), 201);
    expect(lead).toMatchObject({ status: { key: 'new' }, segment: 'b2b', convertedAt: null });
    ok(await c.post(`/v1/leads/${String(lead.id)}/transition`, { transitionKey: 'start' }));

    const conv = ok(await c.post(`/v1/leads/${String(lead.id)}/convert`, { opportunity: { amount: '250000', currency: 'TRY' } }));
    const account = ok(await c.get(`/v1/accounts/${String(conv.accountId)}`));
    const contact = ok(await c.get(`/v1/contacts/${String(conv.contactId)}`));
    const opp = ok(await c.get(`/v1/opportunities/${String(conv.opportunityId)}`));
    expect(account).toMatchObject({ name: 'Kara Lojistik', segments: ['b2b'] });
    expect(contact).toMatchObject({ fullName: 'Deniz Kara', accounts: [{ accountId: conv.accountId, role: 'decision_maker', isPrimary: true }] });
    expect((contact.contactPoints as Json[]).map((p) => [p.kind, p.value, p.e164])).toEqual([
      ['email', 'deniz@karalojistik.com', null], ['phone', '+90 532 123 45 67', '+905321234567'],
    ]);
    expect(opp).toMatchObject({ name: 'Kara Lojistik', accountId: conv.accountId, primaryContactId: conv.contactId, amount: '250000.00', currency: 'TRY', probability: 10, status: { key: 'prospecting' } });
    const after = ok(await c.get(`/v1/leads/${String(lead.id)}`));
    expect(after).toMatchObject({ status: { key: 'converted', category: 'closed' } });
    expect(after.convertedAt).not.toBeNull();

    const again = await c.post(`/v1/leads/${String(lead.id)}/convert`, {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LEAD_ALREADY_CONVERTED');
    expect((await c.patchJson(`/v1/leads/${String(lead.id)}`, { score: 50 }, `"${String(after.version)}"`)).body.code).toBe('LEAD_ALREADY_CONVERTED');
    expect((await counts(tenantId)).lc).toBe(1);
  });

  it('a failure in the last step leaves nothing behind', async () => {
    const { c, tenantId } = await crmTenant();
    const lead = ok(await c.post('/v1/leads', { firstName: 'Ece', company: 'Ece Gıda', segment: 'b2c', contactPoints: [{ kind: 'email', value: 'ece@gida.com' }] }), 201);
    const before = await counts(tenantId);
    const bad = await c.post(`/v1/leads/${String(lead.id)}/convert`, { opportunity: { pipelineId: '01900000-0000-7000-8000-000000000000' } });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('PIPELINE_INVALID');
    expect(await counts(tenantId)).toEqual(before);
    expect(ok(await c.get(`/v1/leads/${String(lead.id)}`))).toMatchObject({ convertedAt: null, status: { key: 'new' } });
    // Disqualified leads cannot be converted; the converted status is reachable only through /convert.
    ok(await c.post(`/v1/leads/${String(lead.id)}/transition`, { transitionKey: 'disqualify' }));
    expect((await c.post(`/v1/leads/${String(lead.id)}/convert`, {})).body.code).toBe('LEAD_NOT_CONVERTIBLE');
  });
});

describe('opportunity stage probability (Faz 3 kabul: aşama değişiminde olasılık doğru)', () => {
  it('follows the stage unless set manually; win/lose validators apply', async () => {
    const { c } = await crmTenant();
    const acc = ok(await c.post('/v1/accounts', { name: 'Beta AŞ', segments: ['b2b'] }), 201);
    const opp = ok(await c.post('/v1/opportunities', { name: 'Beta lisans', accountId: acc.id }), 201);
    expect(opp).toMatchObject({ segment: 'b2b', probability: 10, probabilityManual: false, currency: 'TRY', amount: null });
    const url = `/v1/opportunities/${String(opp.id)}`;
    expect(ok(await c.post(`${url}/transition`, { transitionKey: 'to_proposal' }))).toMatchObject({ probability: 50, status: { key: 'proposal' } });
    const lose = await c.post(`${url}/transition`, { transitionKey: 'lose' });
    expect(lose.status).toBe(422);
    expect(lose.body.code).toBe('WORKFLOW_VALIDATION_FAILED');

    const v = ok(await c.get(url)).version as number;
    expect(ok(await c.patchJson(url, { probability: 33 }, `"${v}"`))).toMatchObject({ probability: 33, probabilityManual: true });
    expect(ok(await c.post(`${url}/transition`, { transitionKey: 'to_negotiation' }))).toMatchObject({ probability: 33, status: { key: 'negotiation' } });
    const v2 = ok(await c.get(url)).version as number;
    expect(ok(await c.patchJson(url, { probabilityManual: false }, `"${v2}"`))).toMatchObject({ probability: 75, probabilityManual: false });

    expect((await c.post(`${url}/transition`, { transitionKey: 'win' })).body.code).toBe('WORKFLOW_VALIDATION_FAILED');
    const won = ok(await c.post(`${url}/transition`, { transitionKey: 'win', fields: { amount: '1200.5' } }));
    expect(won).toMatchObject({ probability: 100, amount: '1200.50', status: { key: 'won', category: 'closed' } });
    expect(won.closedAt).not.toBeNull();
    expect(ok(await c.post(`${url}/transition`, { transitionKey: 'to_negotiation' }))).toMatchObject({ probability: 75, closedAt: null });
    expect((await c.patchJson(url, { status: 'won' }, '"1"')).body.code).toBe('USE_TRANSITION_ENDPOINT');
    // A b2c opportunity cannot hang off a b2b-only account.
    expect((await c.post('/v1/opportunities', { name: 'x', accountId: acc.id, segment: 'b2c' })).body.code).toBe('SEGMENT_NOT_ALLOWED');
  });

  it('cases record closing time through their workflow', async () => {
    const { c } = await crmTenant();
    const cs = ok(await c.post('/v1/cases', { subject: 'Fatura hatası', channel: 'email', segment: 'b2c' }), 201);
    const url = `/v1/cases/${String(cs.id)}`;
    ok(await c.post(`${url}/transition`, { transitionKey: 'start' }));
    const res = ok(await c.post(`${url}/transition`, { transitionKey: 'resolve' }));
    expect(res).toMatchObject({ status: { key: 'resolved', category: 'closed' } });
    expect(res.closedAt).not.toBeNull();
    expect(ok(await c.post(`${url}/transition`, { transitionKey: 'reopen' }))).toMatchObject({ closedAt: null, status: { key: 'in_progress' } });
  });
});

describe('duplicates and merge (Faz 3 kabul: merge sonrası ilişkili task/aktiviteler taşınır)', () => {
  it('finds a contact duplicate by e-mail and moves tasks, notes, contact points and opportunities to the survivor', async () => {
    const { c } = await crmTenant();
    const acc = ok(await c.post('/v1/accounts', { name: 'Gamma Ltd', segments: ['b2b'] }), 201);
    const a = ok(await c.post('/v1/contacts', { firstName: 'Mehmet', lastName: 'Öz', segments: ['b2b'], account: { id: acc.id }, contactPoints: [{ kind: 'email', value: 'mehmet@gamma.com', isPrimary: true }] }), 201);
    const b = ok(await c.post('/v1/contacts', {
      firstName: 'Mehmet', lastName: 'Oz', title: 'CFO', segments: ['b2c'],
      contactPoints: [{ kind: 'email', value: 'mehmet@gamma.com', isPrimary: true }, { kind: 'phone', value: '05321112233', isPrimary: true }],
    }), 201);
    const other = ok(await c.post('/v1/contacts', { firstName: 'Zeynep', lastName: 'Ak', segments: ['b2b'] }), 201);

    const d = ok(await c.get(`/v1/contacts/${String(a.id)}/duplicates`));
    expect((d.data as Json[]).map((x) => x.id)).toEqual([b.id]);
    expect((d.data as Json[])[0]).toMatchObject({ score: 1, reasons: expect.arrayContaining(['email']) });

    const task = ok(await c.post('/v1/tasks', { title: 'Mehmet ile görüş', related: { type: 'contact', id: b.id } }), 201);
    expect(task.related).toEqual({ type: 'contact', id: b.id });
    ok(await c.post('/v1/notes', { related: { type: 'contact', id: b.id }, bodyText: 'Fiyat hassas' }), 201);
    const opp = ok(await c.post('/v1/opportunities', { name: 'Gamma ek', accountId: acc.id, primaryContactId: b.id, segment: 'b2b' }), 201);

    const m = ok(await c.post('/v1/contacts/merge', { survivorId: a.id, mergedIds: [b.id], fieldChoices: { title: b.id } }));
    expect(m.moved).toMatchObject({ tasks: 1, notes: 1, contactPoints: 1, opportunities: 1 });

    expect((await c.get(`/v1/contacts/${String(b.id)}`)).status).toBe(404);
    const s = ok(await c.get(`/v1/contacts/${String(a.id)}`));
    expect(s).toMatchObject({ title: 'CFO', segments: ['b2b', 'b2c'] });
    // The duplicate e-mail is dropped, the phone moves over (and keeps being primary for its kind).
    expect((s.contactPoints as Json[]).map((p) => [p.kind, p.isPrimary])).toEqual([['email', true], ['phone', true]]);
    const tasks = ok(await c.get(`/v1/contacts/${String(a.id)}/tasks`));
    expect((tasks.data as Json[]).map((x) => x.id)).toEqual([task.id]);
    const notes = ok(await c.get(`/v1/notes?relatedType=contact&relatedId=${String(a.id)}`));
    expect((notes.data as Json[]).map((n) => n.bodyText)).toEqual(['Fiyat hassas']);
    expect(ok(await c.get(`/v1/opportunities/${String(opp.id)}`)).primaryContactId).toBe(a.id);
    // Not a merge participant → cannot supply a value; a deleted (merged) record cannot be restored.
    expect((await c.post('/v1/contacts/merge', { survivorId: a.id, mergedIds: [other.id], fieldChoices: { title: b.id } })).body.code).toBe('MERGE_INVALID');
    expect((await c.post(`/v1/contacts/${String(b.id)}/restore`)).status).toBe(409);
  });

  it('merging accounts moves opportunities, cases, contact roles and child accounts', async () => {
    const { c } = await crmTenant();
    const a = ok(await c.post('/v1/accounts', { name: 'Delta Yazılım', domain: 'delta.io', segments: ['b2b'] }), 201);
    const b = ok(await c.post('/v1/accounts', { name: 'Delta Yazilim A.S.', domain: 'delta.io', segments: ['b2b'] }), 201);
    const child = ok(await c.post('/v1/accounts', { name: 'Delta Bulut', segments: ['b2b'], parentAccountId: b.id }), 201);
    const ct = ok(await c.post('/v1/contacts', { firstName: 'Can', segments: ['b2b'], account: { id: b.id, role: 'approver' } }), 201);
    ok(await c.post('/v1/opportunities', { name: 'Delta yenileme', accountId: b.id }), 201);
    ok(await c.post('/v1/cases', { subject: 'Erişim sorunu', accountId: b.id }), 201);
    const dup = ok(await c.get(`/v1/accounts/${String(a.id)}/duplicates`));
    expect((dup.data as Json[])[0]).toMatchObject({ id: b.id, reasons: expect.arrayContaining(['domain']) });

    const m = ok(await c.post('/v1/accounts/merge', { survivorId: a.id, mergedIds: [b.id] }));
    expect(m.moved).toMatchObject({ opportunities: 1, cases: 1, accountContactRoles: 1, childAccounts: 1 });
    expect(ok(await c.get(`/v1/accounts/${String(child.id)}`)).parentAccountId).toBe(a.id);
    expect(ok(await c.get(`/v1/contacts/${String(ct.id)}`)).accounts).toEqual([{ accountId: a.id, role: 'approver', isPrimary: true }]);
    const opps = ok(await c.get(`/v1/opportunities?q=${encodeURIComponent(`account = "${String(a.id)}"`)}`));
    expect((opps.data as Json[]).length).toBe(1);
  });
});

describe('isolation (Faz 3 kabul: tüm CRM nesnelerinde tenant izolasyonu) and record scope', () => {
  it('another tenant sees none of the records, even by id', async () => {
    const A = await crmTenant();
    const B = await crmTenant();
    const acc = ok(await A.c.post('/v1/accounts', { name: 'Gizli', segments: ['b2b'] }), 201);
    const lead = ok(await A.c.post('/v1/leads', { company: 'Gizli Aday', segment: 'b2b' }), 201);
    for (const url of [`/v1/accounts/${String(acc.id)}`, `/v1/leads/${String(lead.id)}`, `/v1/accounts/${String(acc.id)}/tasks`, `/v1/accounts/${String(acc.id)}/duplicates`]) {
      expect((await B.c.get(url)).status, url).toBe(404);
    }
    expect((await B.c.post(`/v1/leads/${String(lead.id)}/convert`, {})).status).toBe(404);
    expect((await B.c.post('/v1/notes', { related: { type: 'account', id: acc.id }, bodyText: 'x' })).status).toBe(404);
    expect((await B.c.post('/v1/tasks', { title: 'x', related: { type: 'account', id: acc.id } })).body.code).toBe('RELATED_NOT_FOUND');
    expect(((await B.c.get('/v1/accounts')).body.data as Json[]).length).toBe(0);
  });

  it('segments: a b2b-only workspace hides b2c records, their tasks, notes and contact points', async () => {
    const { c, tenantId } = await crmTenant();
    const b2c = ok(await c.post('/v1/contacts', { firstName: 'Tüketici', segments: ['b2c'], contactPoints: [{ kind: 'phone', value: '05329998877' }] }), 201);
    const both = ok(await c.post('/v1/contacts', { firstName: 'Karma', segments: ['b2b', 'b2c'] }), 201);
    const lead = ok(await c.post('/v1/leads', { company: 'Perakende', segment: 'b2c' }), 201);
    const task = ok(await c.post('/v1/tasks', { title: 'Ara', related: { type: 'lead', id: lead.id } }), 201);
    ok(await c.post('/v1/notes', { related: { type: 'contact', id: b2c.id }, bodyText: 'b2c not' }), 201);

    await superQuery(SUPER(), `UPDATE tenants SET sales_mode = 'b2b_only' WHERE id = $1`, [tenantId]);
    expect((await c.get(`/v1/contacts/${String(b2c.id)}`)).status).toBe(404);
    expect((await c.get(`/v1/leads/${String(lead.id)}`)).status).toBe(404);
    expect((await c.get(`/v1/tasks/${String(task.id)}`)).status).toBe(404);
    expect((await c.get(`/v1/notes?relatedType=contact&relatedId=${String(b2c.id)}`)).status).toBe(404);
    expect(((await c.get('/v1/contacts')).body.data as Json[]).map((x) => x.id)).toEqual([both.id]);
    expect((await c.post('/v1/leads', { company: 'x', segment: 'b2c' })).body.code).toBe('SEGMENT_NOT_ALLOWED');
    // b2b-only: segment defaults to b2b.
    expect(ok(await c.post('/v1/leads', { company: 'Kurumsal' }), 201).segment).toBe('b2b');
    // Even the database refuses to show the hidden phone number to the application role.
    const rows = await h.db.withTenant({ tenantId, userId: null, segments: ['b2b'] }, (tx) =>
      tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM contact_points`));
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('a sales rep works on own records only; reassigning needs the permission; roles follow Matrix A', async () => {
    const { c: admin } = await crmTenant();
    const rep = await member(admin, 'sales_rep');
    const agent = await member(admin, 'call_agent');
    const analyst = await member(admin, 'analyst');
    const adminAcc = ok(await admin.post('/v1/accounts', { name: 'Yönetici firması', segments: ['b2b'] }), 201);
    const mine = ok(await rep.c.post('/v1/accounts', { name: 'Temsilci firması', segments: ['b2b'] }), 201);
    expect((await rep.c.get(`/v1/accounts/${String(adminAcc.id)}`)).status).toBe(404);
    expect(((await rep.c.get('/v1/accounts')).body.data as Json[]).map((a) => a.id)).toEqual([mine.id]);
    expect((await rep.c.post('/v1/accounts', { name: 'x', segments: ['b2b'], ownerUserId: agent.userId })).status).toBe(403);
    expect((await rep.c.deleteWithIfMatch(`/v1/accounts/${String(mine.id)}`, '"1"')).status).toBe(403);
    // A09: call agents create leads and contacts, nothing else; analysts read only.
    expect((await agent.c.post('/v1/leads', { company: 'Arayan', segment: 'b2c' })).status).toBe(201);
    expect((await agent.c.post('/v1/opportunities', { name: 'x', segment: 'b2c' })).status).toBe(403);
    expect((await analyst.c.post('/v1/accounts', { name: 'x', segments: ['b2b'] })).status).toBe(403);
    expect(((await analyst.c.get('/v1/accounts')).body.data as Json[]).length).toBe(2);
    // Admin may hand a record over; the rep then sees it.
    const given = ok(await admin.post('/v1/accounts', { name: 'Devredilen', segments: ['b2b'], ownerUserId: rep.userId }), 201);
    expect((await rep.c.get(`/v1/accounts/${String(given.id)}`)).status).toBe(200);
  });

  it('private notes are visible to their author only; only the author edits', async () => {
    const { c: admin } = await crmTenant();
    const acc = ok(await admin.post('/v1/accounts', { name: 'Not firması', segments: ['b2b'] }), 201);
    const priv = ok(await admin.post('/v1/notes', { related: { type: 'account', id: acc.id }, bodyText: 'gizli', visibility: 'private' }), 201);
    const pub = ok(await admin.post('/v1/notes', { related: { type: 'account', id: acc.id }, bodyText: 'açık' }), 201);
    const analyst = await member(admin, 'analyst');
    const seen = ok(await analyst.c.get(`/v1/notes?relatedType=account&relatedId=${String(acc.id)}`));
    expect((seen.data as Json[]).map((n) => n.id)).toEqual([pub.id]);
    expect((await analyst.c.req('PATCH', `/v1/notes/${String(pub.id)}`, { bodyText: 'x' })).status).toBe(403);
    expect((await analyst.c.req('PATCH', `/v1/notes/${String(priv.id)}`, { bodyText: 'x' })).status).toBe(404);
    expect((await analyst.c.post('/v1/notes', { related: { type: 'account', id: acc.id }, bodyText: 'x' })).status).toBe(403);
  });
});

describe('demo seed (P3)', () => {
  it('builds a workspace through the API and is idempotent', async () => {
    const slug = uniq('demo-');
    const r = await seedDemo(h.app, h.mailer, PASSWORD, slug);
    expect(r).toMatchObject({ created: true, slug });
    expect(r.emails).toHaveLength(6);
    const [n] = await superQuery<{ a: number; c: number; l: number; o: number; cs: number; t: number }>(SUPER(), `
      SELECT (SELECT count(*)::int FROM accounts a JOIN tenants t ON t.id = a.tenant_id WHERE t.slug = $1) AS a,
             (SELECT count(*)::int FROM contacts x JOIN tenants t ON t.id = x.tenant_id WHERE t.slug = $1) AS c,
             (SELECT count(*)::int FROM leads x JOIN tenants t ON t.id = x.tenant_id WHERE t.slug = $1) AS l,
             (SELECT count(*)::int FROM opportunities x JOIN tenants t ON t.id = x.tenant_id WHERE t.slug = $1) AS o,
             (SELECT count(*)::int FROM cases x JOIN tenants t ON t.id = x.tenant_id WHERE t.slug = $1) AS cs,
             (SELECT count(*)::int FROM tasks x JOIN tenants t ON t.id = x.tenant_id WHERE t.slug = $1) AS t`, [slug]);
    expect(n).toEqual({ a: 6, c: 6, l: 5, o: 6, cs: 2, t: 5 });
    expect(await seedDemo(h.app, h.mailer, PASSWORD, slug)).toMatchObject({ created: false });
  });
});
