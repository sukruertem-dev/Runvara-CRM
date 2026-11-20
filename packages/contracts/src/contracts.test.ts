import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, ENDPOINTS, ERROR_CODES, MfaVerifyRequest, SignupRequest } from './index';

describe('contracts', () => {
  it('normalises e-mail and slug and rejects bad input', () => {
    const ok = SignupRequest.parse({ email: ' Ayse@Firma.COM ', password: 'x', displayName: 'Ayşe', tenantName: 'Firma', tenantSlug: 'Firma-A1' });
    expect(ok.email).toBe('ayse@firma.com');
    expect(ok.tenantSlug).toBe('firma-a1');
    expect(ok.locale).toBe('tr-TR');
    expect(SignupRequest.safeParse({ ...ok, tenantSlug: '-x' }).success).toBe(false);
    expect(SignupRequest.safeParse({ ...ok, email: 'nope' }).success).toBe(false);
  });

  it('MFA verify needs exactly one of code / recoveryCode', () => {
    const t = 'x'.repeat(30);
    expect(MfaVerifyRequest.safeParse({ mfaToken: t, code: '123456' }).success).toBe(true);
    expect(MfaVerifyRequest.safeParse({ mfaToken: t }).success).toBe(false);
    expect(MfaVerifyRequest.safeParse({ mfaToken: t, code: '123456', recoveryCode: 'abcde-fghij' }).success).toBe(false);
  });

  it('generates an OpenAPI 3.1 document covering every endpoint', () => {
    const doc = buildOpenApiDocument({ version: '0.1.0', serverUrl: 'http://localhost:4000' });
    expect(doc.openapi).toBe('3.1.0');
    const count = Object.values(doc.paths ?? {}).reduce((n, p) => n + Object.keys(p as object).length, 0);
    expect(count).toBe(ENDPOINTS.length);
    expect(new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`)).size).toBe(ENDPOINTS.length);
  });

  it('every error status used by an endpoint exists in the catalogue', () => {
    const statuses = new Set<number>(Object.values(ERROR_CODES));
    for (const e of ENDPOINTS) for (const s of e.errors) expect(statuses.has(s), `${e.path} ${s}`).toBe(true);
  });
});
