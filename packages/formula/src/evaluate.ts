/*
 * Formula semantics (pure AST interpreter; no eval / Function / prototype access).
 *
 * TYPE RULE (single rule): there is no coercion and evaluation never throws a
 * type error. Any operand of the wrong type yields null (SQL-like "unknown"):
 *   - arithmetic (+ - * / % and unary -) needs numbers; numeric strings are NOT
 *     coerced, booleans are not numbers; otherwise the result is null.
 *   - comparison needs two operands of the same type (number/string/boolean);
 *     null or mixed types -> null. Dates are ISO strings, so they compare lexically.
 *   - NOT / AND / OR / IF condition use three-valued logic; a non-boolean
 *     operand counts as unknown (null).
 *   - division/modulo by zero -> null; NaN / +-Infinity results -> null.
 * Record values: finite numbers, strings and booleans pass through; Date -> ISO
 * string (invalid Date -> null); everything else (undefined, objects, arrays) -> null.
 * Reference lookup: own keys only (hasOwnProperty); a dotted name is first tried as
 * a flat key ("custom.cf_x"), then as a path through plain nested objects.
 * FORMULA_TYPE is reserved and not raised by this interpreter.
 */
import type { Node, Value } from './ast';
import { astOf, type Formula } from './compile';
import { FormulaError, MAX_STEPS } from './errors';

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const DAY_MS = 86_400_000;

function normalize(v: unknown): Value {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  return null;
}

function lookup(record: Readonly<Record<string, unknown>>, name: string): Value {
  if (hasOwn(record, name)) return normalize(record[name]);
  if (!name.includes('.')) return null;
  let cur: unknown = record;
  for (const seg of name.split('.')) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur) || !hasOwn(cur, seg)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return normalize(cur);
}

function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

function arith(op: string, a: Value, b: Value): Value {
  if (typeof a !== 'number' || typeof b !== 'number') return null;
  switch (op) {
    case 'add':
      return finite(a + b);
    case 'sub':
      return finite(a - b);
    case 'mul':
      return finite(a * b);
    case 'div':
      return b === 0 ? null : finite(a / b);
    default:
      return b === 0 ? null : finite(a % b);
  }
}

function compare(op: string, a: Value, b: Value): Value {
  if (a === null || b === null || typeof a !== typeof b) return null;
  const x = typeof a === 'boolean' ? Number(a) : a;
  const y = typeof b === 'boolean' ? Number(b) : b;
  switch (op) {
    case 'eq':
      return x === y;
    case 'ne':
      return x !== y;
    case 'lt':
      return x < y;
    case 'le':
      return x <= y;
    case 'gt':
      return x > y;
    default:
      return x >= y;
  }
}

function toDay(v: Value): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(v);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const base = new Date(Date.UTC(y, mo - 1, d));
  if (base.getUTCFullYear() !== y || base.getUTCMonth() !== mo - 1 || base.getUTCDate() !== d) return null;
  const ms = v.length === 10 ? base.getTime() : Date.parse(v);
  return Number.isNaN(ms) ? null : Math.floor(ms / DAY_MS);
}

function roundHalfAway(x: number, digits: number): number | null {
  if (Math.abs(x) >= 1e15) return x;
  const abs = Math.abs(x);
  const shifted = Math.round(Number(`${String(abs)}e${String(digits)}`));
  const back = Number(`${String(shifted)}e-${String(digits)}`);
  return finite(x < 0 ? -back : back);
}

function text(v: Value): string {
  return v === null ? '' : String(v);
}

export function runAst(
  root: Node,
  record: Readonly<Record<string, unknown>>,
  now: Date,
  maxSteps: number = MAX_STEPS,
): Value {
  let steps = 0;
  const ev = (n: Node): Value => {
    steps++;
    if (steps > maxSteps) throw new FormulaError('FORMULA_LIMIT', 'evaluation step budget exceeded', 0);
    switch (n.kind) {
      case 'num':
      case 'str':
      case 'bool':
        return n.value;
      case 'null':
        return null;
      case 'ref':
        return lookup(record, n.name);
      case 'neg': {
        const v = ev(n.arg);
        return typeof v === 'number' ? finite(-v) : null;
      }
      case 'not': {
        const v = ev(n.arg);
        return typeof v === 'boolean' ? !v : null;
      }
      case 'bin': {
        if (n.op === 'and') {
          const l = ev(n.left);
          if (l === false) return false;
          const r = ev(n.right);
          if (r === false) return false;
          return l === true && r === true ? true : null;
        }
        if (n.op === 'or') {
          const l = ev(n.left);
          if (l === true) return true;
          const r = ev(n.right);
          if (r === true) return true;
          return l === false && r === false ? false : null;
        }
        const l = ev(n.left);
        const r = ev(n.right);
        return n.op === 'add' || n.op === 'sub' || n.op === 'mul' || n.op === 'div' || n.op === 'mod'
          ? arith(n.op, l, r)
          : compare(n.op, l, r);
      }
      case 'call':
        return call(n.name, n.args);
    }
  };

  const call = (name: string, args: readonly Node[]): Value => {
    const first = args[0];
    switch (name) {
      case 'IF': {
        const [, a, b] = args;
        if (first === undefined || a === undefined || b === undefined) return null;
        const c = ev(first);
        if (typeof c !== 'boolean') return null;
        return ev(c ? a : b);
      }
      case 'COALESCE': {
        for (const a of args) {
          const v = ev(a);
          if (v !== null) return v;
        }
        return null;
      }
      case 'TODAY':
        return Number.isNaN(now.getTime()) ? null : now.toISOString().slice(0, 10);
      default:
        break;
    }
    const vals = args.map(ev);
    const v0 = vals[0] ?? null;
    switch (name) {
      case 'ROUND': {
        if (typeof v0 !== 'number') return null;
        const d = vals.length > 1 ? vals[1] : 0;
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 10) return null;
        return roundHalfAway(v0, d);
      }
      case 'ABS':
        return typeof v0 === 'number' ? Math.abs(v0) : null;
      case 'MIN':
      case 'MAX': {
        let best: number | null = null;
        for (const v of vals) {
          if (typeof v !== 'number') return null;
          if (best === null || (name === 'MIN' ? v < best : v > best)) best = v;
        }
        return best;
      }
      case 'DAYS_BETWEEN': {
        const a = toDay(v0);
        const b = toDay(vals[1] ?? null);
        return a === null || b === null ? null : b - a;
      }
      case 'CONCAT':
        return vals.map(text).join('');
      case 'LEN':
        return typeof v0 === 'string' ? v0.length : null;
      default:
        throw new FormulaError('FORMULA_SYNTAX', `unknown function '${name}'`, 0);
    }
  };

  return ev(root);
}

export function evaluate(
  f: Formula,
  record: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
): number | string | boolean | null {
  return runAst(astOf(f), record, now);
}
