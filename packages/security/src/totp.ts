import { randomBytes } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { sha256 } from './tokens';

// ADR-0009: RFC 6238, SHA-1, 6 digits, 30 s period, ±1 step window, replay protection by last used step.
const PERIOD = 30;

function totp(secretBase32: string, label = 'flexa'): TOTP {
  return new TOTP({ issuer: 'Flexa', label, algorithm: 'SHA1', digits: 6, period: PERIOD, secret: Secret.fromBase32(secretBase32) });
}

export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, accountLabel: string): string {
  return totp(secretBase32, accountLabel).toString();
}

/** Returns the matched time step, or null. A step ≤ lastUsedStep is rejected (no code reuse). */
export function verifyTotp(secretBase32: string, code: string, lastUsedStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = totp(secretBase32).validate({ token: code, timestamp: now, window: 1 });
  if (delta === null) return null;
  const step = Math.floor(now / 1000 / PERIOD) + delta;
  if (lastUsedStep !== null && step <= lastUsedStep) return null;
  return step;
}

export function generateTotpCode(secretBase32: string, now = Date.now()): string {
  return totp(secretBase32).generate({ timestamp: now });
}

/** Ten single-use recovery codes (xxxxx-xxxxx, ~50 bits each); store only the hashes. */
export function generateRecoveryCodes(count = 10): { codes: string[]; hashes: string[] } {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const codes = Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

export function hashRecoveryCode(code: string): string {
  return sha256(code.trim().toLowerCase()).toString('hex');
}
