import { defineConfig, devices } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: ci ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  // One baseline per screenshot, no OS suffix: baselines are only ever produced in the pinned Linux image
  // (scripts/e2e-visual.mjs), never on a host.
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    locale: 'tr-TR',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /visual\.spec\.ts/ },
    { name: 'visual', use: { ...devices['Desktop Chrome'], timezoneId: 'Europe/Istanbul' }, testMatch: /visual\.spec\.ts/ },
  ],
});
