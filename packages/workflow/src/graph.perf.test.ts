import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from './index.js';

// P2 acceptance: the dependency cycle check over 100 000 edges answers within a second. Run with
// `pnpm --filter @flexa/workflow test:perf`; CI runs it as its own step, after the unit tests, so nothing else
// competes for the CPU (inside `pnpm test` every package's suite runs at once and the clock measures that load).

describe('wouldCreateCycle performance', () => {
  it('checks a 100k-edge chain in under a second', () => {
    const n = 100_000;
    const edges: (readonly [string, string])[] = [];
    for (let i = 0; i < n; i++) edges.push([`n${String(i)}`, `n${String(i + 1)}`]);
    expect(wouldCreateCycle(edges, [`n${String(n)}`, 'n0'])).toHaveLength(n + 2); // also warms up the JIT
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      wouldCreateCycle(edges, [`n${String(n)}`, 'n0']);
      best = Math.min(best, performance.now() - t0);
    }
    expect(best).toBeLessThan(1000);
  });
});
