import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superQuery } from '@flexa/db/testing';
import { generate } from 'selfsigned';
import { SignedXml } from 'xml-crypto';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { Client, signupAndLogin, startHarness, uniq, type Harness, type Res } from './harness';

// P7d (TEN-04, docs/p7-plan.md §20, B78): SAML 2.0 service provider. The test plays the IdP: it reads our
// AuthnRequest and posts back a response it signs with its own certificate.

let h: Harness;
let idp: { key: string; cert: string };
let rogue: { key: string; cert: string };
beforeAll(async () => {
  h = await startHarness();
  const make = async (cn: string) => {
    const r = await generate([{ name: 'commonName', value: cn }], { keySize: 2048, algorithm: 'sha256' });
    return { key: r.private, cert: r.cert };
  };
  [idp, rogue] = await Promise.all([make('idp.firma.test'), make('kotu.example')]);
});
afterAll(async () => {
  await h.close();
});

type Json = Record<string, unknown>;
const ok = (r: Res, status = 200): Json => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
};

const IDP_ENTITY = 'https://idp.firma.test/metadata';
const API = 'http://api.flexa.test';

async function samlProvider(admin: Client, extra: Json = {}): Promise<Json> {
  return ok(await admin.post('/v1/sso-providers', {
    kind: 'saml', name: 'Kurumsal SAML', idpEntityId: IDP_ENTITY, idpSsoUrl: 'https://idp.firma.test/sso', idpCerts: [idp.cert], emailDomains: ['firma.test'], ...extra,
  }), 201);
}

/** Our AuthnRequest, as the IdP receives it (HTTP-Redirect: deflated, base64, in the query). */
async function authnRequest(c: Client, providerId: string): Promise<{ id: string; xml: string }> {
  const start = await c.get(`/v1/auth/saml/${providerId}/start`);
  expect(start.status).toBe(302);
  const location = new URL(String(start.headers.location));
  expect(location.origin + location.pathname).toBe('https://idp.firma.test/sso');
  const xml = inflateRawSync(Buffer.from(location.searchParams.get('SAMLRequest') ?? '', 'base64')).toString('utf8');
  const id = /\sID="([^"]+)"/.exec(xml)?.[1];
  if (!id) throw new Error('no request id');
  return { id, xml };
}

interface AssertionOptions {
  inResponseTo: string;
  providerId: string;
  email: string;
  audience?: string;
  issuer?: string;
  notOnOrAfter?: Date;
  sign?: { key: string; cert: string } | null;
  name?: string;
}

/** A SAML Response whose assertion is signed (enveloped, exclusive c14n, RSA-SHA256), as IdPs send it. */
function samlResponse(o: AssertionOptions): string {
  const now = new Date();
  const later = o.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const acs = `${API}/v1/auth/saml/${o.providerId}/acs`;
  const audience = o.audience ?? `${API}/v1/auth/saml/${o.providerId}/metadata`;
  const issuer = o.issuer ?? IDP_ENTITY;
  const assertionId = `_${randomUUID()}`;
  const iso = (d: Date) => d.toISOString();
  const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}">`
    + `<saml:Issuer>${issuer}</saml:Issuer>`
    + `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.email}</saml:NameID>`
    + `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${o.inResponseTo}" Recipient="${acs}" NotOnOrAfter="${iso(later)}"/></saml:SubjectConfirmation></saml:Subject>`
    + `<saml:Conditions NotBefore="${iso(new Date(now.getTime() - 60_000))}" NotOnOrAfter="${iso(later)}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions>`
    + `<saml:AuthnStatement AuthnInstant="${iso(now)}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`
    + `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${o.email}</saml:AttributeValue></saml:Attribute>`
    + `<saml:Attribute Name="displayName"><saml:AttributeValue>${o.name ?? 'Selin Kaya'}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>`
    + `</saml:Assertion>`;
  const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${iso(now)}" Destination="${acs}" InResponseTo="${o.inResponseTo}">`
    + `<saml:Issuer>${issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${assertion}</samlp:Response>`;
  const signer = o.sign === undefined ? idp : o.sign;
  if (!signer) return Buffer.from(response).toString('base64');
  const sig = new SignedXml({
    privateKey: signer.key,
    publicCert: signer.cert,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(response, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' } });
  return Buffer.from(sig.getSignedXml()).toString('base64');
}

function postAcs(c: Client, providerId: string, samlResponseB64: string): Promise<Res> {
  return c.req('POST', `/v1/auth/saml/${providerId}/acs`, new URLSearchParams({ SAMLResponse: samlResponseB64 }).toString(), { 'content-type': 'application/x-www-form-urlencoded' });
}

/** Whole SP-initiated round trip; on success the browser refreshes into a tenant session. */
async function samlLogin(providerId: string, email: string, tweak: Partial<AssertionOptions> = {}): Promise<{ c: Client; acs: Res }> {
  const c = new Client(h.app);
  const req = await authnRequest(c, providerId);
  const acs = await postAcs(c, providerId, samlResponse({ inResponseTo: req.id, providerId, email, ...tweak }));
  return { c, acs };
}

describe('SAML 2.0 login (TEN-04)', () => {
  it('publishes SP metadata and signs a member in from a signed assertion', async () => {
    const admin = await signupAndLogin(h);
    const p = await samlProvider(admin.c);
    expect(p).toMatchObject({
      kind: 'saml', issuer: null, clientId: null, idpEntityId: IDP_ENTITY,
      sp: { entityId: `${API}/v1/auth/saml/${String(p.id)}/metadata`, acsUrl: `${API}/v1/auth/saml/${String(p.id)}/acs` },
    });
    expect((p.certificates as Json[])[0]).toMatchObject({ subject: 'CN=idp.firma.test', expired: false });

    const meta = await new Client(h.app).get(`/v1/auth/saml/${String(p.id)}/metadata`);
    expect(meta.status).toBe(200);
    expect(String(meta.headers['content-type'])).toContain('application/samlmetadata+xml');
    const xml = String(meta.body.raw);
    expect(xml).toContain(`entityID="${API}/v1/auth/saml/${String(p.id)}/metadata"`);
    expect(xml).toContain(`Location="${API}/v1/auth/saml/${String(p.id)}/acs"`);

    const { c, acs } = await samlLogin(String(p.id), admin.email);
    expect(acs.status, JSON.stringify(acs.body)).toBe(302);
    expect(acs.headers.location).toBe('http://app.flexa.test/auth/callback');
    c.csrf = c.cookies.get('fx_csrf') ?? null;
    const session = ok(await c.post('/v1/auth/refresh', undefined, c.withCsrf()));
    expect(session.tenant).toMatchObject({ id: admin.tenantId });
    expect(ok(await c.get('/v1/tenant')).id).toBe(admin.tenantId);
  });

  it('rejects unsigned, foreign-signed, wrong audience, wrong issuer and expired assertions', async () => {
    const admin = await signupAndLogin(h);
    const id = String((await samlProvider(admin.c)).id);
    const cases: [string, Partial<AssertionOptions>][] = [
      ['unsigned', { sign: null }],
      ['foreign key', { sign: rogue }],
      ['audience', { audience: 'https://baska-sp.example/metadata' }],
      ['issuer', { issuer: 'https://kotu-idp.example' }],
      ['expired', { notOnOrAfter: new Date(Date.now() - 10 * 60_000) }],
    ];
    for (const [label, tweak] of cases) {
      const { acs } = await samlLogin(id, admin.email, tweak);
      expect(acs.status, label).toBe(400);
      expect(acs.body.code, label).toBe('SSO_RESPONSE_INVALID');
    }
  });

  it('accepts a response once, only for a request it issued', async () => {
    const admin = await signupAndLogin(h);
    const id = String((await samlProvider(admin.c)).id);
    const c = new Client(h.app);
    const req = await authnRequest(c, id);
    const body = samlResponse({ inResponseTo: req.id, providerId: id, email: admin.email });
    expect((await postAcs(c, id, body)).status).toBe(302);
    const replay = await postAcs(new Client(h.app), id, body);
    expect(replay.body.code).toBe('SSO_RESPONSE_INVALID');
    // IdP-initiated or forged request ids are refused (B78).
    const forged = await postAcs(new Client(h.app), id, samlResponse({ inResponseTo: '_bizim-gondermedigimiz', providerId: id, email: admin.email }));
    expect(forged.body.code).toBe('SSO_RESPONSE_INVALID');
    // A request of one provider cannot be answered at another provider's ACS.
    const other = String((await samlProvider(admin.c, { name: 'İkinci' })).id);
    const cross = await authnRequest(c, id);
    expect((await postAcs(c, other, samlResponse({ inResponseTo: cross.id, providerId: other, email: admin.email }))).body.code).toBe('SSO_RESPONSE_INVALID');
    expect((await postAcs(c, id, '')).body.code).toBe('SSO_RESPONSE_INVALID');
  });

  it('maps e-mail domains and JIT like OIDC', async () => {
    const admin = await signupAndLogin(h);
    const strict = String((await samlProvider(admin.c)).id);
    expect((await samlLogin(strict, `${uniq('yeni')}@firma.test`)).acs.body.code).toBe('SSO_NOT_MEMBER');
    expect((await samlLogin(strict, `${uniq('yabanci')}@baska.test`)).acs.body.code).toBe('SSO_NOT_MEMBER');
    const jit = String((await samlProvider(admin.c, { name: 'JIT', jitEnabled: true })).id);
    const email = `${uniq('yeni')}@firma.test`;
    const { c, acs } = await samlLogin(jit, email, { name: 'Deniz Er' });
    expect(acs.status).toBe(302);
    c.csrf = c.cookies.get('fx_csrf') ?? null;
    const s = ok(await c.post('/v1/auth/refresh', undefined, c.withCsrf()));
    expect(s.tenant).toMatchObject({ id: admin.tenantId, roles: ['analyst'] });
    expect(ok(await c.get('/v1/me')).user).toMatchObject({ email, displayName: 'Deniz Er' });
  });

  it('manages providers: discovery, certificate rotation, disable and delete', async () => {
    const admin = await signupAndLogin(h);
    const domain = `${uniq('d')}.test`;
    const p = await samlProvider(admin.c, { emailDomains: [domain, 'firma.test'] });
    const id = String(p.id);
    const found = ok(await new Client(h.app).post('/v1/auth/sso/discover', { email: `kim@${domain}` }));
    expect(found).toEqual({ providers: [{ id, name: 'Kurumsal SAML', kind: 'saml', startUrl: `${API}/v1/auth/saml/${id}/start` }] });
    expect(ok(await new Client(h.app).post('/v1/auth/sso/discover', { email: 'kim@hicbiri.test' }))).toEqual({ providers: [] });

    // Rotation: both certificates are trusted while the IdP switches.
    const rotated = ok(await admin.c.req('PATCH', `/v1/sso-providers/${id}`, { idpCerts: [idp.cert, rogue.cert] }));
    expect(rotated.certificates).toHaveLength(2);
    expect((await samlLogin(id, admin.email, { sign: rogue, issuer: IDP_ENTITY })).acs.status).toBe(302);
    expect((await admin.c.req('PATCH', `/v1/sso-providers/${id}`, { idpCerts: ['-----BEGIN CERTIFICATE-----\n' + 'A'.repeat(120) + '\n-----END CERTIFICATE-----'] })).status).toBe(400);
    expect((await admin.c.req('PATCH', `/v1/sso-providers/${id}`, { clientSecret: 'olmaz' })).body.code).toBe('SSO_PROVIDER_KIND_MISMATCH');
    expect((await admin.c.req('PATCH', `/v1/sso-providers/${id}`, { idpSsoUrl: 'http://idp.firma.test/sso' })).status).toBe(400);

    ok(await admin.c.req('PATCH', `/v1/sso-providers/${id}`, { enabled: false }));
    expect((await new Client(h.app).get(`/v1/auth/saml/${id}/start`)).status).toBe(404);
    expect(ok(await new Client(h.app).post('/v1/auth/sso/discover', { email: `kim@${domain}` }))).toEqual({ providers: [] });
    ok(await admin.c.del(`/v1/sso-providers/${id}`), 204);
    expect((ok(await admin.c.get('/v1/sso-providers')) as unknown as Json[])).toEqual([]);
    const audit = await superQuery<{ action: string; details: Json }>(process.env.TEST_SUPER_DATABASE_URL!, 'SELECT action, details FROM audit_log WHERE target_id = $1 ORDER BY at', [id]);
    expect(audit.map((a) => a.action)).toEqual(['sso.provider_created', 'sso.provider_updated', 'sso.provider_updated', 'sso.provider_deleted']);
    // Field names only: certificates never reach the audit log.
    expect(JSON.stringify(audit)).not.toContain('BEGIN CERTIFICATE');
  });

  it('only Admin manages providers; members see 403', async () => {
    const admin = await signupAndLogin(h);
    const id = String((await samlProvider(admin.c)).id);
    const email = `${uniq('rep')}@firma.test`;
    ok(await admin.c.post('/v1/invitations', { email, roleKey: 'sales_rep' }), 201);
    const rep = new Client(h.app);
    ok(await rep.post('/v1/invitations/accept', { token: h.mailer.tokenFrom('invitation', email), password: 'Tuzlu-Kahve-Sabahi-42', displayName: 'Rep' }));
    ok(await rep.post('/v1/auth/login', { email, password: 'Tuzlu-Kahve-Sabahi-42' }));
    expect((await rep.get('/v1/sso-providers')).status).toBe(403);
    expect((await rep.req('PATCH', `/v1/sso-providers/${id}`, { enabled: false })).status).toBe(403);
    expect((await rep.del(`/v1/sso-providers/${id}`)).status).toBe(403);
  });
});
