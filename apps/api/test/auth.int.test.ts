import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { Client, generateTotpCode, PASSWORD, signupAndLogin, startHarness, uniq, type Harness } from './harness';

let h: Harness;
beforeAll(async () => { h = await startHarness(); });
afterAll(async () => { await h.close(); });

describe('sign-up and e-mail verification', () => {
  it('creates a trial tenant with the five system roles, Admin membership, core module and a DEK', async () => {
    const { c, tenantId, slug } = await signupAndLogin(h);
    const me = await c.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.tenant).toMatchObject({ id: tenantId, slug, status: 'trial', roles: ['admin'] });
    const rows = await superQuery<{ roles: number; modules: string[]; keys: number; audit: string[] }>(process.env.TEST_SUPER_DATABASE_URL!, `
      SELECT (SELECT count(*)::int FROM roles WHERE tenant_id = $1 AND is_system) AS roles,
             (SELECT array_agg(module_id) FROM tenant_modules WHERE tenant_id = $1 AND enabled) AS modules,
             (SELECT count(*)::int FROM tenant_keys WHERE tenant_id = $1) AS keys,
             (SELECT array_agg(action) FROM audit_log WHERE tenant_id = $1) AS audit`, [tenantId]);
    expect(rows[0]).toEqual({ roles: 5, modules: ['core'], keys: 1, audit: ['tenant.created'] });
  });

  it('refuses login until the e-mail is verified', async () => {
    const c = new Client(h.app);
    const email = `${uniq('nv')}@firma.test`;
    await c.post('/v1/auth/signup', { email, password: PASSWORD, displayName: 'Can Öz', tenantName: 'X', tenantSlug: uniq('nv-') });
    const l = await c.post('/v1/auth/login', { email, password: PASSWORD });
    expect(l.status).toBe(403);
    expect(l.body.code).toBe('EMAIL_NOT_VERIFIED');
    const reused = await c.post('/v1/auth/email/verify', { token: 'x'.repeat(43) });
    expect(reused.status).toBe(410);
  });

  it('does not reveal registered addresses: duplicate sign-up answers 202 and mails the owner', async () => {
    const { email } = await signupAndLogin(h);
    const c = new Client(h.app);
    const r = await c.post('/v1/auth/signup', { email, password: PASSWORD, displayName: 'Taklitçi', tenantName: 'Y', tenantSlug: uniq('dup-') });
    expect(r.status).toBe(202);
    expect(h.mailer.last('signup_exists', email)).toBeTruthy();
  });

  it('rejects taken slugs, weak passwords and invalid bodies with problem+json', async () => {
    const { slug } = await signupAndLogin(h);
    const c = new Client(h.app);
    const taken = await c.post('/v1/auth/signup', { email: `${uniq('s')}@firma.test`, password: PASSWORD, displayName: 'A', tenantName: 'B', tenantSlug: slug });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SLUG_TAKEN');
    const weak = await c.post('/v1/auth/signup', { email: `${uniq('w')}@firma.test`, password: 'kisa', displayName: 'A', tenantName: 'B', tenantSlug: uniq('w-') });
    expect(weak.status).toBe(422);
    expect(weak.body).toMatchObject({ code: 'PASSWORD_POLICY', reasons: ['too_short'] });
    const bad = await c.post('/v1/auth/signup', { email: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
    expect(bad.body).toMatchObject({ code: 'VALIDATION_FAILED', status: 400 });
    expect((bad.body.errors as unknown[]).length).toBeGreaterThan(1);
  });
});

describe('login protection', () => {
  it('answers 401 for unknown and wrong credentials identically, then locks after 10 failures', async () => {
    const { email } = await signupAndLogin(h);
    const c = new Client(h.app);
    const unknown = await c.post('/v1/auth/login', { email: `${uniq('ghost')}@firma.test`, password: PASSWORD });
    const wrong = await c.post('/v1/auth/login', { email, password: 'yanlis-parola-123' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.code).toBe(wrong.body.code);
    for (let i = 0; i < 9; i++) await c.post('/v1/auth/login', { email, password: 'yanlis-parola-123' });
    const locked = await c.post('/v1/auth/login', { email, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('TOTP second factor (Faz 1: kayıt → giriş → 2FA → tenant seçimi)', () => {
  it('enrols, then requires and accepts a code once; recovery codes are single-use', async () => {
    const { c, email } = await signupAndLogin(h);
    const setup = await c.post('/v1/me/mfa/totp/setup');
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    const bad = await c.post('/v1/me/mfa/totp/confirm', { code: '000000' === generateTotpCode(secret) ? '111111' : '000000' });
    expect(bad.status).toBe(401);
    const confirm = await c.post('/v1/me/mfa/totp/confirm', { code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);
    const recovery = confirm.body.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);

    const c2 = new Client(h.app);
    const step1 = await c2.post('/v1/auth/login', { email, password: PASSWORD });
    expect(step1.body).toMatchObject({ next: 'mfa' });
    expect(step1.body.accessToken).toBeUndefined();
    // The code used during enrolment is spent: replay is refused.
    const replay = await c2.post('/v1/auth/mfa/verify', { mfaToken: step1.body.mfaToken, code: generateTotpCode(secret) });
    expect(replay.status).toBe(401);
    const viaRecovery = await c2.post('/v1/auth/mfa/verify', { mfaToken: step1.body.mfaToken, recoveryCode: recovery[0] });
    expect(viaRecovery.status).toBe(200);
    expect(viaRecovery.body).toMatchObject({ next: 'done', user: { mfaEnabled: true } });

    const c3 = new Client(h.app);
    const again = await c3.post('/v1/auth/login', { email, password: PASSWORD });
    const reuse = await c3.post('/v1/auth/mfa/verify', { mfaToken: again.body.mfaToken, recoveryCode: recovery[0] });
    expect(reuse.status).toBe(401);
    const forged = await c3.post('/v1/auth/mfa/verify', { mfaToken: c.accessToken, code: '123456' });
    expect(forged.status).toBe(401);
  });
});

describe('refresh rotation and session revocation', () => {
  it('rotates, detects reuse of an old refresh token and revokes the session', async () => {
    const { c } = await signupAndLogin(h);
    const oldCookies = new Map(c.cookies);
    const r1 = await c.post('/v1/auth/refresh', undefined, c.withCsrf());
    expect(r1.status).toBe(200);
    expect(r1.body.tenant).toBeTruthy();
    expect((await c.get('/v1/tenant')).status).toBe(200);

    const thief = new Client(h.app);
    thief.cookies = oldCookies;
    const reuse = await thief.post('/v1/auth/refresh', undefined, c.withCsrf());
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    // The legitimate session is gone as well (family compromised).
    expect((await c.get('/v1/me')).status).toBe(401);
    expect((await c.post('/v1/auth/refresh', undefined, c.withCsrf())).status).toBe(401);
  });

  it('requires the CSRF header bound to the session for refresh and logout', async () => {
    const { c } = await signupAndLogin(h);
    expect((await c.post('/v1/auth/refresh')).body.code).toBe('CSRF_INVALID');
    const other = await signupAndLogin(h);
    expect((await c.post('/v1/auth/refresh', undefined, other.c.withCsrf())).status).toBe(403);
    expect((await c.post('/v1/auth/logout', undefined, c.withCsrf())).status).toBe(204);
    expect((await c.get('/v1/me')).status).toBe(401);
  });

  it('password reset revokes every session and the new password works', async () => {
    const { c, email } = await signupAndLogin(h);
    const anon = new Client(h.app);
    expect((await anon.post('/v1/auth/password/forgot', { email })).status).toBe(202);
    expect((await anon.post('/v1/auth/password/forgot', { email: `${uniq('nobody')}@firma.test` })).status).toBe(202);
    const token = h.mailer.tokenFrom('reset_password', email);
    expect((await anon.post('/v1/auth/password/reset', { token, password: 'kisa' })).status).toBe(422);
    expect((await anon.post('/v1/auth/password/reset', { token, password: 'Yeni-Parola-Guclu-77' })).status).toBe(204);
    expect((await anon.post('/v1/auth/password/reset', { token, password: 'Yeni-Parola-Guclu-78' })).status).toBe(410);
    expect((await c.get('/v1/me')).status).toBe(401);
    expect((await anon.post('/v1/auth/login', { email, password: 'Yeni-Parola-Guclu-77' })).status).toBe(200);
  });
});

describe('platform behaviour', () => {
  it('echoes request ids, sets security headers and answers unknown routes with problem+json', async () => {
    const c = new Client(h.app);
    const r = await c.get('/v1/nothing-here', { 'x-request-id': 'req-abcdef123' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ code: 'NOT_FOUND', requestId: 'req-abcdef123' });
    expect(r.headers['x-request-id']).toBe('req-abcdef123');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(String(r.headers['content-security-policy'])).toContain("default-src 'none'");
  });

  it('serves health, readiness and the OpenAPI document', async () => {
    const c = new Client(h.app);
    expect((await c.get('/healthz')).status).toBe(200);
    expect((await c.get('/readyz')).body).toEqual({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
    const doc = await c.get('/openapi.json');
    expect(doc.body.openapi).toBe('3.1.0');
  });

  it('rejects tokens that are missing, malformed or lack a tenant where one is required', async () => {
    const c = new Client(h.app);
    expect((await c.get('/v1/me')).status).toBe(401);
    expect((await c.get('/v1/me', { authorization: 'Bearer abc.def.ghi' })).status).toBe(401);
  });
});
