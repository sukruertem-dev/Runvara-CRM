import accentTokens from '../generated/accent-tokens.json';
import { contrast, hexToOklch, isHexColor, oklchToHex, type Oklch } from './color';

// Tenant accent derivation (ADR-0011 §4). From one brand color, every theme gets accent, accent-hover,
// accent-soft, accent-btn and accent-btn-hover. Hue and chroma are kept; only lightness moves, in small
// steps, until every contrast check marked tenantAccent in packages/ui/tokens.json passes. When the light
// theme would have to move the color too far from what the tenant chose, the color is rejected instead.

export type AccentToken = 'accent' | 'accent-hover' | 'accent-soft' | 'accent-btn' | 'accent-btn-hover';
export type ThemeName = 'light' | 'dark';
export type AccentPalette = Record<AccentToken, string>;

export interface AccentCheck {
  theme: ThemeName;
  fg: string;
  bg: string;
  min: number;
  ratio: number;
  pass: boolean;
}

export type AccentDerivation =
  | { ok: true; input: string; adjusted: boolean; themes: Record<ThemeName, AccentPalette>; checks: AccentCheck[] }
  | { ok: false; input: string; reason: 'invalid_color' | 'unsatisfiable'; checks: AccentCheck[] };

const THEMES: readonly ThemeName[] = ['light', 'dark'];
const STEP = 0.005;
const HOVER_SHIFT = 0.06;
/** Largest lightness change accepted for the light-theme accent before the color counts as a different one. */
export const MAX_LIGHTNESS_SHIFT = 0.3;

type Palette = Record<string, string>;
const fixedPalette = (theme: ThemeName): Palette => accentTokens.themes[theme] as Palette;

export const DEFAULT_ACCENT = accentTokens.themes.light.accent;

function evaluate(theme: ThemeName, palette: Palette): AccentCheck[] {
  return accentTokens.checks.map((c) => {
    const fg = palette[c.fg];
    const bg = palette[c.bg];
    const ratio = fg && bg ? contrast(fg, bg) : 0;
    return { theme, fg: c.fg, bg: c.bg, min: c.min, ratio: Math.round(ratio * 100) / 100, pass: ratio >= c.min };
  });
}

const checksOf = (theme: ThemeName, token: string) => accentTokens.checks.filter((c) => c.fg === token || c.bg === token);

/** Moves lightness from `start` in `direction` until the token passes its checks; null when 0 or 1 is reached first. */
function fit(theme: ThemeName, palette: Palette, token: AccentToken, start: Oklch, direction: -1 | 1): string | null {
  const checks = checksOf(theme, token);
  for (let l = start.l; l >= 0 && l <= 1; l += direction * STEP) {
    const hex = oklchToHex({ ...start, l });
    const candidate = { ...palette, [token]: hex };
    if (checks.every((c) => {
      const fg = candidate[c.fg];
      const bg = candidate[c.bg];
      return fg !== undefined && bg !== undefined && contrast(fg, bg) >= c.min;
    })) return hex;
  }
  return null;
}

const shifted = (hex: string, dl: number): Oklch => {
  const o = hexToOklch(hex);
  return { ...o, l: Math.min(1, Math.max(0, o.l + dl)) };
};

export function deriveAccent(input: string): AccentDerivation {
  if (!isHexColor(input)) return { ok: false, input, reason: 'invalid_color', checks: [] };
  const color = input.toUpperCase();
  if (color === DEFAULT_ACCENT.toUpperCase()) {
    // The Flexa default keeps its hand-tuned tokens (docs/brand.md §3).
    const themes = Object.fromEntries(THEMES.map((th) => [th, pick(fixedPalette(th))])) as Record<ThemeName, AccentPalette>;
    return { ok: true, input: color, adjusted: false, themes, checks: THEMES.flatMap((th) => evaluate(th, fixedPalette(th))) };
  }
  const base = hexToOklch(color);
  const out = {} as Record<ThemeName, AccentPalette>;
  let unsatisfiable = false;

  // Light theme: the button and the accent text darken until white text and the light surfaces pass.
  const light: Palette = { ...fixedPalette('light') };
  light['accent-soft'] = oklchToHex({ l: 0.96, c: Math.min(base.c, 0.035), h: base.h });
  const btn = fit('light', light, 'accent-btn', base, -1);
  if (btn) light['accent-btn'] = btn;
  const btnHover = btn ? fit('light', light, 'accent-btn-hover', shifted(btn, -HOVER_SHIFT), -1) : null;
  if (btnHover) light['accent-btn-hover'] = btnHover;
  const text = fit('light', light, 'accent', base, -1);
  if (text) light.accent = text;
  const textHover = text ? fit('light', light, 'accent-hover', shifted(text, -HOVER_SHIFT), -1) : null;
  if (textHover) light['accent-hover'] = textHover;
  if (!btn || !btnHover || !text || !textHover) unsatisfiable = true;
  else if (Math.abs(hexToOklch(btn).l - base.l) > MAX_LIGHTNESS_SHIFT || Math.abs(hexToOklch(text).l - base.l) > MAX_LIGHTNESS_SHIFT) unsatisfiable = true;
  out.light = pick(light);

  // Dark theme: the filled button is the same as in the light theme (white text on it); the accent text
  // lightens until it reads on the dark surfaces and on its own soft tint.
  const dark: Palette = { ...fixedPalette('dark'), 'accent-btn': light['accent-btn'] ?? color, 'accent-btn-hover': light['accent-btn-hover'] ?? color };
  dark['accent-soft'] = oklchToHex({ l: 0.3, c: Math.min(base.c, 0.08), h: base.h });
  const darkText = fit('dark', dark, 'accent', { ...base, l: Math.max(base.l, 0.6) }, 1);
  if (darkText) dark.accent = darkText;
  const darkHover = darkText ? fit('dark', dark, 'accent-hover', shifted(darkText, HOVER_SHIFT), 1) : null;
  if (darkHover) dark['accent-hover'] = darkHover;
  if (!darkText || !darkHover) unsatisfiable = true;
  out.dark = pick(dark);

  const checks = [...evaluate('light', light), ...evaluate('dark', dark)];
  if (unsatisfiable || checks.some((c) => !c.pass)) return { ok: false, input: color, reason: 'unsatisfiable', checks };
  const adjusted = out.light.accent !== color || out.light['accent-btn'] !== color;
  return { ok: true, input: color, adjusted, themes: out, checks };
}

function pick(p: Palette): AccentPalette {
  const get = (k: AccentToken): string => {
    const v = p[k];
    if (!v) throw new Error(`accent token ${k} missing`);
    return v;
  };
  return { accent: get('accent'), 'accent-hover': get('accent-hover'), 'accent-soft': get('accent-soft'), 'accent-btn': get('accent-btn'), 'accent-btn-hover': get('accent-btn-hover') };
}
