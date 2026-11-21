import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import matrix from '../../../packages/authz/src/generated/matrix.json';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

// P4a acceptance (docs/p4-plan.md §8): the record-level authorization engine.

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const ok = (r: { status: number; body: Json }, status = 200) => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const ids = (r: { body: Json }) => (r.body.data as Json[]).map((x) => x.id);

interface Member { c: Client; userId: string }

async function workspace() {
  const s = await signupAndLogin(h);
  ok(await s.c.post('/v1/modules/crm/enable'));
  const me = ok(await s.c.get('/v1/me'));
  return { ...s, adminId: (me.user as { id: string }).id };
}

async function member(admin: Client, role: string, opts: { segments?: string[]; teamId?: string; teamRole?: 'member' | 'manager' } = {}): Promise<Member> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role, ...(opts.segments ? { segments: opts.segments } : {}) }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  const userId = (l.user as { id: string }).id;
  if (opts.teamId) ok(await admin.put(`/v1/teams/${opts.teamId}/members/${userId}`, { role: opts.teamRole ?? 'member' }));
  return { c, userId };
}

const team = async (admin: Client, name = uniq('Ekip ')) => String(ok(await admin.post('/v1/teams', { name }), 201).id);

// ------------------------------------------------------------------------------------------------------
// Oracle: an independent reading of permission-matrix.yaml (generated matrix.json), not packages/authz.
// ------------------------------------------------------------------------------------------------------
type Grant = { mode: string; scope: string | string[]; resources?: string[]; permissions?: string[] };
type Row = { permissions: string[]; grants: Record<string, Grant | undefined> };
const ROWS = (matrix as { rows: Row[] }).rows;
type Situation = 'own' | 'teammate' | 'other' | 'hidden_segment';

function oracle(role: string, action: 'read' | 'update' | 'archive' | 'create', situation: Situation, resource = 'crm.account'): boolean {
  if (situation === 'hidden_segment') return false;
  const perm = `*record*.${action}`;
  const scopes = new Set<string>();
  for (const row of ROWS) {
    if (!row.permissions.includes(perm)) continue;
    const g = row.grants[role];
    if (!g || (g.permissions && !g.permissions.includes(perm)) || (g.resources && !g.resources.includes(resource))) continue;
    if (g.mode === 'request' || g.mode === 'approve' || (g.mode === 'read' && action !== 'read')) continue;
    for (const s of Array.isArray(g.scope) ? g.scope : [g.scope]) scopes.add(s);
  }
  if (action === 'create') return scopes.size > 0;
  if (scopes.has('all') || scopes.has('segment')) return true;
  if (scopes.has('own') && situation === 'own') return true;
  // The actor belongs to the team, so `team` covers both its own and its teammate's records (accounts have no queue).
  if (scopes.has('team') && (situation === 'own' || situation === 'teammate')) return true;
  return false;
}

describe('generated from permission-matrix.yaml: role × action × situation (G2 kabul)', () => {
  const roles = ['admin', 'manager', 'sales_rep', 'call_agent', 'analyst'] as const;

  for (const role of roles) {
    it(`${role}: read / update / archive / create on accounts match the matrix, including list counts`, async () => {
      const { c: admin } = await workspace();
      const teamT = await team(admin);
      const teamU = await team(admin);
      const actor = await member(admin, role, { segments: ['b2b'], teamId: teamT, teamRole: role === 'manager' ? 'manager' : 'member' });
      const mate = await member(admin, 'sales_rep', { segments: ['b2b'], teamId: teamT });
      const other = await member(admin, 'sales_rep', { segments: ['b2b'], teamId: teamU });
      const rec: Record<Situation, string> = {
        own: String(ok(await admin.post('/v1/accounts', { name: uniq('Kendi '), segments: ['b2b'], ownerUserId: actor.userId }), 201).id),
        teammate: String(ok(await admin.post('/v1/accounts', { name: uniq('Ekip '), segments: ['b2b'], ownerUserId: mate.userId }), 201).id),
        other: String(ok(await admin.post('/v1/accounts', { name: uniq('Diğer '), segments: ['b2b'], ownerUserId: other.userId }), 201).id),
        hidden_segment: String(ok(await admin.post('/v1/accounts', { name: uniq('B2C '), segments: ['b2c'], ownerUserId: actor.userId }), 201).id),
      };

      const visible: string[] = [];
      for (const situation of Object.keys(rec) as Situation[]) {
        const id = rec[situation];
        const canRead = oracle(role, 'read', situation);
        const read = await actor.c.get(`/v1/accounts/${id}`);
        expect(read.status, `${role} read ${situation}`).toBe(canRead ? 200 : 404);
        if (canRead) visible.push(id);
        const patch = await actor.c.patchJson(`/v1/accounts/${id}`, { industry: 'Test' }, `"${Number(read.body.version ?? 1)}"`);
        expect(patch.status, `${role} update ${situation}`).toBe(!canRead ? 404 : oracle(role, 'update', situation) ? 200 : 403);
      }
      // Archive last (it hides the record): own record only, so other expectations are unaffected.
      const own = await actor.c.get(`/v1/accounts/${rec.own}`);
      const del = await actor.c.deleteWithIfMatch(`/v1/accounts/${rec.own}`, `"${Number(own.body.version ?? 1)}"`);
      expect(del.status, `${role} archive own`).toBe(!oracle(role, 'read', 'own') ? 404 : oracle(role, 'archive', 'own') ? 204 : 403);
      const archived = del.status === 204;

      // Lists and counts contain exactly the readable records — no post-filtering, so totals are exact.
      const list = await actor.c.get('/v1/accounts?count=true&limit=1');
      const expected = visible.filter((id) => !(archived && id === rec.own));
      expect(list.body.meta, `${role} count`).toEqual({ total: expected.length });
      const all = await actor.c.get('/v1/accounts?limit=200');
      expect(ids(all).sort(), `${role} list`).toEqual([...expected].sort());

      const create = await actor.c.post('/v1/accounts', { name: uniq('Yeni '), segments: ['b2b'] });
      expect(create.status, `${role} create`).toBe(oracle(role, 'create', 'own') ? 201 : 403);
    });
  }
});

describe('decision scenarios (10.4.4)', () => {
  it('SCN-01/06/07/08/11/05: segments hide, limits hold, team reassignment works', async () => {
    const { c: admin, adminId } = await workspace();
    const b2bTeam = await team(admin, 'B2B Kurumsal');
    const b2cTeam = await team(admin, 'B2C Perakende');
    const mert = await member(admin, 'manager', { segments: ['b2b'], teamId: b2bTeam, teamRole: 'manager' });
    const can = await member(admin, 'sales_rep', { segments: ['b2b'], teamId: b2bTeam });
    const zeynep = await member(admin, 'sales_rep', { segments: ['b2c'], teamId: b2cTeam });
    const selin = await member(admin, 'analyst', { segments: ['b2b', 'b2c'] });
    const can2 = await member(admin, 'sales_rep', { segments: ['b2b'], teamId: b2bTeam });

    const zOpp = ok(await zeynep.c.post('/v1/opportunities', { name: 'Perakende sipariş', segment: 'b2c' }), 201);
    // SCN-01: a b2b rep cannot see a b2c record — 404, indistinguishable from a missing one.
    expect((await can.c.get(`/v1/opportunities/${String(zOpp.id)}`)).status).toBe(404);
    // SCN-06: a b2b manager cannot touch a b2c record either.
    expect((await mert.c.patchJson(`/v1/opportunities/${String(zOpp.id)}`, { name: 'x' }, '"1"')).status).toBe(404);
    // SCN-07: granting a segment the manager does not hold.
    const g = await mert.c.put(`/v1/users/${can.userId}/segments`, { segments: [{ segment: 'b2c' }] });
    expect(g.status).toBe(403);
    expect(g.body).toMatchObject({ code: 'MANAGER_LIMIT', reason: 'own_segments_only' });
    // …and never for oneself (not_self), never outside managed teams.
    expect((await mert.c.put(`/v1/users/${mert.userId}/segments`, { segments: [{ segment: 'b2b' }] })).body).toMatchObject({ reason: 'not_self' });
    expect((await mert.c.put(`/v1/users/${zeynep.userId}/segments`, { segments: [{ segment: 'b2b' }] })).body).toMatchObject({ reason: 'managed_teams_only' });
    // SCN-08: a manager cannot change roles (own or others'); an Admin cannot change their own.
    expect((await mert.c.put(`/v1/users/${mert.userId}/roles`, { roles: ['admin'] })).status).toBe(403);
    expect((await admin.put(`/v1/users/${adminId}/roles`, { roles: ['sales_rep'] })).body).toMatchObject({ code: 'MANAGER_LIMIT', reason: 'not_self' });
    // SCN-11: the analyst reads everything, changes nothing.
    expect((await selin.c.get(`/v1/opportunities/${String(zOpp.id)}`)).status).toBe(200);
    expect((await selin.c.patchJson(`/v1/opportunities/${String(zOpp.id)}`, { name: 'x' }, '"1"')).status).toBe(403);
    // SCN-05: the manager reassigns a team member's b2b opportunity to another member; audited.
    const canOpp = ok(await can.c.post('/v1/opportunities', { name: 'Kurumsal lisans', segment: 'b2b' }), 201);
    const moved = ok(await mert.c.patchJson(`/v1/opportunities/${String(canOpp.id)}`, { ownerUserId: can2.userId }, '"1"'));
    expect(moved.ownerUserId).toBe(can2.userId);
    // …but not to someone outside the team.
    expect((await mert.c.patchJson(`/v1/opportunities/${String(canOpp.id)}`, { ownerUserId: selin.userId }, '"2"')).status).toBe(403);
    // A rep cannot reassign (request-only grant).
    expect((await can2.c.patchJson(`/v1/opportunities/${String(canOpp.id)}`, { ownerUserId: can.userId }, '"2"')).status).toBe(403);
    const [a] = await superQuery<{ n: number }>(SUPER(), `SELECT count(*)::int AS n FROM audit_log WHERE action = 'record.reassigned' AND target_id = $1`, [canOpp.id]);
    expect(a?.n).toBe(1);
  });

  it('a permission change applies on the next request (same token)', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep', { segments: ['b2b', 'b2c'] });
    const acc = ok(await admin.post('/v1/accounts', { name: 'Paylaşılacak', segments: ['b2c'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    expect((await rep.c.get(url)).status).toBe(404);
    ok(await admin.post(`${url}/shares`, { grantee: { type: 'user', id: rep.userId } }), 201);
    expect((await rep.c.get(url)).status).toBe(200);
    ok(await admin.put(`/v1/users/${rep.userId}/segments`, { segments: [{ segment: 'b2b' }] }));
    expect((await rep.c.get(url)).status).toBe(404); // a share never crosses a segment boundary
    // The segment switcher narrows only.
    const both = ok(await admin.post('/v1/accounts', { name: 'İki segment', segments: ['b2b', 'b2c'] }), 201);
    expect((await admin.get(`/v1/accounts/${String(both.id)}`, { 'x-segment': 'b2c' })).status).toBe(200);
    expect((await admin.get(url, { 'x-segment': 'b2b' })).status).toBe(404);
    expect((await rep.c.get('/v1/accounts', { 'x-segment': 'b2c' })).body.data).toEqual([]);
  });
});

describe('sharing: OWD, manual shares, criteria rules; tasks follow their parent', () => {
  it('organisation-wide read lets everyone read but not edit; read_write lets them edit', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const acc = ok(await admin.post('/v1/accounts', { name: 'Herkese açık', segments: ['b2b'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    expect((await rep.c.get(url)).status).toBe(404);
    ok(await admin.put('/v1/sharing/defaults', { defaults: [{ resourceType: 'account', access: 'read' }] }));
    expect((await rep.c.get(url)).status).toBe(200);
    expect((await rep.c.patchJson(url, { industry: 'x' }, '"1"')).status).toBe(403);
    ok(await admin.put('/v1/sharing/defaults', { defaults: [{ resourceType: 'account', access: 'read_write' }] }));
    expect((await rep.c.patchJson(url, { industry: 'x' }, '"1"')).status).toBe(200);
    // Archive is never widened by sharing.
    expect((await rep.c.deleteWithIfMatch(url, '"2"')).status).toBe(403);
    expect((await rep.c.get('/v1/sharing/defaults')).status).toBe(403);
  });

  it('manual shares (user and team, read and edit) and derived task access', async () => {
    const { c: admin } = await workspace();
    const teamX = await team(admin);
    const owner = await member(admin, 'sales_rep');
    const viaUser = await member(admin, 'sales_rep');
    const viaTeam = await member(admin, 'sales_rep', { teamId: teamX });
    const acc = ok(await owner.c.post('/v1/accounts', { name: 'Ortak müşteri', segments: ['b2b'] }), 201);
    const url = `/v1/accounts/${String(acc.id)}`;
    const task = ok(await owner.c.post('/v1/tasks', { title: 'Ziyaret', related: { type: 'account', id: acc.id } }), 201);
    expect((await viaUser.c.get(`/v1/tasks/${String(task.id)}`)).status).toBe(404);

    expect((await viaUser.c.post(`${url}/shares`, { grantee: { type: 'user', id: viaUser.userId } })).status).toBe(404); // cannot see it yet
    ok(await owner.c.post(`${url}/shares`, { grantee: { type: 'user', id: viaUser.userId }, access: 'read' }), 201);
    ok(await owner.c.post(`${url}/shares`, { grantee: { type: 'team', id: teamX }, access: 'edit' }), 201);
    expect((await owner.c.post(`${url}/shares`, { grantee: { type: 'user', id: owner.userId } })).body.code).toBe('SHARE_INVALID');

    expect((await viaUser.c.get(url)).status).toBe(200);
    expect((await viaUser.c.patchJson(url, { industry: 'x' }, '"1"')).status).toBe(403);
    expect((await viaTeam.c.patchJson(url, { industry: 'Lojistik' }, '"1"')).status).toBe(200);
    // Tasks: readable through the parent record, but writing stays with the task's own scope.
    expect((await viaUser.c.get(`/v1/tasks/${String(task.id)}`)).status).toBe(200);
    expect((await viaUser.c.patchJson(`/v1/tasks/${String(task.id)}`, { title: 'x' }, '"1"')).status).toBe(403);
    expect(ids(await viaUser.c.get(`${url}/tasks`))).toEqual([task.id]);
    const shares = ok(await owner.c.get(`${url}/shares`));
    expect((shares.data as Json[]).length).toBe(2);
    ok(await owner.c.del(`${url}/shares/${String((shares.data as Json[])[0]!.id)}`), 204);
    expect((await viaUser.c.get(url)).status).toBe(404);
  });

  it('criteria rules share matching records with a team; invalid criteria are rejected', async () => {
    const { c: admin } = await workspace();
    const energy = await team(admin, 'Enerji ekibi');
    const rep = await member(admin, 'sales_rep', { teamId: energy });
    const hit = ok(await admin.post('/v1/accounts', { name: 'Güneş Enerji', segments: ['b2b'], industry: 'Enerji' }), 201);
    const miss = ok(await admin.post('/v1/accounts', { name: 'Tekstil AŞ', segments: ['b2b'], industry: 'Tekstil' }), 201);
    const bad = await admin.post('/v1/sharing/rules', { resourceType: 'account', name: 'Bozuk', criteria: 'industry = = 1', granteeTeamId: energy });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('RULE_INVALID');
    const rule = ok(await admin.post('/v1/sharing/rules', { resourceType: 'account', name: 'Enerji', criteria: 'industry = "Enerji"', granteeTeamId: energy }), 201);
    const l = ok(await rep.c.get('/v1/accounts?count=true'));
    expect((l.data as Json[]).map((a) => a.id)).toEqual([hit.id]);
    expect(l.meta).toEqual({ total: 1 });
    expect((await rep.c.get(`/v1/accounts/${String(miss.id)}`)).status).toBe(404);
    expect((await rep.c.patchJson(`/v1/accounts/${String(hit.id)}`, { website: 'https://gunes.example' }, '"1"')).status).toBe(403);
    ok(await admin.del(`/v1/sharing/rules/${String(rule.id)}`), 204);
    expect((await rep.c.get(`/v1/accounts/${String(hit.id)}`)).status).toBe(404);
  });
});

describe('role hierarchy, teams and member administration', () => {
  it('a role sees records of holders of roles below it; hierarchies stay acyclic', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const agent = await member(admin, 'call_agent');
    const lead = ok(await rep.c.post('/v1/leads', { company: 'Hiyerarşi', segment: 'b2b' }), 201);
    expect((await agent.c.get(`/v1/leads/${String(lead.id)}`)).status).toBe(404);
    const roles = ok(await admin.get('/v1/roles')).data as Json[];
    const id = (k: string) => String(roles.find((r) => r.key === k)!.id);
    ok(await admin.put(`/v1/roles/${id('sales_rep')}/parent`, { parentRoleId: id('call_agent') }));
    expect((await agent.c.get(`/v1/leads/${String(lead.id)}`)).status).toBe(200);
    expect((await admin.put(`/v1/roles/${id('call_agent')}/parent`, { parentRoleId: id('sales_rep') })).body.code).toBe('ROLE_HIERARCHY_CYCLE');
    ok(await admin.put(`/v1/roles/${id('sales_rep')}/parent`, { parentRoleId: null }));
    expect((await agent.c.get(`/v1/leads/${String(lead.id)}`)).status).toBe(404);
  });

  it('managers see sub-teams; manage members of their teams only; team trees stay acyclic', async () => {
    const { c: admin } = await workspace();
    const parent = await team(admin, 'Bölge');
    const child = String(ok(await admin.post('/v1/teams', { name: 'Şube', parentTeamId: parent }), 201).id);
    expect((await admin.req('PATCH', `/v1/teams/${parent}`, { parentTeamId: child })).body.code).toBe('TEAM_HIERARCHY_CYCLE');
    const boss = await member(admin, 'manager', { teamId: parent, teamRole: 'manager' });
    const rep = await member(admin, 'sales_rep', { teamId: child });
    const outsider = await member(admin, 'sales_rep');
    const acc = ok(await rep.c.post('/v1/accounts', { name: 'Şube müşterisi', segments: ['b2b'] }), 201);
    expect((await boss.c.get(`/v1/accounts/${String(acc.id)}`)).status).toBe(200);
    // managed_teams_only, and only an Admin appoints managers.
    ok(await boss.c.put(`/v1/teams/${child}/members/${outsider.userId}`, { role: 'member' }));
    expect((await boss.c.put(`/v1/teams/${child}/members/${outsider.userId}`, { role: 'manager' })).body.code).toBe('MANAGER_LIMIT');
    const other = await team(admin, 'Başka');
    expect((await boss.c.put(`/v1/teams/${other}/members/${outsider.userId}`, {})).body.code).toBe('MANAGER_LIMIT');
    expect((await rep.c.post('/v1/teams', { name: 'x' })).status).toBe(403);
    // The manager lists only members of managed teams.
    const users = ok(await boss.c.get('/v1/users')).data as Json[];
    expect(users.map((u) => u.userId).sort()).toEqual([boss.userId, rep.userId, outsider.userId].sort());
  });

  it('A04: a manager invites a sales rep into a managed team with their own segments only', async () => {
    const { c: admin } = await workspace();
    const t1 = await team(admin);
    const mgr = await member(admin, 'manager', { segments: ['b2b'], teamId: t1, teamRole: 'manager' });
    const email = `${uniq('yeni')}@firma.test`;
    expect((await mgr.c.post('/v1/invitations', { email, roleKey: 'sales_rep' })).body.code).toBe('MANAGER_LIMIT');
    expect((await mgr.c.post('/v1/invitations', { email, roleKey: 'call_agent', teamId: t1 })).body.code).toBe('MANAGER_LIMIT');
    expect((await mgr.c.post('/v1/invitations', { email, roleKey: 'admin', teamId: t1 })).body.code).toBe('MANAGER_LIMIT');
    expect((await mgr.c.post('/v1/invitations', { email, roleKey: 'sales_rep', teamId: t1, segments: ['b2c'] })).body.code).toBe('MANAGER_LIMIT');
    ok(await mgr.c.post('/v1/invitations', { email, roleKey: 'sales_rep', teamId: t1 }), 201);
    const c = new Client(h.app);
    ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: 'Yeni' }));
    const l = ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
    const access = ok(await admin.get(`/v1/users/${(l.user as { id: string }).id}/access`));
    expect(access).toMatchObject({ roles: ['sales_rep'], segments: [{ segment: 'b2b', validUntil: null }], teams: [{ teamId: t1, role: 'member' }] });
  });

  it('role changes and expired segment grants apply on the next request', async () => {
    const { c: admin, tenantId } = await workspace();
    const second = await member(admin, 'admin');
    const rep = await member(admin, 'sales_rep');
    ok(await second.c.get('/v1/users'));
    ok(await admin.put(`/v1/users/${second.userId}/roles`, { roles: ['sales_rep'] }));
    expect((await second.c.get('/v1/users')).status).toBe(403);
    expect((await admin.put(`/v1/users/${rep.userId}/roles`, { roles: ['nope'] })).status).toBe(400);
    const acc = ok(await admin.post('/v1/accounts', { name: 'Süreli', segments: ['b2b'], ownerUserId: rep.userId }), 201);
    expect((await rep.c.get(`/v1/accounts/${String(acc.id)}`)).status).toBe(200);
    await superQuery(SUPER(), `UPDATE user_segment_grants SET valid_until = now() - interval '1 minute' WHERE tenant_id = $1 AND user_id = $2`, [tenantId, rep.userId]);
    expect((await rep.c.get(`/v1/accounts/${String(acc.id)}`)).status).toBe(404);
  });
});

describe('field-level security (Faz 4 kabul: gizli alan filtre/sıralama ile sızdırılamaz)', () => {
  it('hidden fields vanish from responses, filters, sorting and field selection; read-only fields reject writes', async () => {
    const { c: admin } = await workspace();
    const rep = await member(admin, 'sales_rep');
    const opp = ok(await rep.c.post('/v1/opportunities', { name: 'Gizli tutar', segment: 'b2b', amount: '90000', competitor: 'Rakip AŞ' }), 201);
    const roles = ok(await admin.get('/v1/roles')).data as Json[];
    const repRole = String(roles.find((r) => r.key === 'sales_rep')!.id);
    const adminRole = String(roles.find((r) => r.key === 'admin')!.id);
    ok(await admin.put('/v1/field-policies', { roleId: repRole, resourceType: 'opportunity', field: 'amount', access: 'hidden' }));
    ok(await admin.put('/v1/field-policies', { roleId: repRole, resourceType: 'opportunity', field: 'competitor', access: 'read' }));
    expect((await admin.put('/v1/field-policies', { roleId: adminRole, resourceType: 'opportunity', field: 'amount', access: 'hidden' })).status).toBe(400);
    expect((await admin.put('/v1/field-policies', { roleId: repRole, resourceType: 'opportunity', field: 'nope', access: 'hidden' })).body.code).toBe('UNKNOWN_FIELD');

    const url = `/v1/opportunities/${String(opp.id)}`;
    const seen = ok(await rep.c.get(url));
    expect(seen).not.toHaveProperty('amount');
    expect(seen.competitor).toBe('Rakip AŞ');
    // Filtering, sorting and selecting a hidden field answer exactly like a field that does not exist.
    for (const q of ['q=' + encodeURIComponent('amount > 50000'), 'sort=amount', 'fields=amount']) {
      const r = await rep.c.get(`/v1/opportunities?${q}`);
      expect(r.body.code, q).toBe('UNKNOWN_FIELD');
      expect(String(r.body.detail)).not.toContain('hidden');
    }
    const nonexistent = await rep.c.get(`/v1/opportunities?q=${encodeURIComponent('zzz > 1')}`);
    expect(nonexistent.body.code).toBe('UNKNOWN_FIELD');
    // Writes: hidden → 403 without naming it; read-only → 403 naming it.
    const w1 = await rep.c.patchJson(url, { amount: '1' }, '"1"');
    expect(w1.status).toBe(403);
    expect(w1.body.code).toBe('FIELD_READ_ONLY');
    expect(JSON.stringify(w1.body)).not.toContain('amount');
    expect((await rep.c.patchJson(url, { competitor: 'x' }, '"1"')).body).toMatchObject({ code: 'FIELD_READ_ONLY', field: 'competitor' });
    expect(ok(await rep.c.patchJson(url, { name: 'Serbest alan' }, '"1"')).name).toBe('Serbest alan');
    // The Admin still sees and filters on it.
    expect(ok(await admin.get(url)).amount).toBe('90000.00');
    expect(ids(await admin.get(`/v1/opportunities?q=${encodeURIComponent('amount > 50000')}`))).toEqual([opp.id]);
    // Lifting the restriction applies on the next request.
    ok(await admin.put('/v1/field-policies', { roleId: repRole, resourceType: 'opportunity', field: 'amount', access: null }));
    expect(ok(await rep.c.get(url)).amount).toBe('90000.00');
  });
});
