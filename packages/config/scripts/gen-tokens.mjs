// Generates src/generated/accent-tokens.json from packages/ui/tokens.json (single source of color tokens).
// The brand derivation (ADR-0011 §4) needs the fixed backgrounds, the default accent tokens and every
// contrast check marked tenantAccent; the API image does not ship the UI package, so they are copied here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(resolve(here, '../../ui/tokens.json'), 'utf8'));
const out = resolve(here, '../src/generated/accent-tokens.json');

const ACCENT = ['accent', 'accent-hover', 'accent-soft', 'accent-btn', 'accent-btn-hover'];
const checks = tokens.contrastChecks
  .filter((c) => c.tenantAccent === true || (ACCENT.includes(c.fg) && c.note === 'focus ring'))
  .map((c) => ({ fg: c.fg, bg: c.bg, min: c.min }));
const used = new Set(checks.flatMap((c) => [c.fg, c.bg]));
const themes = {};
for (const [theme, palette] of Object.entries(tokens.color)) {
  themes[theme] = Object.fromEntries(Object.entries(palette).filter(([k]) => used.has(k) || ACCENT.includes(k)));
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ version: tokens.meta.version, accentTokens: ACCENT, themes, checks }, null, 2)}\n`);
process.stdout.write(`accent tokens: ${checks.length} checks → ${out}\n`);
