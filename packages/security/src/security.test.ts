import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  checkPasswordPolicy,
  createCsrfToken,
  decrypt,
  encrypt,
  generateRecoveryCodes,
  generateTotpCode,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCode,
  KeyRing,
  TokenSigner,
  verifyCsrfToken,
  verifyPassword,
  verifyTotp,
} from './index';

describe('password', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await verifyPassword(h, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });

  it('enforces the policy', () => {
    expect(checkPasswordPolicy('short').reasons).toContain('too_short');
    expect(checkPasswordPolicy('password1234').reasons).toContain('too_common');
    expect(checkPasswordPolicy('ayse.yilmaz-2026!', 'ayse.yilmaz@example.com').reasons).toContain('contains_email');
    expect(checkPasswordPolicy('Tuzlu-Kahve-Sabahi-42').ok).toBe(true);
  });
});

describe('envelope encryption', () => {
  it('round-trips and binds ciphertext to its AAD', () => {
    const key = randomBytes(32);
    const blob = encrypt(key, 'secret', 'tenant:a');
    expect(decrypt(key, blob, 'tenant:a').toString()).toBe('secret');
    expect(() => decrypt(key, blob, 'tenant:b')).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => decrypt(key, tampered, 'tenant:a')).toThrow();
  });

  it('wraps tenant keys so that one tenant key cannot be unwrapped as another', () => {
    const ring = new KeyRing(randomBytes(32).toString('base64'));
    const { dek, wrapped } = ring.newTenantKey('t1');
    expect(ring.unwrapTenantKey('t1', wrapped).equals(dek)).toBe(true);
    expect(() => ring.unwrapTenantKey('t2', wrapped)).toThrow();
    expect(ring.platformKey('mfa').equals(ring.platformKey('mfa'))).toBe(true);
    expect(ring.platformKey('mfa').equals(ring.platformKey('other'))).toBe(false);
  });
});

describe('totp', () => {
  it('accepts the current code once and rejects replay', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const code = generateTotpCode(secret, now);
    const step = verifyTotp(secret, code, null, now);
    expect(step).toBe(Math.floor(now / 30_000));
    expect(verifyTotp(secret, code, step, now)).toBeNull();
    expect(verifyTotp(secret, '000000', null, now) === null || generateTotpCode(secret, now) === '000000').toBe(true);
    expect(verifyTotp(secret, 'abc', null, now)).toBeNull();
  });

  it('accepts ±1 step and rejects older codes', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    expect(verifyTotp(secret, generateTotpCode(secret, now - 30_000), null, now)).not.toBeNull();
    expect(verifyTotp(secret, generateTotpCode(secret, now - 120_000), null, now)).toBeNull();
  });

  it('recovery codes are unique and hash case-insensitively', () => {
    const { codes, hashes } = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(hashRecoveryCode(codes[0]!.toUpperCase())).toBe(hashes[0]);
  });
});

describe('jwt', () => {
  const signer = new TokenSigner(TokenSigner.generatePem(), 'runvara-test');

  it('signs and verifies access tokens', async () => {
    const t = await signer.signAccess({ sub: 'u', sid: 's', tid: 't', av: 3, amr: ['pwd', 'otp'] }, 60);
    expect(await signer.verifyAccess(t)).toEqual({ ok: true, claims: { sub: 'u', sid: 's', tid: 't', av: 3, amr: ['pwd', 'otp'] } });
  });

  it('rejects other audiences, other keys and tampering', async () => {
    const mfa = await signer.signPurpose({ sub: 'u', purpose: 'mfa', amr: ['pwd'] }, 60);
    expect(await signer.verifyAccess(mfa)).toEqual({ ok: false, reason: 'invalid' });
    const other = new TokenSigner(TokenSigner.generatePem(), 'runvara-test');
    const t = await other.signAccess({ sub: 'u', sid: 's', tid: null, av: 0, amr: [] }, 60);
    expect((await signer.verifyAccess(t)).ok).toBe(false);
    expect((await signer.verifyAccess(`${t.slice(0, -2)}xx`)).ok).toBe(false);
  });

  it('reports expiry', async () => {
    const t = await signer.signAccess({ sub: 'u', sid: 's', tid: null, av: 0, amr: [] }, 1);
    await new Promise((r) => setTimeout(r, 2100));
    expect(await signer.verifyAccess(t)).toEqual({ ok: false, reason: 'expired' });
  });
});

describe('csrf', () => {
  it('binds the token to its session family', () => {
    const t = createCsrfToken('s'.repeat(32), 'family-1');
    expect(verifyCsrfToken('s'.repeat(32), 'family-1', t)).toBe(true);
    expect(verifyCsrfToken('s'.repeat(32), 'family-2', t)).toBe(false);
    expect(verifyCsrfToken('s'.repeat(32), 'family-1', undefined)).toBe(false);
  });
});
