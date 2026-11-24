import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { jwtVerify, SignJWT, errors } from 'jose';

// ADR-0009: short-lived EdDSA (Ed25519) access tokens. Claims carry identity only; permissions are
// loaded per request and compared against `av` (authz_version).
export interface AccessClaims {
  sub: string;
  sid: string;
  tid: string | null;
  av: number;
  amr: string[];
}

export interface PurposeClaims {
  sub: string;
  purpose: 'mfa' | 'oidc_link';
  amr: string[];
  /** Measure of the password used for the first factor, carried to the session (tenant password rules). */
  pwd?: { length: number; mixed: boolean };
}

export type VerifyResult<T> = { ok: true; claims: T } | { ok: false; reason: 'expired' | 'invalid' };

export class TokenSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    privateKeyPem: string,
    private readonly issuer: string,
  ) {
    this.privateKey = createPrivateKey(privateKeyPem);
    if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new TypeError('JWT key must be Ed25519');
    this.publicKey = createPublicKey(this.privateKey);
  }

  static fromBase64(b64: string, issuer: string): TokenSigner {
    return new TokenSigner(Buffer.from(b64, 'base64').toString('utf8'), issuer);
  }

  static generatePem(): string {
    return generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  signAccess(claims: AccessClaims, ttlSeconds: number): Promise<string> {
    return this.sign({ sid: claims.sid, tid: claims.tid, av: claims.av, amr: claims.amr }, claims.sub, 'access', ttlSeconds);
  }

  signPurpose(claims: PurposeClaims, ttlSeconds: number): Promise<string> {
    return this.sign({ amr: claims.amr, ...(claims.pwd ? { pwd: claims.pwd } : {}) }, claims.sub, claims.purpose, ttlSeconds);
  }

  async verifyAccess(token: string): Promise<VerifyResult<AccessClaims>> {
    const r = await this.verify(token, 'access');
    if (!r.ok) return r;
    const p = r.payload;
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.av !== 'number' || !Array.isArray(p.amr)) {
      return { ok: false, reason: 'invalid' };
    }
    const tid = typeof p.tid === 'string' ? p.tid : null;
    return { ok: true, claims: { sub: p.sub, sid: p.sid, tid, av: p.av, amr: p.amr.map(String) } };
  }

  async verifyPurpose(token: string, purpose: PurposeClaims['purpose']): Promise<VerifyResult<PurposeClaims>> {
    const r = await this.verify(token, purpose);
    if (!r.ok) return r;
    if (typeof r.payload.sub !== 'string' || !Array.isArray(r.payload.amr)) return { ok: false, reason: 'invalid' };
    const pwd = r.payload.pwd as { length?: unknown; mixed?: unknown } | undefined;
    const profile = pwd && typeof pwd.length === 'number' && typeof pwd.mixed === 'boolean' ? { length: pwd.length, mixed: pwd.mixed } : undefined;
    return { ok: true, claims: { sub: r.payload.sub, purpose, amr: r.payload.amr.map(String), ...(profile ? { pwd: profile } : {}) } };
  }

  private sign(payload: Record<string, unknown>, sub: string, audience: string, ttlSeconds: number): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(this.issuer)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .sign(this.privateKey);
  }

  private async verify(token: string, audience: string): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; reason: 'expired' | 'invalid' }> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, { issuer: this.issuer, audience, algorithms: ['EdDSA'] });
      return { ok: true, payload };
    } catch (e) {
      return { ok: false, reason: e instanceof errors.JWTExpired ? 'expired' : 'invalid' };
    }
  }
}
