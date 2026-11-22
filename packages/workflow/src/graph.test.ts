import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { wouldCreateCycle } from './index.js';

type Edge = readonly [string, string];

describe('wouldCreateCycle', () => {
  it('detects a simple cycle and returns the path', () => {
    const edges: Edge[] = [
      ['A', 'B'],
      ['B', 'C'],
    ];
    expect(wouldCreateCycle(edges, ['C', 'A'])).toEqual(['C', 'A', 'B', 'C']);
  });

  it('detects a two-node cycle', () => {
    expect(wouldCreateCycle([['A', 'B']], ['B', 'A'])).toEqual(['B', 'A', 'B']);
  });

  it('detects a self-edge', () => {
    expect(wouldCreateCycle([], ['A', 'A'])).toEqual(['A', 'A']);
  });

  it('returns null for unrelated edges and empty graph', () => {
    expect(wouldCreateCycle([], ['A', 'B'])).toBeNull();
    expect(wouldCreateCycle([['A', 'B']], ['C', 'D'])).toBeNull();
  });

  it('does not flag a diamond', () => {
    const edges: Edge[] = [
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'D'],
    ];
    expect(wouldCreateCycle(edges, ['C', 'D'])).toBeNull();
    expect(wouldCreateCycle(edges, ['A', 'D'])).toBeNull();
  });

  it('allows duplicate edges', () => {
    const edges: Edge[] = [
      ['A', 'B'],
      ['A', 'B'],
      ['B', 'C'],
    ];
    expect(wouldCreateCycle(edges, ['A', 'B'])).toBeNull();
    expect(wouldCreateCycle(edges, ['C', 'A'])).toEqual(['C', 'A', 'B', 'C']);
  });

  it('handles a long chain', () => {
    const edges: Edge[] = [];
    for (let i = 0; i < 1000; i++) edges.push([`n${String(i)}`, `n${String(i + 1)}`]);
    const cycle = wouldCreateCycle(edges, ['n1000', 'n0']);
    expect(cycle).toHaveLength(1002);
    expect(cycle?.[0]).toBe('n1000');
    expect(cycle?.at(-1)).toBe('n1000');
  });

  it('property: forward edges in a topological DAG never cycle; back edges on a path always do', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 30 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 80 }),
        fc.nat(),
        fc.nat(),
        (n, pairs, x, y) => {
          const name = (i: number): string => `n${String(i)}`;
          const edges: Edge[] = [];
          for (let i = 0; i < n - 1; i++) edges.push([name(i), name(i + 1)]); // spine path
          for (const [a, b] of pairs) {
            const i = a % n;
            const j = b % n;
            if (i < j) edges.push([name(i), name(j)]);
          }
          // forward edge
          const i = x % n;
          const j = y % n;
          if (i !== j) {
            const [lo, hi] = i < j ? [i, j] : [j, i];
            expect(wouldCreateCycle(edges, [name(lo), name(hi)])).toBeNull();
            // back edge: hi can no longer be blocker of lo without a cycle (spine path lo -> hi)
            const cycle = wouldCreateCycle(edges, [name(hi), name(lo)]);
            expect(cycle).not.toBeNull();
            expect(cycle?.[0]).toBe(name(hi));
            expect(cycle?.at(-1)).toBe(name(hi));
            expect(cycle?.[1]).toBe(name(lo));
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  // The time budget for this size is measured in graph.perf.test.ts (`pnpm test:perf`), which CI runs on its
  // own: here every package's tests share the runner, and a wall-clock bound would measure that load.
  it('finds the cycle closed by an edge across a 100k-edge chain', () => {
    const edges: Edge[] = [];
    const n = 100_000;
    for (let i = 0; i < n; i++) edges.push([`n${String(i)}`, `n${String(i + 1)}`]);
    expect(wouldCreateCycle(edges, [`n${String(n)}`, 'n0'])).toHaveLength(n + 2);
    expect(wouldCreateCycle(edges, ['n0', `n${String(n)}`])).toBeNull();
  });
});
