import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { REBALANCE_LENGTH, keyBetween, needsRebalance, rebalance } from './index.js';

const BASE62_RE = /^[0-9A-Za-z]+$/;

describe('keyBetween', () => {
  it('generates the first key and keys at the edges', () => {
    const first = keyBetween(null, null);
    expect(first).toMatch(BASE62_RE);
    expect(keyBetween(first, null) > first).toBe(true);
    expect(keyBetween(null, first) < first).toBe(true);
  });

  it('keeps random insertions strictly ordered (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(), { minLength: 1, maxLength: 60 }), (positions) => {
        const keys: string[] = [];
        for (const p of positions) {
          const idx = p % (keys.length + 1);
          const before = idx === 0 ? null : (keys[idx - 1] ?? null);
          const after = idx === keys.length ? null : (keys[idx] ?? null);
          const k = keyBetween(before, after);
          expect(k).toMatch(BASE62_RE);
          keys.splice(idx, 0, k);
        }
        for (let i = 1; i < keys.length; i++) {
          expect((keys[i - 1] ?? '') < (keys[i] ?? '')).toBe(true);
        }
      }),
      { numRuns: 600 },
    );
  });

  it('survives repeated insertion into the same gap', () => {
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const k = keyBetween(lo, hi);
      expect(k > lo && k < hi).toBe(true);
      lo = k;
    }
  });
});

describe('rebalance', () => {
  it('needsRebalance triggers above REBALANCE_LENGTH', () => {
    expect(REBALANCE_LENGTH).toBe(32);
    expect(needsRebalance('a'.repeat(32))).toBe(false);
    expect(needsRebalance('a'.repeat(33))).toBe(true);
  });

  it('yields unique strictly increasing short keys (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 500 }), (n) => {
        const keys = rebalance(n);
        expect(keys).toHaveLength(n);
        expect(new Set(keys).size).toBe(n);
        for (let i = 1; i < keys.length; i++) {
          expect((keys[i - 1] ?? '') < (keys[i] ?? '')).toBe(true);
        }
        for (const k of keys) expect(k).toMatch(BASE62_RE);
      }),
      { numRuns: 500 },
    );
  });
});
