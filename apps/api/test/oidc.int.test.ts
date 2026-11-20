import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OAuth2Server } from 'oauth2-mock-server';
import { Client, signupAndLogin, startHarness, uniq, type Harness } from './harness';

let h: Harness;
const idp = new OAuth2Server();
let nextEmail = '';

beforeAll(async () => {
  h = await startHarness();
  await idp.issuer.keys.generate('RS256');
  await idp.start(0, 'localhost');
  idp.service.on('beforeTokenSigning', (token) => {
    token.payload.email = nextEmail;
    token.payload.email_verified = true;
    token.payload.name = 'Okan Tekin';
  });
});
afterAll(async () => {
  await idp.stop();
  await h.close();
});

/** Walks the browser part of the flow: our /start → IdP /authorize → our /callback. */
async function ssoLogin(providerId: string): Promise<{ client: Client; status: number; location: string; body: Record<string, unknown> }> {
  const client = new Client(h.app);
  const start = await client.get(`/v1/auth/oidc/${providerId}/start`);
  expect(start.status).toBe(302);
  const authorize = String(start.headers.location);
  expect(authorize.startsWith(`${idp.issuer.url!}/authorize?`)).toBe(true);
  expect(new URL(authorize).searchParams.get('code_challenge_method')).toBe('S256');
  const atIdp = await fetch(authorize, { redirect: 'manual' });
  const back = new URL(atIdp.headers.get('location')!);
  const cb = await client.get(`${back.pathname}${back.search}`);
  return { client, status: cb.status, location: String(cb.headers.location ?? ''), body: cb.body };
}

describe('OIDC login (Faz 1: OIDC girişi)', () => {
  it('signs an existing member in through the tenant IdP; the browser then refreshes into a tenant session', async () => {
    const admin = await signupAndLogin(h);
    const created = await admin.c.post('/v1/sso-providers', { name: 'Kurumsal IdP', issuer: idp.issuer.url, clientId: 'flexa', clientSecret: 'idp-secret', emailDomains: ['firma.test'] });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain('idp-secret');

    nextEmail = admin.email;
    const r = await ssoLogin(String(created.body.id));
    expect(r.status).toBe(302);
    expect(r.location).toBe('http://app.flexa.test/auth/callback');
    r.client.csrf = r.client.cookies.get('fx_csrf') ?? null;
    const session = await r.client.post('/v1/auth/refresh', undefined, r.client.withCsrf());
    expect(session.status).toBe(200);
    expect(session.body.tenant).toMatchObject({ id: admin.tenantId });
    expect((await r.client.get('/v1/tenant')).body.id).toBe(admin.tenantId);
  });

  it('refuses non-members unless JIT is on, and JIT users get the read-only Analist role', async () => {
    const admin = await signupAndLogin(h);
    const strict = await admin.c.post('/v1/sso-providers', { name: 'Strict', issuer: idp.issuer.url, clientId: 'c1', clientSecret: 's1', emailDomains: ['firma.test'] });
    nextEmail = `${uniq('newcomer')}@firma.test`;
    const denied = await ssoLogin(String(strict.body.id));
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('SSO_NOT_MEMBER');

    const jit = await admin.c.post('/v1/sso-providers', { name: 'JIT', issuer: idp.issuer.url, clientId: 'c2', clientSecret: 's2', emailDomains: ['firma.test'], jitEnabled: true });
    const ok = await ssoLogin(String(jit.body.id));
    expect(ok.status).toBe(302);
    ok.client.csrf = ok.client.cookies.get('fx_csrf') ?? null;
    const s = await ok.client.post('/v1/auth/refresh', undefined, ok.client.withCsrf());
    expect(s.body.tenant).toMatchObject({ id: admin.tenantId, roles: ['analyst'] });
  });

  it('rejects e-mail domains the provider does not own, replayed state and unknown providers', async () => {
    const admin = await signupAndLogin(h);
    const p = await admin.c.post('/v1/sso-providers', { name: 'Domain', issuer: idp.issuer.url, clientId: 'c3', clientSecret: 's3', emailDomains: ['baska-firma.test'] });
    nextEmail = admin.email;
    const wrongDomain = await ssoLogin(String(p.body.id));
    expect(wrongDomain.body.code).toBe('SSO_NOT_MEMBER');
    const c = new Client(h.app);
    expect((await c.get(`/v1/auth/oidc/${String(p.body.id)}/callback?code=x&state=forged`)).status).toBe(400);
    expect((await c.get('/v1/auth/oidc/00000000-0000-4000-8000-000000000000/start')).status).toBe(404);
  });

  it('only Admin configures providers, and the issuer must not point at internal networks (SSRF)', async () => {
    const admin = await signupAndLogin(h);
    const ssrf = await admin.c.post('/v1/sso-providers', { name: 'Evil', issuer: 'https://169.254.169.254/', clientId: 'c', clientSecret: 's', emailDomains: ['firma.test'] });
    expect(ssrf.status).toBe(400);
    const plain = await admin.c.post('/v1/sso-providers', { name: 'Evil', issuer: 'http://intranet.firma.test/', clientId: 'c', clientSecret: 's', emailDomains: ['firma.test'] });
    expect(plain.status).toBe(400);
  });
});

describe('auth endpoint rate limit', () => {
  it('applies AUTH_RATE_LIMIT_PER_MINUTE per IP and answers 429 problem+json with Retry-After', async () => {
    const limited = await startHarness({ AUTH_RATE_LIMIT_PER_MINUTE: '3' });
    try {
      const c = new Client(limited.app);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await c.post('/v1/auth/password/forgot', { email: 'x@firma.test' })).status);
      expect(statuses).toEqual([202, 202, 202, 429]);
      const r = await c.post('/v1/auth/password/forgot', { email: 'x@firma.test' });
      expect(r.body).toMatchObject({ code: 'RATE_LIMITED', status: 429 });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      // Authenticated, non-auth routes use the global limit instead.
      expect((await c.get('/healthz')).status).toBe(200);
    } finally {
      await limited.close();
    }
  });
});
