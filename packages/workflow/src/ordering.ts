import { randomInt } from 'node:crypto';
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SUFFIX_LENGTH = 4;

export const REBALANCE_LENGTH = 32;

function randomSuffix(): string {
  let out = '';
  for (let i = 0; i < SUFFIX_LENGTH; i++) {
    // The last char must not be '0': fractional-indexing rejects keys with trailing zeros.
    const min = i === SUFFIX_LENGTH - 1 ? 1 : 0;
    out += BASE62.charAt(randomInt(min, BASE62.length));
  }
  return out;
}

/**
 * Key strictly between `before` and `after` (plain string comparison, COLLATE "C").
 * A random suffix reduces collisions between concurrent inserts into the same gap.
 */
export function keyBetween(before: string | null, after: string | null): string {
  const base = generateKeyBetween(before, after);
  const candidate = base + randomSuffix();
  if (after !== null && candidate >= after) return base;
  return candidate;
}

export function needsRebalance(key: string): boolean {
  return key.length > REBALANCE_LENGTH;
}

export function rebalance(count: number): string[] {
  return generateNKeysBetween(null, null, count);
}
