#!/usr/bin/env node
// Screenshot regression (apps/web/e2e/visual.spec.ts) inside the pinned Playwright Linux image, so fonts and
// rendering are identical in CI and on every developer machine (Windows/macOS render text differently).
//
//   node scripts/e2e-visual.mjs            compare against the committed baselines
//   node scripts/e2e-visual.mjs --update   write new baselines (review the PNG diff before committing)
//
// The stack must be running (docker compose up). On Linux the container shares the host network. Elsewhere
// Docker cannot reach the host's localhost, so a small forwarder inside the container listens on localhost:3000
// and :8025 and connects to host.docker.internal: the browser still sees http://localhost:3000, which keeps the
// origin (cookies, CSRF check) exactly as in the normal E2E run.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps', 'web');
const pkg = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'));
const version = pkg.devDependencies['@playwright/test'];
const update = process.argv.includes('--update');
const linux = process.platform === 'linux';
const image = `mcr.microsoft.com/playwright:v${version}-noble`;

const shots = join(web, 'e2e', '__screenshots__');
const results = join(web, 'test-results-visual');
mkdirSync(shots, { recursive: true });
mkdirSync(results, { recursive: true });

const forward = `
const net = require('node:net');
for (const port of [3000, 8025]) {
  net.createServer((c) => {
    const u = net.connect(port, 'host.docker.internal');
    c.pipe(u); u.pipe(c);
    const end = () => { c.destroy(); u.destroy(); };
    c.on('error', end); u.on('error', end);
  }).listen(port, '127.0.0.1');
}`;

const inner = [
  'set -e',
  'mkdir -p /tmp/w && cd /tmp/w',
  'cp -r /src/e2e /src/playwright.config.ts .',
  // Only the test runner is needed; installing it here keeps the host's node_modules (any OS) out of the container.
  `npm init -y >/dev/null && npm i --no-save --no-audit --no-fund --loglevel=error @playwright/test@${version} @axe-core/playwright@${pkg.devDependencies['@axe-core/playwright']}`,
  linux ? 'true' : `node -e "${forward.replace(/"/g, '\\"').replace(/\n/g, ' ')}" & sleep 1`,
  'set +e',
  `npx playwright test --project=visual --output=/results ${update ? '--update-snapshots=all' : ''}`,
  'rc=$?',
  update ? 'cp -r e2e/__screenshots__/. /shots/' : 'true',
  'exit $rc',
].join('\n');

const args = [
  'run', '--rm', '--ipc=host',
  ...(linux ? ['--network', 'host'] : ['--add-host', 'host.docker.internal:host-gateway']),
  '-v', `${web}:/src:ro`,
  '-v', `${shots}:/shots`,
  '-v', `${results}:/results`,
  '-e', `CI=${process.env.CI ?? ''}`,
  image, 'bash', '-c', inner,
];
const r = spawnSync('docker', args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
