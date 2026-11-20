import { hash, verify, type Algorithm } from '@node-rs/argon2';

// ADR-0009: argon2id, m = 64 MiB, t = 3, p = 1. Parameters are encoded in the PHC string.
// `Algorithm` is an ambient const enum (not importable under isolatedModules); Argon2id = 2.
// eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- see comment above
const ARGON2ID = 2 as Algorithm;
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  try {
    return await verify(phc, password);
  } catch {
    return false;
  }
}

/** A precomputed hash so that unknown-account logins cost the same as real ones (no user enumeration by timing). */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hash('runvara-timing-equaliser', OPTIONS);
  return dummyHash;
}

export interface PasswordPolicyResult {
  ok: boolean;
  reasons: ('too_short' | 'too_long' | 'too_common' | 'contains_email')[];
}

const COMMON = new Set([
  'password1234', '123456789012', 'qwertyuiop12', 'passwordpassword', 'iloveyou1234', 'admin1234567', 'welcome12345',
  'sifre1234567', 'parola123456', 'qwerty123456', '111111111111', 'abcdefghijkl',
]);

export function checkPasswordPolicy(password: string, email?: string): PasswordPolicyResult {
  const reasons: PasswordPolicyResult['reasons'] = [];
  if (Array.from(password).length < PASSWORD_MIN_LENGTH) reasons.push('too_short');
  if (password.length > PASSWORD_MAX_LENGTH) reasons.push('too_long');
  if (COMMON.has(password.toLowerCase())) reasons.push('too_common');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) reasons.push('contains_email');
  return { ok: reasons.length === 0, reasons };
}
