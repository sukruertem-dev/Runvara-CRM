#!/usr/bin/env node
// Lighthouse on the production build (prompt Faz 6: Performance ≥ 90, Accessibility ≥ 95 on the main pages;
// docs/requirements-review.md: production build, mobile profile). The stack must be running (docker compose up).
//
// A fresh workspace is signed up through the API, the browser logs in through the real form (the refresh cookie
// is httpOnly, the access token lives in memory), and Lighthouse then audits each page in that same browser with
// storage reset disabled, so authenticated pages are measured as a signed-in user sees them.
//
//   pnpm --filter @flexa/web lighthouse            all pages, fail below the thresholds
//   LH_RUNS=3 pnpm --filter @flexa/web lighthouse  median of three runs per page
import { chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const RUNS = Math.max(1, Number(process.env.LH_RUNS ?? '1'));
const OUT = join(process.cwd(), 'lighthouse-report');
const PORT = 9333;
const THRESHOLDS = { performance: 0.9, accessibility: 0.95 };
const PAGES = [
  { name: 'home', path: '/', auth: true },
  { name: 'tasks', path: '/tasks', auth: true },
  { name: 'crm', path: '/crm', auth: true },
  { name: 'settings-workflows', path: '/settings/workflows', auth: true },
  // Last: measuring it signed out clears the session cookies.
  { name: 'login', path: '/login', auth: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function verificationToken(email) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const s = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`)).json();
    const id = s.messages?.[0]?.ID;
    if (id) {
      const m = await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json();
      const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(m.Text)?.[1];
      if (token) return token;
    }
    await sleep(500);
  }
  throw new Error(`no verification mail for ${email}`);
}

async function workspace() {
  const id = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `lh-${id}@firma.test`;
  const password = 'Kuvvetli-Parola-2026!x';
  await api('POST', '/v1/auth/signup', { body: { email, password, displayName: 'Deniz Yönetici', tenantName: 'Atlas Lojistik', tenantSlug: `lh-${id}` } });
  await api('POST', '/v1/auth/email/verify', { body: { token: await verificationToken(email) } });
  const login = await api('POST', '/v1/auth/login', { body: { email, password } });
  await api('POST', '/v1/modules/crm/enable', { token: login.accessToken });
  for (let i = 1; i <= 25; i++) await api('POST', '/v1/tasks', { token: login.accessToken, body: { title: `Örnek görev ${i}`, priority: i % 5 } });
  return { email, password };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const user = await workspace();
  const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'flexa-lh-')), { headless: true, args: [`--remote-debugging-port=${PORT}`] });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(`${BASE}/login`);
  await page.getByLabel('E-posta').fill(user.email);
  await page.getByLabel('Parola', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await page.getByTestId('sidebar').waitFor({ timeout: 30_000 });
  // The signed-in tab would keep running (live stream, refetches) beside the audited tab and skew its timings.
  await page.goto('about:blank');

  const rows = [];
  let failed = false;
  try {
    for (const p of PAGES) {
      if (!p.auth) await context.clearCookies();
      const scores = { performance: [], accessibility: [] };
      let lcp = [];
      for (let run = 0; run < RUNS; run++) {
        const r = await lighthouse(`${BASE}${p.path}`, {
          port: PORT, output: 'html', logLevel: 'error', onlyCategories: ['performance', 'accessibility'], disableStorageReset: true,
        });
        if (!r) throw new Error(`no result for ${p.path}`);
        scores.performance.push(r.lhr.categories.performance.score ?? 0);
        scores.accessibility.push(r.lhr.categories.accessibility.score ?? 0);
        lcp.push(r.lhr.audits['largest-contentful-paint']?.numericValue ?? 0);
        if (run === RUNS - 1) writeFileSync(join(OUT, `${p.name}.html`), r.report);
        const finalUrl = r.lhr.finalDisplayedUrl ?? '';
        if (p.auth && finalUrl.includes('/login')) throw new Error(`${p.path} redirected to login: the session was lost`);
      }
      const perf = median(scores.performance);
      const a11y = median(scores.accessibility);
      const ok = perf >= THRESHOLDS.performance && a11y >= THRESHOLDS.accessibility;
      if (!ok) failed = true;
      rows.push(`| ${p.path} | ${Math.round(perf * 100)} | ${Math.round(a11y * 100)} | ${Math.round(median(lcp))} ms | ${ok ? 'PASS' : 'FAIL'} |`);
      console.log(`${ok ? 'PASS' : 'FAIL'} ${p.path}: performance ${Math.round(perf * 100)}, accessibility ${Math.round(a11y * 100)}, LCP ${Math.round(median(lcp))} ms`);
    }
  } finally {
    await context.close();
  }
  const summary = [
    `# Lighthouse (mobile profile, ${RUNS} run${RUNS > 1 ? 's, median' : ''})`,
    '',
    `Thresholds: performance ≥ ${THRESHOLDS.performance * 100}, accessibility ≥ ${THRESHOLDS.accessibility * 100}.`,
    '',
    '| Page | Performance | Accessibility | LCP | Result |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'summary.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
