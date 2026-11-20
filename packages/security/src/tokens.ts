import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, base64url. Only its hash is ever stored (ADR-0009). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

export function hmacSha256(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Double-submit CSRF token bound to the refresh session family: `<nonce>.<hmac>`. */
export function createCsrfToken(secret: string, binding: string): string {
  const nonce = randomToken(16);
  return `${nonce}.${hmacSha256(secret, `${nonce}:${binding}`).toString('base64url')}`;
}

export function verifyCsrfToken(secret: string, binding: string, token: string | undefined): boolean {
  if (!token) return false;
  const [nonce, mac] = token.split('.');
  if (!nonce || !mac) return false;
  return safeEqual(hmacSha256(secret, `${nonce}:${binding}`).toString('base64url'), mac);
}
