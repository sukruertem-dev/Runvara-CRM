import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/perf/**/*.perf.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
  },
});
