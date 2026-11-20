#!/usr/bin/env node
// Copies the official Flexa logo files (single source: packages/brand) into an app's public folder.
// Usage: node ../../packages/brand/copy.mjs <targetDir>
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(process.cwd(), process.argv[2] ?? 'public');
mkdirSync(target, { recursive: true });
for (const f of ['flexa-logo-on-light.svg', 'flexa-logo-on-dark.svg', 'flexa-symbol.svg']) {
  copyFileSync(resolve(here, f), resolve(target, f));
}
process.stdout.write(`flexa brand assets → ${target}\n`);
