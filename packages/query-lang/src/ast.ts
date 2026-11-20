import { RqlError } from './errors';

export const MAX_INPUT_LENGTH = 4096;
export const MAX_COMPARISONS = 50;
export const MAX_DEPTH = 10;
export const MAX_IN_VALUES = 500;
export const MAX_ORDER_ITEMS = 10;
export const MAX_RELATIVE_AMOUNT = 100_000;

export type RelUnit = 'm' | 'h' | 'd' | 'w' | 'M';
export type FuncName = 'me' | 'today' | 'now' | 'startOfWeek' | 'startOfMonth' | 'myTeams' | 'myQueues';
export type RqlOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | '~';

export type RqlValue =
  | { readonly kind: 'string'; readonly value: string; readonly pos: number }
  /** Unquoted bare word (`status = open`); only meaningful for text / enum / user / uuid fields. */
  | { readonly kind: 'word'; readonly value: string; readonly pos: number }
  | { readonly kind: 'number'; readonly value: number; readonly pos: number }
  | { readonly kind: 'bool'; readonly value: boolean; readonly pos: number }
  /** Unquoted ISO date (`YYYY-MM-DD`) or datetime (`YYYY-MM-DDTHH:mm[:ss[.SSS]][Z|±HH:mm]`). */
  | { readonly kind: 'date'; readonly value: string; readonly hasTime: boolean; readonly pos: number }
  | { readonly kind: 'rel'; readonly amount: number; readonly unit: RelUnit; readonly pos: number }
  | { readonly kind: 'func'; readonly name: FuncName; readonly pos: number };

export interface Comparison {
  readonly kind: 'cmp';
  readonly field: string;
  readonly fieldPos: number;
  readonly op: RqlOp;
  readonly opPos: number;
  readonly value: RqlValue;
  readonly pos: number;
}
export interface InExpr {
  readonly kind: 'in';
  readonly field: string;
  readonly fieldPos: number;
  readonly negated: boolean;
  readonly values: readonly RqlValue[];
  readonly pos: number;
}
export interface EmptyExpr {
  readonly kind: 'empty';
  readonly field: string;
  readonly fieldPos: number;
  readonly negated: boolean;
  readonly pos: number;
}
export interface GroupExpr {
  readonly kind: 'and' | 'or';
  readonly items: readonly Expr[];
  readonly pos: number;
}
export interface NotExpr {
  readonly kind: 'not';
  readonly expr: Expr;
  readonly pos: number;
}
export type Expr = Comparison | InExpr | EmptyExpr | GroupExpr | NotExpr;

export interface OrderItem {
  readonly field: string;
  readonly fieldPos: number;
  readonly direction: 'asc' | 'desc';
}
export interface Query {
  readonly where: Expr | null;
  readonly orderBy: OrderItem[];
}

/**
 * Enforces the structural limits (ADR-0008 §5) on an AST: at most 50 comparisons, nesting depth 10,
 * 500 values per IN list. Recursion is bounded by the depth limit, so it is safe on hostile ASTs.
 */
export function checkLimits(root: Expr): void {
  let comparisons = 0;
  const leaf = (e: Expr): void => {
    comparisons += 1;
    if (comparisons > MAX_COMPARISONS) {
      throw new RqlError('LIMIT_EXCEEDED', `query has more than ${MAX_COMPARISONS} comparisons`, e.pos);
    }
  };
  const tooDeep = (e: Expr): RqlError =>
    new RqlError('LIMIT_EXCEEDED', `query nesting is deeper than ${MAX_DEPTH} levels`, e.pos);
  const walk = (e: Expr, depth: number): void => {
    switch (e.kind) {
      case 'and':
      case 'or': {
        if (depth + 1 > MAX_DEPTH) throw tooDeep(e);
        if (e.items.length === 0) throw new RqlError('RQL_SYNTAX', 'empty group', e.pos);
        for (const item of e.items) walk(item, depth + 1);
        return;
      }
      case 'not':
        if (depth + 1 > MAX_DEPTH) throw tooDeep(e);
        walk(e.expr, depth + 1);
        return;
      case 'in':
        leaf(e);
        if (e.values.length === 0) throw new RqlError('RQL_SYNTAX', 'IN list must not be empty', e.pos);
        if (e.values.length > MAX_IN_VALUES) {
          throw new RqlError('LIMIT_EXCEEDED', `IN list has more than ${MAX_IN_VALUES} values`, e.pos);
        }
        return;
      case 'cmp':
      case 'empty':
        leaf(e);
        return;
    }
  };
  walk(root, 0);
}
