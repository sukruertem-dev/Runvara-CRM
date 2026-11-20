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
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    locale: 'tr-TR',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
