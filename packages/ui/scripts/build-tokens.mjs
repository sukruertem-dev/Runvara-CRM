// tokens.json → dist/tokens.css + dist/theme.css (single source, §12.5, ADR-0024).
// tokens.css: CSS custom properties. Light on :root, dark under [data-theme="dark"] and under prefers-color-scheme
// unless the page forces [data-theme="light"]. Density under [data-density].
// theme.css: Tailwind v4 `@theme inline` mapping utilities onto those properties. Tailwind's default palette is
// cleared, so a colour that is not a token does not compile (bg-red-500 produces nothing).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const t = JSON.parse(readFileSync(resolve(root, 'tokens.json'), 'utf8'));
const colorKeys = Object.keys(t.color.light);

const vars = (theme) =>
  [
    ...Object.entries(t.color[theme]).map(([k, v]) => `  --${k}: ${v};`),
    ...Object.entries(t.shadow[theme]).map(([k, v]) => `  --elev-${k}: ${v};`),
    `  --overlay: ${t.overlay[theme]};`,
  ].join('\n');

const density = (d) => `  --row-h: ${t.density[d].rowHeight}px;\n  --control-h: ${t.density[d].controlHeight}px;`;

const common = [
  `  --font-display: ${t.font.display};`,
  `  --font-body: ${t.font.body};`,
  ...Object.entries(t.radius)
    .filter(([k]) => k !== 'logoTileRatio')
    .map(([k, v]) => `  --radius-${k}: ${v};`),
  ...t.font.scale.map((px, i) => `  --text-${i + 1}: ${px / 16}rem;`),
  `  --space-unit: ${t.space.unit};`,
  `  --motion-fast: ${t.motion.fast};`,
  `  --motion-base: ${t.motion.base};`,
  `  --motion-slow: ${t.motion.slow};`,
  `  --motion-easing: ${t.motion.easing};`,
  ...Object.entries(t.layout).map(([k, v]) => `  --layout-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v};`),
  density('comfortable'),
].join('\n');

const tokensCss = `/* Generated from packages/ui/tokens.json — do not edit. */
:root {
${common}
${vars('light')}
  color-scheme: light;
}
:root[data-density="compact"] {
${density('compact')}
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
  :root { --motion-fast: 0ms; --motion-base: 0ms; --motion-slow: 0ms; }
}
`;

// Utility names: bg-canvas, bg-surface, text-fg, text-fg-muted, border-line … (prefixes dropped where Tailwind adds one).
const utilityName = (k) =>
  ({
    'bg-canvas': 'canvas',
    'bg-surface': 'surface',
    'bg-subtle': 'subtle',
    'bg-raised': 'raised',
    border: 'line',
    'border-strong': 'line-strong',
    'text-primary': 'fg',
    'text-secondary': 'fg-muted',
  })[k] ?? k;

const sizeNames = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl'];
const themeCss = `/* Generated from packages/ui/tokens.json — do not edit. Import after "tailwindcss". */
@theme {
  --color-*: initial;
  --font-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  --text-*: initial;
}
@theme inline {
${colorKeys.map((k) => `  --color-${utilityName(k)}: var(--${k});`).join('\n')}
  --color-overlay: var(--overlay);
  --color-transparent: transparent;
  --color-current: currentColor;
  --font-display: ${t.font.display};
  --font-body: ${t.font.body};
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
${Object.entries(t.radius)
  .filter(([k]) => k !== 'logoTileRatio')
  .map(([k, v]) => `  --radius-${k}: ${v};`)
  .join('\n')}
  --radius-full: 9999px;
${Object.keys(t.shadow.light)
  .map((k) => `  --shadow-${k}: var(--elev-${k});`)
  .join('\n')}
${t.font.scale.map((px, i) => `  --text-${sizeNames[i]}: ${px / 16}rem;`).join('\n')}
  --spacing: ${parseInt(t.space.unit, 10) / 16}rem;
  --spacing-row: var(--row-h);
  --spacing-control: var(--control-h);
  --spacing-sidebar: var(--layout-sidebar);
  --spacing-sidebar-collapsed: var(--layout-sidebar-collapsed);
  --spacing-topbar: var(--layout-topbar);
  --ease-flexa: ${t.motion.easing};
}
@custom-variant dark {
  &:where([data-theme="dark"], [data-theme="dark"] *) {
    @slot;
  }
  @media (prefers-color-scheme: dark) {
    &:where(:root:not([data-theme="light"]), :root:not([data-theme="light"]) *) {
      @slot;
    }
  }
}
`;

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/tokens.css'), tokensCss);
writeFileSync(resolve(root, 'dist/theme.css'), themeCss);
process.stdout.write(`tokens.css: ${colorKeys.length} colour tokens × 2 themes; theme.css: Tailwind theme\n`);
