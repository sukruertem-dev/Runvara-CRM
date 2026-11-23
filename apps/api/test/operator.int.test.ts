import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { gunzipSync } from 'node:zlib';
import { DeletionService } from '../src/modules/privacy/deletion.service';
import { ExportsService } from '../src/modules/privacy/exports.service';
import { Client, generateTotpCode, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P7c (docs/p7-plan.md §13–15): platform operator console, support access the tenant approves, lifecycle,
// tenant data export and deletion.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
type Json = Record<string, unknown>;
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(SUPER(), text, values);

/** An operator account signed in with a second factor (a recovery code: no 30 s TOTP window to race). */
async function operator(): Promise<{ c: Client; email: string; userId: string }> {
  const { c, email } = await signupAndLogin(h);
  const setup = ok(await c.post('/v1/me/mfa/totp/setup'));
  const confirm = ok(await c.post('/v1/me/mfa/totp/confirm', { code: generateTotpCode(setup.secret as string) }));
  const [u] = await sql('SELECT id FROM users WHERE email = $1', [email]);
  await sql('INSERT INTO platform_operators (user_id) VALUES ($1)', [u!.id]);
  const op = new Client(h.app);
  const step = ok(await op.post('/v1/auth/login', { email, password: PASSWORD }));
  ok(await op.post('/v1/auth/mfa/verify', { mfaToken: step.mfaToken, recoveryCode: (confirm.recoveryCodes as string[])[0] }));
  return { c: op, email, userId: String(u!.id) };
}

async function member(admin: Client, role: string): Promise<Client> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  const c = new Client(h.app);
  ok(await c.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  ok(await c.post('/v1/auth/login', { email, password: PASSWORD }));
  return c;
}

describe('operator console (TEN-01/02/09)', () => {
  it('needs the operator mark and a second factor, and shows metadata only', async () => {
    const plain = await signupAndLogin(h);
    expect((await plain.c.get('/v1/operator/tenants')).body.code).toBe('OPERATOR_REQUIRED');
    const [u] = await sql('SELECT id FROM users WHERE email = $1', [plain.email]);
    await sql('INSERT INTO platform_operators (user_id) VALUES ($1)', [u!.id]);
    expect((await plain.c.get('/v1/operator/tenants')).body.code).toBe('OPERATOR_MFA_REQUIRED');
    expect(ok(await plain.c.get('/v1/me')).operator).toBe(true);

    const op = await operator();
    const list = ok(await op.c.get('/v1/operator/tenants')).data as Json[];
    const row = list.find((t) => t.id === plain.tenantId);
    expect(row).toMatchObject({ slug: plain.slug, status: 'trial', members: 1, plan: { id: 'trial' } });
    expect(Object.keys(row ?? {}).sort()).toEqual(['createdAt', 'deletionScheduledAt', 'id', 'members', 'name', 'plan', 'salesMode', 'slug', 'status', 'statusChangedAt']);
  });

  it('opens a tenant whose first Admin is invited, changes the plan and the status', async () => {
    const op = await operator();
    const slug = uniq('op-');
    const adminEmail = `${uniq('first')}@firma.test`;
    const created = ok(await op.c.post('/v1/operator/tenants', { name: 'Kuzey Lojistik', slug, adminEmail, plan: 'starter' }), 201);
    expect(created).toMatchObject({ slug, status: 'active', members: 0, plan: { id: 'starter' } });
    const admin = new Client(h.app);
    ok(await admin.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', adminEmail), password: PASSWORD, displayName: 'İlk Admin' }));
    ok(await admin.post('/v1/auth/login', { email: adminEmail, password: PASSWORD }));
    expect(ok(await admin.get('/v1/me/navigation')).roles).toEqual(['admin']);

    const id = String(created.id);
    expect((await admin.post('/v1/modules/crm/enable')).status).toBe(200);
    expect((await admin.post('/v1/modules/sales_b2b/enable')).body.code).toBe('MODULE_NOT_IN_PLAN');
    expect((await op.c.req('PUT', `/v1/operator/tenants/${id}/plan`, { plan: 'growth', addOns: ['crm'], reason: 'yükseltme' })).status).toBe(400);
    ok(await op.c.req('PUT', `/v1/operator/tenants/${id}/plan`, { plan: 'growth', addOns: ['dialer'], limitOverrides: { users: 75 }, reason: 'yıllık sözleşme' }));
    ok(await admin.post('/v1/modules/sales_b2b/enable'));
    expect(ok(await admin.get('/v1/usage')).dimensions).toEqual(expect.arrayContaining([expect.objectContaining({ dimension: 'users', limit: 75 })]));

    ok(await op.c.post(`/v1/operator/tenants/${id}/status`, { to: 'suspended', reason: 'ödeme gecikti' }));
    expect((await admin.get('/v1/tenant')).status).toBe(403);
    expect((await op.c.post(`/v1/operator/tenants/${id}/status`, { to: 'suspended', reason: 'tekrar' })).body.code).toBe('TENANT_TRANSITION_INVALID');
    ok(await op.c.post(`/v1/operator/tenants/${id}/status`, { to: 'active', reason: 'ödeme alındı' }));
    ok(await admin.get('/v1/tenant'));

    const detail = ok(await op.c.get(`/v1/operator/tenants/${id}`));
    expect(detail.modules).toEqual(expect.arrayContaining(['crm', 'sales_b2b']));
    expect((detail.actions as Json[]).map((a) => a.action)).toEqual(['tenant.status_changed', 'tenant.status_changed', 'tenant.plan_changed', 'tenant.created']);
    const audits = await sql(`SELECT action FROM audit_log WHERE tenant_id = $1 AND actor_type = 'operator' ORDER BY at`, [id]);
    expect(audits.map((a) => a.action)).toEqual(['tenant.created', 'tenant.plan_changed', 'tenant.status_changed', 'tenant.status_changed']);
  });
});

describe('support access (TEN-08)', () => {
  it('starts only after the Admin approves, is read-only and audited, and ends on revoke', async () => {
    const ws = await signupAndLogin(h);
    ok(await ws.c.post('/v1/modules/crm/enable'));
    const account = ok(await ws.c.post('/v1/accounts', { name: 'Atlas A.Ş.', segments: ['b2b'] }), 201);
    const op = await operator();

    const grant = ok(await op.c.post(`/v1/operator/tenants/${ws.tenantId}/support`, { reason: 'Rapor hatasını incelemek için', durationMinutes: 60 }), 201);
    expect(grant).toMatchObject({ status: 'pending', validUntil: null });
    expect(h.mailer.jobs.some((j) => j.template === 'support_request' && j.to === ws.email)).toBe(true);
    expect((await op.c.post(`/v1/operator/support/${String(grant.id)}/enter`)).body.code).toBe('SUPPORT_ACCESS_ENDED');

    const approved = ok(await ws.c.post(`/v1/support-access/${String(grant.id)}/approve`, { note: 'Bugün için' }));
    expect(approved.status).toBe('approved');
    const session = ok(await op.c.post(`/v1/operator/support/${String(grant.id)}/enter`));
    expect(session.tenant).toMatchObject({ id: ws.tenantId, roles: ['support'] });

    // Reads what the Admin could read; writes nothing.
    expect(ok(await op.c.get(`/v1/accounts/${String(account.id)}`)).name).toBe('Atlas A.Ş.');
    expect((await op.c.post('/v1/accounts', { name: 'Yeni', segments: ['b2b'] })).body.code).toBe('SUPPORT_READ_ONLY');
    expect((await op.c.post(`/v1/support-access/${String(grant.id)}/revoke`)).status).toBe(403);
    const nav = ok(await op.c.get('/v1/me/navigation'));
    expect(nav.support).toMatchObject({ role: 'operator', grantId: grant.id });
    expect(ok(await ws.c.get('/v1/me/navigation')).support).toMatchObject({ role: 'observed', grantId: grant.id });
    // The refreshed token stays in the tenant while the grant lasts.
    ok(await op.c.post('/v1/auth/refresh', undefined, op.c.withCsrf()));
    ok(await op.c.get('/v1/tenant'));
    const trail = await sql(`SELECT details FROM audit_log WHERE tenant_id = $1 AND action = 'support.request'`, [ws.tenantId]);
    expect(trail.map((r) => (r.details as Json).path)).toEqual(expect.arrayContaining([`/v1/accounts/${String(account.id)}`, '/v1/me/navigation', '/v1/tenant']));

    ok(await ws.c.post(`/v1/support-access/${String(grant.id)}/revoke`));
    expect((await op.c.get('/v1/tenant')).body.code).toBe('SUPPORT_ACCESS_ENDED');
    const out = ok(await op.c.post('/v1/operator/support/exit'));
    expect(out.tenant).toBeNull();
    expect(ok(await op.c.get('/v1/operator/support')).data).toEqual([expect.objectContaining({ id: grant.id, status: 'revoked' })]);
  });

  it('narrows to granted modules, expires on time and stays out of other tenants', async () => {
    const ws = await signupAndLogin(h);
    ok(await ws.c.post('/v1/modules/crm/enable'));
    const other = await signupAndLogin(h);
    const op = await operator();
    const grant = ok(await op.c.post(`/v1/operator/tenants/${ws.tenantId}/support`, { reason: 'Yalnızca görevler incelenecek', modules: ['core'], durationMinutes: 15 }), 201);
    ok(await ws.c.post(`/v1/support-access/${String(grant.id)}/approve`, {}));
    ok(await op.c.post(`/v1/operator/support/${String(grant.id)}/enter`));
    ok(await op.c.get('/v1/tasks'));
    expect((await op.c.get('/v1/accounts')).body.code).toBe('MODULE_DISABLED');
    // A manager of the tenant cannot see or decide support requests.
    const manager = await member(ws.c, 'manager');
    expect((await manager.get('/v1/support-access')).status).toBe(403);
    // Another tenant knows nothing about it.
    expect(ok(await other.c.get('/v1/support-access')).data).toEqual([]);
    expect((await other.c.post(`/v1/support-access/${String(grant.id)}/revoke`)).status).toBe(404);
    // Time over: the next request is refused.
    await sql(`UPDATE support_access_grants SET valid_until = now() - interval '1 second' WHERE id = $1`, [grant.id]);
    expect((await op.c.get('/v1/tasks')).body.code).toBe('SUPPORT_ACCESS_ENDED');
    expect(ok(await ws.c.get('/v1/support-access')).data).toEqual([expect.objectContaining({ id: grant.id, status: 'expired' })]);
  });
});

describe('export and deletion (TEN-05)', () => {
  it('exports every tenant table without secrets; another tenant cannot download it', async () => {
    const ws = await signupAndLogin(h);
    ok(await ws.c.post('/v1/tasks', { title: 'Dışa aktarılacak görev' }), 201);
    const other = await signupAndLogin(h);
    const ex = ok(await ws.c.post('/v1/tenant/exports'), 202);
    expect((await ws.c.post('/v1/tenant/exports')).status).toBe(409);
    expect((await ws.c.get(`/v1/tenant/exports/${String(ex.id)}/download`)).body.code).toBe('EXPORT_NOT_READY');
    await h.app.get(ExportsService).run(ws.tenantId, String(ex.id));
    const list = ok(await ws.c.get('/v1/tenant/exports')).data as Json[];
    expect(list[0]).toMatchObject({ id: ex.id, status: 'ready', requestedAs: 'admin' });
    expect(Number(list[0]?.rowCount)).toBeGreaterThan(10);
    const link = ok(await ws.c.get(`/v1/tenant/exports/${String(ex.id)}/download`));
    const file = gunzipSync(Buffer.from(await (await fetch(String(link.url))).arrayBuffer())).toString('utf8');
    const lines = file.trim().split('\n').map((l) => JSON.parse(l) as Json);
    expect(lines[0]).toMatchObject({ format: 'flexa.export/1', tenantId: ws.tenantId });
    const tables = new Set(lines.slice(1).map((l) => l.table));
    expect([...tables]).toEqual(expect.arrayContaining(['tenants', 'users', 'tasks', 'workflows', 'memberships', 'audit_log']));
    expect(tables.has('tenant_keys')).toBe(false);
    expect(file).not.toMatch(/token_hash|wrapped_dek|secret_enc|key_hash/);
    expect(lines.some((l) => l.table === 'tasks' && (l.row as Json).title === 'Dışa aktarılacak görev')).toBe(true);
    expect(lines.filter((l) => l.table === 'tenants').map((l) => (l.row as Json).id)).toEqual([ws.tenantId]);
    expect((await other.c.get(`/v1/tenant/exports/${String(ex.id)}/download`)).status).toBe(404);
  });

  it('schedules deletion with a grace period, can cancel, then purges every row and file', async () => {
    const ws = await signupAndLogin(h);
    const rep = await member(ws.c, 'sales_rep');
    expect((await rep.post('/v1/tenant/deletion', { confirmSlug: ws.slug })).status).toBe(403);
    expect((await ws.c.post('/v1/tenant/deletion', { confirmSlug: 'baska-adres' })).status).toBe(400);
    const state = ok(await ws.c.post('/v1/tenant/deletion', { confirmSlug: ws.slug }));
    expect(state).toMatchObject({ status: 'pending_deletion', graceDays: 30 });
    // Only the deletion, export and shell routes stay open; reading data is not.
    expect((await ws.c.get('/v1/tasks')).body.code).toBe('TENANT_PENDING_DELETION');
    ok(await ws.c.get('/v1/tenant'));
    expect(ok(await ws.c.get('/v1/me/navigation')).tenantStatus).toBe('pending_deletion');
    ok(await ws.c.post('/v1/tenant/deletion/cancel'));
    expect(ok(await ws.c.get('/v1/tenant')).status).toBe('trial');
    ok(await ws.c.get('/v1/tasks'));

    // Again, with an export file in storage; the grace period ends.
    const ex = ok(await ws.c.post('/v1/tenant/exports'), 202);
    await h.app.get(ExportsService).run(ws.tenantId, String(ex.id));
    const [file] = await sql('SELECT object_key FROM tenant_exports WHERE id = $1', [ex.id]);
    ok(await ws.c.post('/v1/tenant/deletion', { confirmSlug: ws.slug }));
    await sql(`UPDATE tenants SET deletion_scheduled_at = now() - interval '1 minute' WHERE id = $1`, [ws.tenantId]);
    const purged = await h.app.get(DeletionService).runDue();
    expect(purged).toContain(ws.tenantId);
    const [tenant] = await sql('SELECT status FROM tenants WHERE id = $1', [ws.tenantId]);
    expect(tenant?.status).toBe('deleted');
    const left = await sql(`SELECT count(*)::int AS n FROM tasks WHERE tenant_id = $1`, [ws.tenantId]);
    expect(left[0]?.n).toBe(0);
    expect((await fetch(`${process.env.TEST_S3_ENDPOINT!}/flexa-test/${String(file?.object_key)}`)).status).toBe(404);
    // The Admin's account belonged only to this workspace: it is anonymised and cannot sign in.
    expect((await new Client(h.app).post('/v1/auth/login', { email: ws.email, password: PASSWORD })).status).toBe(401);
  });
});
