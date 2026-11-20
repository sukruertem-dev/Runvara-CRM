import { defineConfig } from 'vitest/config';

// fast-check property tests run hundreds of cases; under parallel turbo/CI load they need more than 5 s.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 60_000 } });
