import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '@runvara/contracts';
import { superQuery } from '@runvara/db/testing';
import { Client, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

async function invite(admin: Client, email: string, roleKey = 'sales_rep') {
  return admin.post('/v1/invitations', { email, roleKey });
}

describe('invitations', () => {
  it('a new address accepts, gets a verified account and the invited role', async () => {
    const a = await signupAndLogin(h);
    const email = `${uniq('can')}@firma.test`;
    const inv = await invite(a.c, email);
    expect(inv.status).toBe(201);
    const token = h.mailer.tokenFrom('invitation', email);
    const anon = new Client(h.app);
    expect((await anon.post('/v1/invitations/preview', { token })).body).toMatchObject({ email, roleKey: 'sales_rep', accountExists: false });
    const acc = await anon.post('/v1/invitations/accept', { token, password: PASSWORD, displayName: 'Can Öz' });
    expect(acc.body).toEqual({ tenantId: a.tenantId, userCreated: true });
    expect((await anon.post('/v1/invitations/accept', { token, password: PASSWORD, displayName: 'Can Öz' })).status).toBe(410);
    const login = await anon.post('/v1/auth/login', { email, password: PASSWORD });
    expect(login.body).toMatchObject({ next: 'done', tenant: { id: a.tenantId, roles: ['sales_rep'] } });
  });

  it('an existing account must be signed in as itself; then it chooses between tenants', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    await invite(a.c, b.email, 'manager');
    const token = h.mailer.tokenFrom('invitation', b.email);
    const anon = new Client(h.app);
    expect((await anon.post('/v1/invitations/accept', { token })).status).toBe(401);
    const stranger = await signupAndLogin(h);
    expect((await stranger.c.post('/v1/invitations/accept', { token })).body.code).toBe('INVITATION_EMAIL_MISMATCH');
    expect((await b.c.post('/v1/invitations/accept', { token })).body).toEqual({ tenantId: a.tenantId, userCreated: false });

    const fresh = new Client(h.app);
    const login = await fresh.post('/v1/auth/login', { email: b.email, password: PASSWORD });
    expect(login.body.next).toBe('select_tenant');
    expect((login.body.tenants as { id: string }[]).map((t) => t.id).sort()).toEqual([a.tenantId, b.tenantId].sort());
    expect((await fresh.get('/v1/tenant')).body.code).toBe('TENANT_REQUIRED');
    const sel = await fresh.post('/v1/auth/tenant', { tenantId: a.tenantId });
    expect(sel.status).toBe(200);
    expect((await fresh.get('/v1/tenant')).body).toMatchObject({ id: a.tenantId });
    // Selecting a tenant the user does not belong to is indistinguishable from a non-existent one.
    expect((await fresh.post('/v1/auth/tenant', { tenantId: stranger.tenantId })).status).toBe(404);
    // Refresh keeps the selected tenant.
    const r = await fresh.post('/v1/auth/refresh', undefined, fresh.withCsrf());
    expect(r.body.tenant).toMatchObject({ id: a.tenantId, roles: ['manager'] });
  });

  it('only Admin may invite (A04: team-scoped Manager invitations wait for teams in P4)', async () => {
    const a = await signupAndLogin(h);
    const email = `${uniq('mgr')}@firma.test`;
    await invite(a.c, email, 'manager');
    const m = new Client(h.app);
    await m.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: 'Mert Kaya' });
    await m.post('/v1/auth/login', { email, password: PASSWORD });
    expect((await invite(m, `${uniq('x')}@firma.test`)).body.code).toBe('MANAGER_LIMIT');
    const repEmail = `${uniq('rep')}@firma.test`;
    await invite(a.c, repEmail, 'sales_rep');
    const rep = new Client(h.app);
    await rep.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', repEmail), password: PASSWORD, displayName: 'Zeynep Arslan' });
    await rep.post('/v1/auth/login', { email: repEmail, password: PASSWORD });
    expect((await invite(rep, `${uniq('y')}@firma.test`)).status).toBe(403);
    expect((await rep.get('/v1/invitations')).status).toBe(403);
  });
});

describe('tenant isolation through the API (Faz 1 kabul kriteri)', () => {
  it('tenant A can neither list nor revoke tenant B invitations, even with the exact id', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    const bInv = await invite(b.c, `${uniq('b')}@firma.test`);
    const list = await a.c.get('/v1/invitations');
    expect((list.body.data as { id: string }[]).map((x) => x.id)).not.toContain(bInv.body.id);
    const revoke = await a.c.post(`/v1/invitations/${String(bInv.body.id)}/revoke`);
    expect(revoke.status).toBe(404);
    const [row] = await superQuery<{ revoked_at: Date | null }>(process.env.TEST_SUPER_DATABASE_URL!, 'SELECT revoked_at FROM invitations WHERE id = $1', [bInv.body.id]);
    expect(row!.revoked_at).toBeNull();
  });

  it('a token for tenant A never yields tenant B data, and the tenant comes only from the token', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    const t = await a.c.get('/v1/tenant', { 'x-tenant-id': b.tenantId });
    expect(t.body.id).toBe(a.tenantId);
    const mods = await a.c.post('/v1/modules/crm/enable?tenantId=' + b.tenantId, { tenantId: b.tenantId });
    expect(mods.status).toBe(200);
    const bState = await superQuery<{ n: number }>(process.env.TEST_SUPER_DATABASE_URL!, `SELECT count(*)::int AS n FROM tenant_modules WHERE tenant_id = $1 AND module_id = 'crm'`, [b.tenantId]);
    expect(bState[0]!.n).toBe(0);
  });
});

describe('modules (MOD-01…03, G1 kabul kriterleri)', () => {
  it('enforces dependencies, refuses to orphan dependents, cascades on request and keeps data', async () => {
    const { c, tenantId } = await signupAndLogin(h);
    const dialer = await c.post('/v1/modules/dialer/enable');
    expect(dialer.status).toBe(422);
    expect(dialer.body).toMatchObject({ code: 'MODULE_DEPENDENCY_UNMET', missing: [['call_center'], ['sales_b2b', 'sales_b2c']] });
    for (const m of ['crm', 'call_center', 'sales_b2b', 'dialer']) expect((await c.post(`/v1/modules/${m}/enable`)).status, m).toBe(200);
    const blocked = await c.post('/v1/modules/call_center/disable');
    expect(blocked.body).toMatchObject({ code: 'MODULE_HAS_DEPENDENTS', dependents: ['dialer'] });
    const cascade = await c.post('/v1/modules/call_center/disable?cascade=true');
    expect(cascade.body).toMatchObject({ disabled: ['call_center', 'dialer'] });
    expect((await c.post('/v1/modules/core/disable')).body.code).toBe('MODULE_ALWAYS_ON');
    expect((await c.post('/v1/modules/payroll/enable')).body.code).toBe('MODULE_UNKNOWN');

    const rows = await superQuery<{ module_id: string; enabled: boolean }>(process.env.TEST_SUPER_DATABASE_URL!, 'SELECT module_id, enabled FROM tenant_modules WHERE tenant_id = $1 ORDER BY module_id', [tenantId]);
    expect(rows).toEqual([
      { module_id: 'call_center', enabled: false }, { module_id: 'core', enabled: true }, { module_id: 'crm', enabled: true },
      { module_id: 'dialer', enabled: false }, { module_id: 'sales_b2b', enabled: true },
    ]);
    const audit = await superQuery<{ n: number }>(process.env.TEST_SUPER_DATABASE_URL!, `SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'module.toggled'`, [tenantId]);
    expect(audit[0]!.n).toBe(5);
  });

  it('two tenants run different module sets; navigation and permissions follow each tenant', async () => {
    const a = await signupAndLogin(h);
    const b = await signupAndLogin(h);
    await a.c.post('/v1/modules/crm/enable');
    const navA = await a.c.get('/v1/me/navigation');
    const navB = await b.c.get('/v1/me/navigation');
    expect((navA.body.modules as { id: string }[]).map((m) => m.id)).toEqual(['core', 'crm']);
    expect((navB.body.modules as { id: string }[]).map((m) => m.id)).toEqual(['core']);
    expect((navA.body.menu as { module: string }[]).some((m) => m.module === 'crm')).toBe(true);
    expect((navB.body.menu as { module: string }[]).some((m) => m.module === 'crm')).toBe(false);
  });
});

describe('route table matches the published contract', () => {
  it('every ENDPOINTS entry is served and every served /v1 route is documented', () => {
    const fastify = h.app.getHttpAdapter().getInstance();
    for (const e of ENDPOINTS) {
      const url = e.path.replace(/\{(\w+)\}/g, ':$1');
      expect(fastify.hasRoute({ method: e.method.toUpperCase() as 'GET', url }), `${e.method} ${e.path}`).toBe(true);
    }
    const served = (fastify as unknown as { runvaraRoutes: string[] }).runvaraRoutes.filter((r) => r.includes(' /v1/'));
    const documented = new Set(ENDPOINTS.map((e) => `${e.method.toUpperCase()} ${e.path.replace(/\{(\w+)\}/g, ':$1')}`));
    expect(served.filter((r) => !documented.has(r))).toEqual([]);
  });
});
