import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// ADR-0003 §7: per-tenant data encryption keys (DEK) wrapped by the platform key (KEK).
// Ciphertext format: version(1) | iv(12) | tag(16) | ciphertext. AAD binds the ciphertext to its owner.
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

function assertKey(key: Buffer, name: string): void {
  if (key.length !== 32) throw new TypeError(`${name} must be 32 bytes`);
}

export function encrypt(key: Buffer, plaintext: Buffer | string, aad: string): Buffer {
  assertKey(key, 'key');
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  assertKey(key, 'key');
  if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) throw new Error('unsupported ciphertext');
  const iv = blob.subarray(1, 1 + IV_LEN);
  const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]);
}

export class KeyRing {
  private readonly kek: Buffer;

  constructor(masterKeyBase64: string) {
    this.kek = Buffer.from(masterKeyBase64, 'base64');
    assertKey(this.kek, 'RUNVARA_MASTER_KEY');
  }

  /** A fresh tenant DEK and its wrapped form (store only the wrapped form). */
  newTenantKey(tenantId: string): { dek: Buffer; wrapped: Buffer } {
    const dek = randomBytes(32);
    return { dek, wrapped: encrypt(this.kek, dek, `tenant-dek:${tenantId}`) };
  }

  unwrapTenantKey(tenantId: string, wrapped: Buffer): Buffer {
    return decrypt(this.kek, wrapped, `tenant-dek:${tenantId}`);
  }

  /** Purpose-bound platform key for secrets that belong to no tenant (e.g. a user's TOTP secret). */
  platformKey(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.kek, Buffer.alloc(0), `runvara/${purpose}`, 32));
  }
}
