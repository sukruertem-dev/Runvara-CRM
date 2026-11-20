import type { Formula } from './compile';
import { FormulaError } from './errors';

const CUSTOM_PREFIX = 'custom.';

/**
 * Edges: a formula definition -> every other definition key it references
 * (a ref matches a key directly or via a `custom.` prefix). Throws FORMULA_CYCLE
 * with the path, e.g. "a -> b -> a". Self-reference is a cycle.
 */
export function assertNoCycles(defs: readonly { key: string; formula: Formula | null }[]): void {
  const edges = new Map<string, string[]>();
  for (const d of defs) edges.set(d.key, []);
  for (const d of defs) {
    if (d.formula === null) continue;
    const out = edges.get(d.key);
    if (out === undefined) continue;
    for (const ref of d.formula.refs) {
      const target = edges.has(ref)
        ? ref
        : ref.startsWith(CUSTOM_PREFIX) && edges.has(ref.slice(CUSTOM_PREFIX.length))
          ? ref.slice(CUSTOM_PREFIX.length)
          : undefined;
      if (target !== undefined && !out.includes(target)) out.push(target);
    }
  }

  const done = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (onStack.has(key)) {
      const path = [...stack.slice(stack.indexOf(key)), key];
      throw new FormulaError('FORMULA_CYCLE', `formula cycle: ${path.join(' -> ')}`, 0);
    }
    stack.push(key);
    onStack.add(key);
    for (const next of edges.get(key) ?? []) visit(next);
    stack.pop();
    onStack.delete(key);
    done.add(key);
  };

  for (const d of defs) visit(d.key);
}
