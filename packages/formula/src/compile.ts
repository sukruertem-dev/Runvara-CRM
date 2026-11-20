import type { Node } from './ast';
import { parse } from './parser';

export interface Formula {
  readonly source: string;
  readonly refs: readonly string[];
}

const asts = new WeakMap<Formula, Node>();

export function compileFormula(source: string, knownRefs: ReadonlySet<string>): Formula {
  const { ast, refs } = parse(source, knownRefs);
  const formula: Formula = Object.freeze({ source, refs: Object.freeze(refs) });
  asts.set(formula, ast);
  return formula;
}

/** AST of a compiled formula; a structurally equal plain object (e.g. deserialised) is re-parsed against its own refs. */
export function astOf(f: Formula): Node {
  const cached = asts.get(f);
  if (cached !== undefined) return cached;
  const { ast } = parse(f.source, new Set(f.refs));
  asts.set(f, ast);
  return ast;
}
