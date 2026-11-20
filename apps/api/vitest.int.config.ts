import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    pool: 'forks',
    fileParallelism: false,
  },
});
