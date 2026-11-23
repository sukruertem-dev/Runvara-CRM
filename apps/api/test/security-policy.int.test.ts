import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, generateTotpCode, PASSWORD, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P7d (TEN-04, docs/p7-plan.md §18–19): the tenant security policy is applied whenever a session is bound to
// the tenant (login, selection, refresh), with in-place remedies and no self-lockout.

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const SUPER = () => process.env.TEST_SUPER_DATABASE_URL!;
const sql = (text: string, values: unknown[] = []) => superQuery<Json>(SUPER(), text, values);
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

const DEFAULTS: Record<string, Json> = {
  mfa: { require: 'off', ssoSatisfies: true },
  password: { minLength: 12, requireMixed: false, maxAgeDays: 0 },
  session: { idleMinutes: 10_080, maxHours: 720 },
  sso: { required: false, adminPasswordFallback: true },
};

/** Writes the tenant layer of `security` on top of whatever version is current. A layer replaces whole
 *  groups, so each group given is completed with the platform defaults. */
async function setPolicy(admin: Client, groups: Record<string, Json>): Promise<Res> {
  const head = ok(await admin.get('/v1/config/security?scope=tenant'));
  const value = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { ...DEFAULTS[k], ...v }]));
  return admin.req('PUT', '/v1/config/security?scope=tenant', { value }, { 'if-match': `"${String(head.version)}"` });
}

/** TOTP enrolment in the given session; returns the secret and the recovery codes. */
async function enrol(c: Client): Promise<{ secret: string; recovery: string[] }> {
  const setup = ok(await c.post('/v1/me/mfa/totp/setup'));
  const confirm = ok(await c.post('/v1/me/mfa/totp/confirm', { code: generateTotpCode(setup.secret as string) }));
  return { secret: setup.secret as string, recovery: confirm.recoveryCodes as string[] };
}

async function invite(admin: Client, role = 'sales_rep'): Promise<{ email: string }> {
  const email = `${uniq(role)}@firma.test`;
  ok(await admin.post('/v1/invitations', { email, roleKey: role }), 201);
  ok(await new Client(h.app).post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: PASSWORD, displayName: role }));
  return { email };
}

async function login(email: string, password = PASSWORD): Promise<{ c: Client; body: Json }> {
  const c = new Client(h.app);
  const body = ok(await c.post('/v1/auth/login', { email, password }));
  return { c, body };
}

const refresh = (c: Client) => c.post('/v1/auth/refresh', undefined, c.withCsrf());

/** The session id inside the client's access token. */
function sid(c: Client): string {
  const payload = JSON.parse(Buffer.from((c.accessToken ?? '').split('.')[1] ?? '', 'base64url').toString('utf8')) as { sid: string };
  return payload.sid;
}

describe('two-step verification policy', () => {
  it('refuses a policy its writer could not meet, then blocks members without a second factor until they enrol', async () => {
    const admin = await signupAndLogin(h);
    const lock = await setPolicy(admin.c, { mfa: { require: 'all' } });
    expect(lock.status).toBe(422);
    expect(lock.body).toMatchObject({ code: 'SECURITY_POLICY_LOCKOUT', reasons: ['self_mfa'] });

    const m = await invite(admin.c);
    const early = await login(m.email); // a tenant session opened before the policy
    expect(early.body.tenant).toMatchObject({ id: admin.tenantId });

    await enrol(admin.c);
    ok(await setPolicy(admin.c, { mfa: { require: 'all' } }));

    // Login: the session opens without the tenant; selecting it explains why.
    const later = await login(m.email);
    expect(later.body).toMatchObject({ next: 'select_tenant', tenant: null });
    const blocked = await later.c.post('/v1/auth/tenant', { tenantId: admin.tenantId });
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ code: 'TENANT_MFA_REQUIRED', enrolled: false });

    // Refresh: the session opened before the policy loses the tenant on its next token.
    const r = ok(await refresh(early.c));
    expect(r.tenant).toBeNull();

    // Enrolling proves the factor in this session: the tenant opens.
    const { recovery } = await enrol(later.c);
    expect(ok(await later.c.post('/v1/auth/tenant', { tenantId: admin.tenantId })).tenant).toMatchObject({ id: admin.tenantId });

    // The early session belongs to an account that is now enrolled, but was opened without the factor.
    const again = await early.c.post('/v1/auth/tenant', { tenantId: admin.tenantId });
    expect(again.body).toMatchObject({ code: 'TENANT_MFA_REQUIRED', enrolled: true });
    expect((await early.c.post('/v1/auth/step-up', { recoveryCode: 'yanlis-kod-123' })).body.code).toBe('MFA_INVALID');
    ok(await early.c.post('/v1/auth/step-up', { recoveryCode: recovery[0] }));
    expect(ok(await early.c.post('/v1/auth/tenant', { tenantId: admin.tenantId })).tenant).toMatchObject({ id: admin.tenantId });

    const events = await sql(`SELECT kind FROM auth_events e JOIN users u ON u.id = e.user_id WHERE u.email = $1 AND kind = 'auth.step_up'`, [m.email]);
    expect(events).toHaveLength(1);
  });

  it('"admins" applies to Admins only', async () => {
    const admin = await signupAndLogin(h);
    await enrol(admin.c);
    ok(await setPolicy(admin.c, { mfa: { require: 'admins' } }));
    const m = await invite(admin.c);
    expect((await login(m.email)).body.tenant).toMatchObject({ id: admin.tenantId });
    const second = await invite(admin.c, 'admin');
    const blocked = await login(second.email);
    expect(blocked.body.tenant).toBeNull();
    expect((await blocked.c.post('/v1/auth/tenant', { tenantId: admin.tenantId })).body.code).toBe('TENANT_MFA_REQUIRED');
  });
});

describe('password policy', () => {
  it('asks for a new password that meets the tenant rules and ends the other sessions', async () => {
    const admin = await signupAndLogin(h);
    ok(await setPolicy(admin.c, { password: { minLength: 24, requireMixed: true } }));
    const m = await invite(admin.c);
    const other = await login(m.email);
    const s = await login(m.email);
    const blocked = await s.c.post('/v1/auth/tenant', { tenantId: admin.tenantId });
    expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED', reasons: ['too_short'] });

    expect((await s.c.post('/v1/me/password', { currentPassword: 'yanlis-parola-123', newPassword: 'Uzun-ve-Karma-Parola-2026-xyz' })).body.code).toBe('INVALID_CREDENTIALS');
    const weak = await s.c.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'kucuk-harfli-uzun-parola-yeterli-degil', tenantId: admin.tenantId });
    expect(weak.body).toMatchObject({ code: 'PASSWORD_POLICY', reasons: ['needs_mixed'] });
    const same = await s.c.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.body).toMatchObject({ code: 'PASSWORD_POLICY', reasons: ['same_as_current'] });
    const outsider = await signupAndLogin(h);
    expect((await s.c.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'Uzun-ve-Karma-Parola-2026-xyz', tenantId: outsider.tenantId })).status).toBe(404);

    ok(await s.c.post('/v1/me/password', { currentPassword: PASSWORD, newPassword: 'Uzun-ve-Karma-Parola-2026-xyz', tenantId: admin.tenantId }), 204);
    expect(ok(await s.c.post('/v1/auth/tenant', { tenantId: admin.tenantId })).tenant).toMatchObject({ id: admin.tenantId });
    expect((await refresh(other.c)).status).toBe(401);
    // The measure is kept, never the password.
    const [row] = await sql(`SELECT password_profile FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1 AND s.revoked_at IS NULL`, [m.email]);
    expect(row!.password_profile).toEqual({ length: 29, mixed: true });
    // A fresh login measures the new password and passes.
    expect((await login(m.email, 'Uzun-ve-Karma-Parola-2026-xyz')).body.tenant).toMatchObject({ id: admin.tenantId });
  });

  it('expires passwords older than the maximum age', async () => {
    const admin = await signupAndLogin(h);
    ok(await setPolicy(admin.c, { password: { maxAgeDays: 30 } }));
    const m = await invite(admin.c);
    expect((await login(m.email)).body.tenant).toMatchObject({ id: admin.tenantId });
    await sql(`ALTER TABLE user_credentials DISABLE TRIGGER user_credentials_touch`);
    try {
      await sql(`UPDATE user_credentials SET updated_at = now() - interval '31 days' WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [m.email]);
    } finally {
      await sql(`ALTER TABLE user_credentials ENABLE TRIGGER user_credentials_touch`);
    }
    const s = await login(m.email);
    expect(s.body.tenant).toBeNull();
    expect((await s.c.post('/v1/auth/tenant', { tenantId: admin.tenantId })).body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED', reasons: ['expired'] });
  });

  it('rejects values outside the allowed ranges', async () => {
    const admin = await signupAndLogin(h);
    expect((await setPolicy(admin.c, { password: { maxAgeDays: 10 } })).body.code).toBe('CONFIG_INVALID');
    expect((await setPolicy(admin.c, { password: { minLength: 8 } })).body.code).toBe('CONFIG_INVALID');
    expect((await setPolicy(admin.c, { session: { idleMinutes: 5 } })).body.code).toBe('CONFIG_INVALID');
  });
});

describe('session length', () => {
  it('ends idle and too old tenant sessions on refresh', async () => {
    const admin = await signupAndLogin(h);
    ok(await setPolicy(admin.c, { session: { idleMinutes: 15, maxHours: 2 } }));
    const m = await invite(admin.c);
    const idle = await login(m.email);
    const old = await login(m.email);
    ok(await refresh(idle.c));
    ok(await refresh(old.c));
    await sql(`UPDATE auth_sessions SET last_used_at = now() - interval '20 minutes' WHERE id = $1`, [sid(idle.c)]);
    await sql(`UPDATE auth_sessions SET created_at = now() - interval '3 hours' WHERE id = $1`, [sid(old.c)]);
    expect((await refresh(idle.c)).body.code).toBe('REFRESH_INVALID');
    expect((await refresh(old.c)).body.code).toBe('REFRESH_INVALID');
    const after = await sql(`SELECT id, revoke_reason FROM auth_sessions WHERE id = ANY ($1::uuid[])`, [[sid(idle.c), sid(old.c)]]);
    expect(Object.fromEntries(after.map((r) => [r.id, r.revoke_reason]))).toEqual({ [sid(idle.c)]: 'policy_idle', [sid(old.c)]: 'policy_max_age' });
    // The Admin's own session is untouched.
    ok(await refresh(admin.c));
  });
});

describe('single sign-on required', () => {
  it('needs an enabled provider, keeps Admins in by password, and sends members to SSO', async () => {
    const admin = await signupAndLogin(h);
    expect((await setPolicy(admin.c, { sso: { required: true } })).body).toMatchObject({ code: 'SECURITY_POLICY_LOCKOUT', reasons: ['no_provider'] });
    const provider = ok(await admin.c.post('/v1/sso-providers', { kind: 'oidc', name: 'Kurumsal', issuer: 'http://localhost:1/', clientId: 'c', clientSecret: 's', emailDomains: ['firma.test'] }), 201);
    expect((await setPolicy(admin.c, { sso: { required: true, adminPasswordFallback: false } })).body).toMatchObject({ code: 'SECURITY_POLICY_LOCKOUT', reasons: ['self_sso'] });
    ok(await setPolicy(admin.c, { sso: { required: true } }));

    const m = await invite(admin.c);
    const s = await login(m.email);
    expect(s.body.tenant).toBeNull();
    const blocked = await s.c.post('/v1/auth/tenant', { tenantId: admin.tenantId });
    expect(blocked.body).toMatchObject({ code: 'TENANT_SSO_REQUIRED', providers: [{ id: provider.id, name: 'Kurumsal', kind: 'oidc', startUrl: `http://api.flexa.test/v1/auth/oidc/${String(provider.id)}/start` }] });
    // Admins keep password sign-in (break-glass, B79).
    expect((await login(admin.email)).body.tenant).toMatchObject({ id: admin.tenantId });

    // The last enabled provider stays while SSO is required.
    expect((await admin.c.req('PATCH', `/v1/sso-providers/${String(provider.id)}`, { enabled: false })).body.code).toBe('SECURITY_POLICY_LOCKOUT');
    expect((await admin.c.del(`/v1/sso-providers/${String(provider.id)}`)).body.code).toBe('SECURITY_POLICY_LOCKOUT');
    ok(await setPolicy(admin.c, { sso: { required: false } }));
    ok(await admin.c.del(`/v1/sso-providers/${String(provider.id)}`), 204);
    expect(ok(await s.c.post('/v1/auth/tenant', { tenantId: admin.tenantId })).tenant).toMatchObject({ id: admin.tenantId });
  });

  it('is never carried by a configuration bundle', async () => {
    const admin = await signupAndLogin(h);
    await enrol(admin.c);
    ok(await setPolicy(admin.c, { mfa: { require: 'all' } }));
    const bundle = ok(await admin.c.get('/v1/config/export'));
    expect(JSON.stringify(bundle)).not.toContain('"security"');
  });
});
