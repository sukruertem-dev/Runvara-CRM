import { defineConfig } from 'vitest/config';

// fast-check property tests run hundreds of cases; under parallel turbo/CI load they need more than 5 s.
// Timing budgets live in *.perf.test.ts and run alone (`pnpm test:perf`, vitest.perf.config.ts).
export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: ['src/**/*.perf.test.ts'], testTimeout: 60_000 } });
