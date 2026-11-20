#!/usr/bin/env node
// Validates packages/ui/tokens.json: theme parity + WCAG 2.x contrast checks.
// Usage: node scripts/contrast-report.mjs [--write docs/contrast-report.md]
// Exit code 1 on any failure (used as a CI gate).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tokens = JSON.parse(readFileSync(resolve(root, 'packages/ui/tokens.json'), 'utf8'));
const themes = Object.keys(tokens.color);

const channel = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const failures = [];
const rows = [];

const [first, ...rest] = themes;
const firstKeys = new Set(Object.keys(tokens.color[first]));
for (const theme of rest) {
  const keys = new Set(Object.keys(tokens.color[theme]));
  for (const k of firstKeys) if (!keys.has(k)) failures.push(`parity: "${k}" missing in ${theme}`);
  for (const k of keys) if (!firstKeys.has(k)) failures.push(`parity: "${k}" missing in ${first}`);
}

for (const theme of themes) {
  const palette = tokens.color[theme];
  for (const check of tokens.contrastChecks) {
    if (check.theme && check.theme !== theme) continue;
    const fg = palette[check.fg];
    const bg = palette[check.bg];
    if (!fg || !bg) {
      failures.push(`${theme}: unknown token in check ${check.fg}/${check.bg}`);
      continue;
    }
    const ratio = contrast(fg, bg);
    const pass = ratio >= check.min;
    rows.push({ theme, ...check, fgHex: fg, bgHex: bg, ratio, pass });
    if (!pass) failures.push(`${theme}: ${check.fg} on ${check.bg} = ${ratio.toFixed(2)} < ${check.min}`);
  }
  for (const [role, pair] of Object.entries(tokens.buttonMap[theme] ?? {})) {
    const ratio = contrast(palette[pair.fg], palette[pair.bg]);
    const pass = ratio >= 4.5;
    rows.push({ theme, fg: pair.fg, bg: pair.bg, min: 4.5, kind: `button:${role}`, fgHex: palette[pair.fg], bgHex: palette[pair.bg], ratio, pass });
    if (!pass) failures.push(`${theme}: button ${role} ${pair.fg} on ${pair.bg} = ${ratio.toFixed(2)}`);
  }
}

const out = [];
out.push('# Kontrast Raporu');
out.push('');
out.push('> Otomatik üretildi: `node scripts/contrast-report.mjs --write docs/contrast-report.md`. Elle düzenlemeyin.');
out.push(`> Kaynak: \`packages/ui/tokens.json\` v${tokens.meta.version}. Eşikler: metin ≥ 4.5:1, metin dışı ≥ 3:1 (WCAG 2.2 AA, 1.4.3 / 1.4.11).`);
out.push('');
out.push(`**Sonuç:** ${failures.length === 0 ? 'GEÇTİ' : 'BAŞARISIZ'} · ${rows.length} kontrol · ${failures.length} hata · tema paritesi ${failures.some((f) => f.startsWith('parity')) ? 'eksik' : 'tam'}`);
out.push('');
for (const theme of themes) {
  out.push(`## ${theme === 'light' ? 'Açık tema' : 'Koyu tema'}`);
  out.push('');
  out.push('| Ön plan | Zemin | Tür | Oran | Eşik | Durum |');
  out.push('|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.theme === theme)) {
    out.push(`| \`--${r.fg}\` ${r.fgHex} | \`--${r.bg}\` ${r.bgHex} | ${r.kind}${r.note ? ` (${r.note})` : ''} | ${r.ratio.toFixed(2)} | ${r.min} | ${r.pass ? '✅' : '❌'} |`);
  }
  out.push('');
}
if (failures.length) {
  out.push('## Hatalar');
  out.push('');
  for (const f of failures) out.push(`- ${f}`);
  out.push('');
}

const writeIdx = process.argv.indexOf('--write');
if (writeIdx > -1) {
  writeFileSync(resolve(root, process.argv[writeIdx + 1]), out.join('\n'), 'utf8');
}
console.log(failures.length ? `FAIL\n${failures.join('\n')}` : `PASS (${rows.length} checks, ${themes.length} themes)`);
process.exit(failures.length ? 1 : 0);
