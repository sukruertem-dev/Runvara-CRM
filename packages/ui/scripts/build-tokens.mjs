// tokens.json → dist/tokens.css (single source, §12.5). Light on :root, dark under [data-theme="dark"]
// and under prefers-color-scheme unless the page forces [data-theme="light"].
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(resolve(root, 'tokens.json'), 'utf8'));

const vars = (theme) => [
  ...Object.entries(t.color[theme]).map(([k, v]) => `  --${k}: ${v};`),
  `  --shadow-card: ${t.shadow[theme].card};`,
].join('\n');

const common = [
  `  --font-display: ${t.font.display};`,
  `  --font-body: ${t.font.body};`,
  ...Object.entries(t.radius).filter(([k]) => k !== 'logoTileRatio').map(([k, v]) => `  --radius-${k}: ${v};`),
  ...t.font.scale.map((px, i) => `  --text-${i + 1}: ${px / 16}rem;`),
  `  --motion-fast: ${t.motion.fast};`,
  `  --motion-base: ${t.motion.base};`,
  `  --motion-easing: ${t.motion.easing};`,
].join('\n');

const css = `/* Generated from packages/ui/tokens.json — do not edit. */
:root {
${common}
${vars('light')}
  color-scheme: light;
}
:root[data-theme="dark"] {
${vars('dark')}
  color-scheme: dark;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${vars('dark').replace(/^/gm, '  ')}
    color-scheme: dark;
  }
}
@media (prefers-reduced-motion: reduce) {
  :root { --motion-fast: 0ms; --motion-base: 0ms; }
}
`;
mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/tokens.css'), css);
process.stdout.write(`tokens.css: ${Object.keys(t.color.light).length} colour tokens × 2 themes\n`);
