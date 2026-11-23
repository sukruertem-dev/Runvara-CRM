import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCENT, deriveAccent, MAX_LIGHTNESS_SHIFT } from './brand';
import { contrast, hexToOklch, oklchToHex } from './color';
import { diffJson, mergeLayer, resolveLayers } from './merge';
import { CONFIG_KEYS, configKey, upgradeValue, validateConfig, type ConfigKeyDef, type JsonObject } from './registry';

const def = (key: string): ConfigKeyDef => {
  const d = configKey(key);
  if (!d) throw new Error(key);
  return d;
};
const check = (key: string, layer: JsonObject) => validateConfig(def(key), layer, mergeLayer(def(key).default, layer));

describe('color', () => {
  it('round-trips sRGB through OKLCH', () => {
    for (const hex of ['#7B3CFF', '#1A1B1F', '#FFFFFF', '#00A3A3', '#E4572E']) expect(oklchToHex(hexToOklch(hex))).toBe(hex);
  });
  it('computes WCAG contrast', () => {
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrast('#FFFFFF', '#FFFFFF')).toBe(1);
  });
});

describe('deriveAccent', () => {
  it('keeps the Flexa default tokens for the default accent', () => {
    const d = deriveAccent(DEFAULT_ACCENT);
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.adjusted).toBe(false);
      expect(d.themes.dark.accent).toBe('#C9A8FF');
    }
  });

  it('passes a color that already meets every check unchanged in the light theme', () => {
    const d = deriveAccent('#1D4ED8');
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.themes.light['accent-btn']).toBe('#1D4ED8');
      expect(d.checks.every((c) => c.pass)).toBe(true);
    }
  });

  it('darkens a light brand color until white text reads on it, keeping its hue', () => {
    const d = deriveAccent('#10B981');
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.adjusted).toBe(true);
    const btn = d.themes.light['accent-btn'];
    expect(contrast('#FFFFFF', btn)).toBeGreaterThanOrEqual(4.5);
    expect(Math.abs(hexToOklch(btn).h - hexToOklch('#10B981').h)).toBeLessThan(3);
    expect(contrast(d.themes.dark.accent, '#2B2D31')).toBeGreaterThanOrEqual(4.5);
  });

  it('rejects a color that would have to change too much', () => {
    const d = deriveAccent('#FFFF00');
    expect(d).toMatchObject({ ok: false, reason: 'unsatisfiable' });
    expect(MAX_LIGHTNESS_SHIFT).toBeLessThan(0.5);
  });

  it('rejects input that is not a hex color', () => {
    expect(deriveAccent('purple')).toMatchObject({ ok: false, reason: 'invalid_color' });
  });
});

describe('registry', () => {
  it('declares a valid default for every key', () => {
    for (const k of CONFIG_KEYS) expect(validateConfig(k, {}, k.default), k.key).toEqual([]);
  });

  it('rejects unknown properties and wrong types with a JSON pointer', () => {
    expect(check('locale', { language: 'de' })).toEqual([expect.objectContaining({ path: '/language' })]);
    expect(check('ui', { colour: 'red' } as JsonObject)).toEqual([expect.objectContaining({ path: '/colour' })]);
    expect(check('currency', { decimals: 9 })).toEqual([expect.objectContaining({ path: '/decimals' })]);
  });

  it('checks time zones and currencies against the IANA and ISO lists', () => {
    expect(check('locale', { timezone: 'Europe/Ankara' })).toEqual([{ path: '/timezone', message: 'unknown IANA time zone' }]);
    expect(check('locale', { timezone: 'America/New_York' })).toEqual([]);
    expect(check('currency', { code: 'XYZ' })).toEqual([{ path: '/code', message: 'unknown ISO 4217 currency' }]);
  });

  it('rejects a brand color that fails contrast', () => {
    expect(check('brand', { accent: '#FFFF00' })).toEqual([{ path: '/accent', message: 'BRAND_CONTRAST_UNSATISFIABLE' }]);
    expect(check('brand', { accent: '#0F766E' })).toEqual([]);
  });

  it('refuses to upgrade without a registered step', () => {
    const d = { ...def('ui'), schemaVersion: 2 };
    expect(() => upgradeValue(d, { theme: 'dark' }, 1)).toThrow(/no upgrade/);
    expect(upgradeValue({ ...d, upgrades: { 1: (v) => ({ ...v, density: 'compact' }) } }, { theme: 'dark' }, 1)).toEqual({ theme: 'dark', density: 'compact' });
  });
});

describe('merge and diff', () => {
  it('merges objects deeply and replaces arrays whole', () => {
    expect(mergeLayer({ a: { x: 1, y: 2 }, list: [1, 2] }, { a: { y: 3 }, list: [9] })).toEqual({ a: { x: 1, y: 3 }, list: [9] });
  });

  it('records which layer each property comes from', () => {
    const r = resolveLayers({ theme: 'system', density: 'comfortable' }, [
      { scope: 'tenant', value: { density: 'compact' } },
      { scope: 'user', value: { theme: 'dark' } },
    ]);
    expect(r.value).toEqual({ theme: 'dark', density: 'compact' });
    expect(r.sources).toEqual({ theme: 'user', density: 'tenant' });
  });

  it('produces an RFC 6902 patch', () => {
    expect(diffJson({ a: 1, b: { c: 1 }, l: [1], gone: true, 'x/y': 1 }, { a: 2, b: { c: 1, d: 2 }, l: [1, 2], 'x/y': 2 })).toEqual([
      { op: 'remove', path: '/gone' },
      { op: 'replace', path: '/a', value: 2 },
      { op: 'add', path: '/b/d', value: 2 },
      { op: 'replace', path: '/l', value: [1, 2] },
      { op: 'replace', path: '/x~1y', value: 2 },
    ]);
    expect(diffJson({ a: [1] }, { a: [1] })).toEqual([]);
  });
});
