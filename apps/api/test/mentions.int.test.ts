import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P8c (docs/p8-plan.md §13–16, ADR-0017): mentions in comments, notes and descriptions; the picker; "mentioning
// grants access"; limits; isolation.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
interface Member { c: Client; userId: string; name: string }

async function workspace() {
  const s = await signupAndLogin(h);
  ok(await s.c.post('/v1/modules/crm/enable'));
  return { ...s, adminId: String((ok(await s.c.get('/v1/me')).user as Json).id) };
}

async function member(admin: Client, role: string, opts: { segments?: string[]; teamId?: string; name?: string } = {}): Promise<Member> {
  const email = `${uniq(role)}@firma.test`;
  const name = opts.name ?? role;
  ok(await admin.post('/v1/invitations', { email, roleKey: role, ...(opts.segments ? { segments: opts.segments } : {}) }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: name }));
  const userId = (ok(await c.post('/v1/auth/login', { email, password: PASSWORD })).user as { id: string }).id;
  if (opts.teamId) ok(await admin.put(`/v1/teams/${opts.teamId}/members/${userId}`, {}));
  return { c, userId, name };
}

const doc = (...content: unknown[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const txt = (text: string) => ({ type: 'text', text });
const at = (kind: 'user' | 'team', id: string) => ({ type: 'mention', attrs: { kind, id } });
const mentionsOf = async (c: Client) => (ok(await c.get('/v1/notifications')).data as Json[]).filter((n) => n.kind === 'mention');
const account = async (c: Client, extra: Json = {}) => ok(await c.post('/v1/accounts', { name: uniq('Müşteri '), segments: ['b2b'], ...extra }), 201);
const picker = async (c: Client, url: string, q = '', source = 'comment') => ok(await c.get(`${url}/mentionable?q=${encodeURIComponent(q)}&source=${source}`)) as { users: Json[]; teams: Json[] };
const policy = async (c: Client, on: boolean) => {
  const v = ok(await c.get('/v1/config/mentions?scope=tenant')).version;
  ok(await c.req('PUT', '/v1/config/mentions?scope=tenant', { value: { grantAccess: on } }, { 'if-match': `"${String(v)}"` }));
};

describe('descriptions', () => {
  it('SCN-16: a mention in an opportunity or task description notifies; only new ones on edit; removed ones are withdrawn', async () => {
    const { c } = await workspace();
    const a = await member(c, 'manager');
    const b = await member(c, 'sales_rep');
    const team = String(ok(await c.post('/v1/teams', { name: 'Ekip' }), 201).id);
    for (const m of [a, b]) ok(await c.put(`/v1/teams/${team}/members/${m.userId}`, {}));
    const opp = ok(await c.post('/v1/opportunities', { name: 'Filo', segment: 'b2b', ownerUserId: a.userId, description: doc(txt('Bak '), at('user', a.userId)) }), 201);
    const url = `/v1/opportunities/${String(opp.id)}`;
    const n = (await mentionsOf(a.c))[0]!;
    expect(n).toMatchObject({ accessible: true, title: 'Filo', source: { type: 'description', id: opp.id }, link: `/r/opportunity/${String(opp.id)}#description` });

    // Another edit that keeps the mention notifies nobody again; a read notice stays read.
    ok(await a.c.post(`/v1/notifications/${String(n.id)}/read`));
    ok(await c.patchJson(url, { description: doc(txt('Bak yine '), at('user', a.userId)) }, '"1"'));
    expect((await mentionsOf(a.c)).filter((x) => x.readAt === null)).toEqual([]);
    // Two people in one description: each has their own notice (MEN-05).
    ok(await c.post(`${url}/shares`, { grantee: { type: 'user', id: b.userId } }), 201);
    ok(await c.patchJson(url, { description: doc(at('user', a.userId), at('user', b.userId)) }, '"2"'));
    expect(await mentionsOf(b.c)).toHaveLength(1);
    ok(await c.patchJson(url, { description: doc(at('user', a.userId)) }, '"3"'));
    expect(await mentionsOf(b.c)).toEqual([]);
    ok(await c.patchJson(url, { description: null }, '"4"'));
    expect(await superQuery(SUPER(), `SELECT 1 FROM mentions WHERE source_id = $1 AND retracted_at IS NULL`, [opp.id])).toEqual([]);

    const task = ok(await c.post('/v1/tasks', { title: 'Ara', assigneeUserId: b.userId, description: doc(at('user', b.userId)) }), 201);
    expect((await mentionsOf(b.c))[0]).toMatchObject({ title: 'Ara', record: { type: 'task', id: task.id } });
    ok(await c.patchJson(`/v1/tasks/${String(task.id)}`, { description: doc(txt('boş')) }, '"1"'));
    expect(await mentionsOf(b.c)).toEqual([]);
  });

  it('a person who lost access does not block later edits; unsafe content and unknown nodes are refused; the write is atomic', async () => {
    const { c } = await workspace();
    const rep = await member(c, 'sales_rep');
    const acc = await account(c);
    const url = `/v1/accounts/${String(acc.id)}`;
    const share = ok(await c.post(`${url}/shares`, { grantee: { type: 'user', id: rep.userId } }), 201);
    ok(await c.patchJson(url, { description: doc(at('user', rep.userId)) }, '"1"'));
    ok(await c.del(`${url}/shares/${String(share.id)}`), 204);
    ok(await c.patchJson(url, { description: doc(txt('devam '), at('user', rep.userId)) }, '"2"'));
    const other = await member(c, 'sales_rep');
    const r = await c.patchJson(url, { name: 'Değişmemeli', description: doc(at('user', other.userId)) }, '"3"');
    expect(r.body).toMatchObject({ code: 'MENTION_TARGET_NO_ACCESS', userIds: [other.userId] });
    expect(ok(await c.get(url))).toMatchObject({ version: 3, name: acc.name });
    expect((await c.patchJson(url, { description: { type: 'doc', content: [{ type: 'iframe' }] } }, '"3"')).status).toBe(400);
    ok(await c.patchJson(url, { description: { type: 'doc', content: [{ type: 'horizontalRule' }, { type: 'paragraph' }] } }, '"3"'));
  });

  it('a hidden description cannot be the place someone is mentioned (field access, MEN-03)', async () => {
    const { c } = await workspace();
    const rep = await member(c, 'sales_rep', { name: 'Ece' });
    const acc = await account(c, { ownerUserId: rep.userId });
    const url = `/v1/accounts/${String(acc.id)}`;
    const role = (ok(await c.get('/v1/roles')).data as Json[]).find((r) => r.key === 'sales_rep')!;
    ok(await c.put('/v1/field-policies', { roleId: role.id, resourceType: 'account', field: 'description', access: 'hidden' }));
    expect((await picker(c, url, 'Ece', 'comment')).users.map((u) => u.id)).toEqual([rep.userId]);
    expect((await picker(c, url, 'Ece', 'description')).users).toEqual([]);
    expect((await c.patchJson(url, { description: doc(at('user', rep.userId)) }, '"1"')).body.code).toBe('MENTION_TARGET_NO_ACCESS');
    ok(await c.post(`${url}/comments`, { body: doc(at('user', rep.userId)) }), 201);
  });
});

describe('notes', () => {
  it('mention, edit, make private, delete; a private note mentions nobody', async () => {
    const { c } = await workspace();
    const rep = await member(c, 'sales_rep');
    const acc = await account(c, { ownerUserId: rep.userId });
    const note = (body: Json) => c.post('/v1/notes', { related: { type: 'account', id: acc.id }, bodyText: 'not', ...body });
    const n = ok(await note({ body: doc(at('user', rep.userId)) }), 201);
    expect((await mentionsOf(rep.c))[0]).toMatchObject({ source: { type: 'note', id: n.id }, link: `/r/account/${String(acc.id)}#note-${String(n.id)}` });
    const patch = (body: Json) => c.req('PATCH', `/v1/notes/${String(n.id)}`, body);
    ok(await patch({ bodyText: 'yalnız metin' }));
    expect(await mentionsOf(rep.c)).toHaveLength(1);
    expect((await patch({ visibility: 'private' })).status).toBe(400); // the body still mentions someone
    ok(await patch({ visibility: 'private', body: doc(txt('özel')) }));
    expect(await mentionsOf(rep.c)).toEqual([]);
    ok(await patch({ visibility: 'standard', body: doc(at('user', rep.userId)) }));
    expect(await mentionsOf(rep.c)).toHaveLength(1);
    ok(await c.del(`/v1/notes/${String(n.id)}`), 204);
    expect(await mentionsOf(rep.c)).toEqual([]);
    expect((await note({ visibility: 'private', body: doc(at('user', rep.userId)) })).status).toBe(400);
    const outsider = await member(c, 'sales_rep');
    expect((await note({ body: doc(at('user', outsider.userId)) })).body.code).toBe('MENTION_TARGET_NO_ACCESS');
  });
});

describe('picker and policy', () => {
  it('SCN-15: lists only people who can read the record; teams; the caller is left out; search is literal', async () => {
    const { c } = await workspace();
    const team = String(ok(await c.post('/v1/teams', { name: 'Saha_1' }), 201).id);
    ok(await c.post('/v1/teams', { name: 'Boş ekip' }), 201);
    const owner = await member(c, 'sales_rep', { name: 'Can Şahin', teamId: team });
    const b2c = await member(c, 'manager', { name: 'Zeynep Arslan', segments: ['b2c'] });
    const analyst = await member(c, 'analyst', { name: 'Selin Koç' });
    const acc = await account(c, { ownerUserId: owner.userId });
    const url = `/v1/accounts/${String(acc.id)}`;
    const all = await picker(c, url);
    expect(all.users.map((u) => u.id).sort()).toEqual([owner.userId, analyst.userId].sort());
    expect(all.teams).toEqual([{ id: team, name: 'Saha_1', memberCount: 1 }]);
    expect((await picker(c, url, 'zeynep')).users).toEqual([]);
    expect((await c.post(`${url}/comments`, { body: doc(at('user', b2c.userId)) })).status).toBe(422);
    expect((await picker(c, url, '%')).users).toEqual([]);
    expect((await picker(c, url, '_')).teams.map((x) => x.id)).toEqual([team]);
    // Who may not mention gets no list; who cannot read the record gets a 404.
    expect((await analyst.c.get(`${url}/mentionable`)).status).toBe(403);
    expect((await b2c.c.get(`${url}/mentionable`)).status).toBe(404);
    expect((await c.get(`${url}/mentionable?source=fax`)).status).toBe(400);
  });

  it('mentioning grants read access only with the policy on, only by someone who may share, never across segments', async () => {
    const { c, tenantId } = await workspace();
    const owner = await member(c, 'sales_rep', { name: 'Sahip' });
    const reader = await member(c, 'sales_rep', { name: 'Okur' });
    const target = await member(c, 'sales_rep', { name: 'Hedef' });
    const b2c = await member(c, 'sales_rep', { name: 'Perakende', segments: ['b2c'] });
    const acc = await account(c, { ownerUserId: owner.userId });
    const url = `/v1/accounts/${String(acc.id)}`;
    ok(await owner.c.post(`${url}/shares`, { grantee: { type: 'user', id: reader.userId } }), 201);
    const say = (who: Member, id: string) => who.c.post(`${url}/comments`, { body: doc(at('user', id)) });
    expect((await say(owner, target.userId)).status).toBe(422);
    expect((await owner.c.req('PUT', '/v1/config/mentions?scope=tenant', { value: { grantAccess: true } }, { 'if-match': '0' })).status).toBe(403);
    await policy(c, true);

    // The reader has the record but may not share it.
    expect((await say(reader, target.userId)).status).toBe(422);
    expect((await picker(reader.c, url, 'Hedef')).users).toEqual([]);
    expect((await picker(owner.c, url, 'Hedef')).users).toEqual([{ id: target.userId, displayName: 'Hedef', grantsAccess: true }]);
    expect((await picker(owner.c, url, 'Perakende')).users).toEqual([]);
    expect((await say(owner, b2c.userId)).status).toBe(422);
    expect((await target.c.get(url)).status).toBe(404); // looking in the picker granted nothing

    ok(await say(owner, target.userId), 201);
    expect(ok(await target.c.get(url)).id).toBe(acc.id);
    expect((await target.c.patchJson(url, { name: 'x' }, '"1"')).status).toBe(403);
    expect(await mentionsOf(target.c)).toHaveLength(1);
    const shares = ok(await owner.c.get(`${url}/shares`)).data as Json[];
    expect(shares.find((s) => (s.grantee as Json).id === target.userId)).toMatchObject({ source: 'mention', access: 'read' });
    const log = await superQuery<{ details: Json }>(SUPER(), `SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'record.shared'`, [tenantId]);
    expect(log.filter((l) => l.details.source === 'mention')).toHaveLength(1);
    // One refused person keeps the whole write — and its grants — from happening.
    const second = await member(c, 'sales_rep', { name: 'İkinci' });
    expect((await owner.c.post(`${url}/comments`, { body: doc(at('user', second.userId), at('user', b2c.userId)) })).status).toBe(422);
    expect((await second.c.get(url)).status).toBe(404);
    await policy(c, false);
    expect((await say(owner, second.userId)).status).toBe(422);
  });
});

describe('teams, limits and isolation', () => {
  it('a team mention reaches members with access; someone named twice is told once; leaving one of both keeps it', async () => {
    const { c } = await workspace();
    const team = String(ok(await c.post('/v1/teams', { name: 'Ekip' }), 201).id);
    const a = await member(c, 'sales_rep', { teamId: team });
    const out = await member(c, 'sales_rep', { teamId: team });
    const acc = await account(c, { ownerUserId: a.userId });
    const cm = ok(await c.post(`/v1/accounts/${String(acc.id)}/comments`, { body: doc(at('team', team), at('user', a.userId)) }), 201);
    expect(await mentionsOf(a.c)).toHaveLength(1);
    expect(await mentionsOf(out.c)).toEqual([]);
    ok(await c.req('PATCH', `/v1/comments/${String(cm.id)}`, { body: doc(at('team', team)), revision: 1 }));
    expect(await mentionsOf(a.c)).toHaveLength(1);
    ok(await c.req('PATCH', `/v1/comments/${String(cm.id)}`, { body: doc(txt('x')), revision: 2 }));
    expect(await mentionsOf(a.c)).toEqual([]);
  });

  it('MEN-11: at most 30 mentions a minute per author; big teams cannot be mentioned', async () => {
    const { c, tenantId, adminId } = await workspace();
    const rep = await member(c, 'sales_rep');
    const acc = await account(c, { ownerUserId: rep.userId });
    const url = `/v1/accounts/${String(acc.id)}/comments`;
    await superQuery(SUPER(), `INSERT INTO mentions (tenant_id, source_type, source_id, record_type, record_id, mentioned_user, mentioned_by)
      SELECT $1, 'comment', gen_random_uuid(), 'account', $2, $3, $4 FROM generate_series(1, 30)`, [tenantId, acc.id, rep.userId, adminId]);
    const r = await c.post(url, { body: doc(at('user', rep.userId)) });
    expect(r.body.code).toBe('RATE_LIMITED');
    ok(await c.post(url, { body: doc(txt('anmadan')) }), 201);
    await superQuery(SUPER(), `UPDATE mentions SET created_at = now() - interval '2 minutes' WHERE tenant_id = $1`, [tenantId]);
    ok(await c.post(url, { body: doc(at('user', rep.userId)) }), 201);

    const team = String(ok(await c.post('/v1/teams', { name: 'Kalabalık' }), 201).id);
    const seed = (sqlText: string, v: unknown[]) => superQuery(SUPER(), sqlText, v);
    await seed(`WITH u AS (INSERT INTO users (id, email, display_name) SELECT gen_random_uuid(), 'x' || g || '-' || $1::text || '@firma.test', 'Üye ' || g FROM generate_series(1, 101) g RETURNING id),
      m AS (INSERT INTO memberships (tenant_id, user_id) SELECT $1::uuid, id FROM u RETURNING user_id) SELECT 1`, [tenantId]);
    await seed(`INSERT INTO team_members (tenant_id, team_id, user_id) SELECT $1::uuid, $2::uuid, u.id FROM users u WHERE u.email LIKE 'x%-' || $1::text || '@firma.test'`, [tenantId, team]);
    expect((await c.post(url, { body: doc(at('team', team)) })).body.code).toBe('LIMIT_EXCEEDED');
    expect((await picker(c, `/v1/accounts/${String(acc.id)}`, 'Kalabalık')).teams).toEqual([]);
  });

  it('another workspace: its people and teams cannot be mentioned or listed, and nothing reaches them', async () => {
    const a = await workspace();
    const b = await workspace();
    const teamB = String(ok(await b.c.post('/v1/teams', { name: 'B ekibi' }), 201).id);
    const acc = await account(a.c);
    const url = `/v1/accounts/${String(acc.id)}`;
    expect((await a.c.post(`${url}/comments`, { body: doc(at('user', b.adminId)) })).body.code).toBe('MENTION_TARGET_NO_ACCESS');
    expect((await a.c.post(`${url}/comments`, { body: doc(at('team', teamB)) })).status).toBe(400);
    await policy(a.c, true);
    expect((await a.c.post(`${url}/comments`, { body: doc(at('user', b.adminId)) })).status).toBe(422);
    expect(await picker(a.c, url)).toEqual({ users: [], teams: [] });
    expect((await b.c.get(`${url}/mentionable`)).status).toBe(404);
    expect(await mentionsOf(b.c)).toEqual([]);
  });
});
