import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { astOf } from './compile';
import { runAst } from './evaluate';
import { assertNoCycles, compileFormula, evaluate, FormulaError, type FormulaErrorCode } from './index';

const NOW = new Date('2024-03-15T10:30:00Z');

function run(src: string, rec: Record<string, unknown> = {}, extraRefs: string[] = []) {
  const known = new Set([...Object.keys(rec), ...extraRefs]);
  return evaluate(compileFormula(src, known), rec, NOW);
}

function codeOf(fn: () => unknown): FormulaErrorCode | 'NO_ERROR' | 'OTHER' {
  try {
    fn();
  } catch (e) {
    return e instanceof FormulaError ? e.code : 'OTHER';
  }
  return 'NO_ERROR';
}

const compileErr = (src: string, refs: string[] = []) => codeOf(() => compileFormula(src, new Set(refs)));

describe('literals and arithmetic', () => {
  it('evaluates operators', () => {
    expect(run('1 + 2')).toBe(3);
    expect(run('5 - 7')).toBe(-2);
    expect(run('3 * 4')).toBe(12);
    expect(run('7 / 2')).toBe(3.5);
    expect(run('7 % 4')).toBe(3);
    expect(run('-3')).toBe(-3);
    expect(run('--3')).toBe(3);
    expect(run('1.5 + 1.25')).toBe(2.75);
  });

  it('respects precedence', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('10 - 4 - 3')).toBe(3);
    expect(run('2 * 3 % 4')).toBe(2);
    expect(run('-2 * 3')).toBe(-6);
    expect(run('1 + 1 = 2')).toBe(true);
    expect(run('NOT 1 = 2')).toBe(true);
    expect(run('TRUE OR FALSE AND FALSE')).toBe(true);
    expect(run('NOT FALSE AND FALSE')).toBe(false);
    expect(run('1 < 2 AND 2 < 3 OR FALSE')).toBe(true);
  });

  it('handles strings and escapes', () => {
    expect(run('"a\\"b\\\\c"')).toBe('a"b\\c');
    expect(codeOf(() => compileFormula('"abc', new Set()))).toBe('FORMULA_SYNTAX');
    expect(compileErr('"a\\nb"')).toBe('FORMULA_SYNTAX');
  });

  it('resolves references including dotted ones', () => {
    expect(run('{amount} * 2', { amount: 21 })).toBe(42);
    expect(run('{custom.cf_x} + 1', { 'custom.cf_x': 1 })).toBe(2);
    expect(run('{custom.cf_x} + 1', { custom: { cf_x: 5 } }, ['custom.cf_x'])).toBe(6);
    expect(run('{missing} + 1', {}, ['missing'])).toBeNull();
  });
});

describe('comparison and logic', () => {
  it('compares same-type values', () => {
    expect(run('1 = 1')).toBe(true);
    expect(run('1 != 1')).toBe(false);
    expect(run('1 < 2')).toBe(true);
    expect(run('2 <= 2')).toBe(true);
    expect(run('3 > 4')).toBe(false);
    expect(run('4 >= 4')).toBe(true);
    expect(run('"a" < "b"')).toBe(true);
    expect(run('"a" = "a"')).toBe(true);
    expect(run('FALSE < TRUE')).toBe(true);
  });

  it('three-valued logic', () => {
    expect(run('NULL = NULL')).toBeNull();
    expect(run('1 < NULL')).toBeNull();
    expect(run('NOT NULL')).toBeNull();
    expect(run('NULL AND FALSE')).toBe(false);
    expect(run('FALSE AND NULL')).toBe(false);
    expect(run('NULL AND TRUE')).toBeNull();
    expect(run('NULL OR TRUE')).toBe(true);
    expect(run('TRUE OR NULL')).toBe(true);
    expect(run('NULL OR FALSE')).toBeNull();
    expect(run('FALSE OR FALSE')).toBe(false);
    expect(run('TRUE AND TRUE')).toBe(true);
    expect(run('NOT TRUE')).toBe(false);
  });
});

describe('type rule: no coercion, wrong type -> null', () => {
  it('does not coerce numeric strings or booleans in arithmetic', () => {
    expect(run('"5" + 1')).toBeNull();
    expect(run('{a} * 2', { a: '3' })).toBeNull();
    expect(run('TRUE + 1')).toBeNull();
    expect(run('-"5"')).toBeNull();
  });
  it('mixed-type comparison is null; non-boolean logic operands are unknown', () => {
    expect(run('1 = "1"')).toBeNull();
    expect(run('1 AND TRUE')).toBeNull();
    expect(run('NOT 1')).toBeNull();
    expect(run('IF(1, 2, 3)')).toBeNull();
  });
  it('null propagates through arithmetic', () => {
    expect(run('NULL + 1')).toBeNull();
    expect(run('1 * NULL')).toBeNull();
    expect(run('-NULL')).toBeNull();
  });
  it('division/modulo by zero and non-finite results are null', () => {
    expect(run('1 / 0')).toBeNull();
    expect(run('1 % 0')).toBeNull();
    expect(run('{a} * {a}', { a: 1e200 })).toBeNull();
    expect(run('{a}', { a: Infinity })).toBeNull();
    expect(run('{a}', { a: NaN })).toBeNull();
  });
  it('normalises record values', () => {
    expect(run('{a}', { a: new Date('2024-01-02T00:00:00Z') })).toBe('2024-01-02T00:00:00.000Z');
    expect(run('{a}', { a: new Date('x') })).toBeNull();
    expect(run('{a}', { a: { x: 1 } })).toBeNull();
    expect(run('{a}', { a: undefined })).toBeNull();
    expect(run('{a}', { a: true })).toBe(true);
  });
});

describe('functions', () => {
  it('IF', () => {
    expect(run('IF(1 < 2, "y", "n")')).toBe('y');
    expect(run('if(1 > 2, "y", "n")')).toBe('n');
    expect(run('IF(NULL, 1, 2)')).toBeNull();
  });
  it('IF is lazy', () => {
    expect(run('IF(TRUE, 1, 1 / 0)')).toBe(1);
    expect(run('IF(FALSE, 1 / 0, 2)')).toBe(2);
    expect(run('IF(TRUE, 1, ROUND("a") / 0)')).toBe(1);
  });
  it('ROUND', () => {
    expect(run('ROUND(2.5)')).toBe(3);
    expect(run('ROUND(-2.5)')).toBe(-3);
    expect(run('ROUND(1.005, 2)')).toBe(1.01);
    expect(run('ROUND(3.14159, 3)')).toBe(3.142);
    expect(run('ROUND(1, 11)')).toBeNull();
    expect(run('ROUND(1, -1)')).toBeNull();
    expect(run('ROUND(1, 1.5)')).toBeNull();
    expect(run('ROUND("a")')).toBeNull();
    expect(run('ROUND(NULL)')).toBeNull();
    expect(run('ROUND(1, 10)')).toBe(1);
  });
  it('ABS / MIN / MAX', () => {
    expect(run('ABS(-4)')).toBe(4);
    expect(run('ABS("a")')).toBeNull();
    expect(run('MIN(3, 1, 2)')).toBe(1);
    expect(run('MAX(3, 1, 2)')).toBe(3);
    expect(run('MIN(5)')).toBe(5);
    expect(run('MAX(1, NULL)')).toBeNull();
    expect(run('MIN(1, "a")')).toBeNull();
  });
  it('COALESCE', () => {
    expect(run('COALESCE(NULL, NULL, 3, 4)')).toBe(3);
    expect(run('COALESCE(NULL)')).toBeNull();
    expect(run('COALESCE({a}, 7)', { a: null })).toBe(7);
    expect(run('COALESCE(1, 1 / 0)')).toBe(1);
  });
  it('DAYS_BETWEEN / TODAY', () => {
    expect(run('DAYS_BETWEEN("2024-01-01", "2024-01-31")')).toBe(30);
    expect(run('DAYS_BETWEEN("2024-01-31", "2024-01-01")')).toBe(-30);
    expect(run('DAYS_BETWEEN("2024-01-01T23:59:59Z", "2024-01-02T00:00:01Z")')).toBe(1);
    expect(run('DAYS_BETWEEN({a}, "2024-03-01")', { a: new Date('2024-02-01T12:00:00Z') })).toBe(29);
    expect(run('DAYS_BETWEEN("2024-02-30", "2024-03-01")')).toBeNull();
    expect(run('DAYS_BETWEEN("nope", "2024-03-01")')).toBeNull();
    expect(run('DAYS_BETWEEN(1, 2)')).toBeNull();
    expect(run('DAYS_BETWEEN(NULL, "2024-03-01")')).toBeNull();
    expect(run('TODAY()')).toBe('2024-03-15');
    expect(run('DAYS_BETWEEN("2024-03-01", TODAY())')).toBe(14);
    expect(evaluate(compileFormula('TODAY()', new Set()), {}, new Date('x'))).toBeNull();
    expect(evaluate(compileFormula('TODAY()', new Set()), {})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('CONCAT / LEN', () => {
    expect(run('CONCAT("a", NULL, 1, TRUE)')).toBe('a1true');
    expect(run('CONCAT()')).toBe('');
    expect(run('LEN("héllo")')).toBe(5);
    expect(run('LEN(1)')).toBeNull();
    expect(run('LEN(NULL)')).toBeNull();
  });
  it('rejects unknown functions and wrong arity at compile time', () => {
    expect(compileErr('NOPE(1)')).toBe('FORMULA_SYNTAX');
    expect(compileErr('IF(1, 2)')).toBe('FORMULA_SYNTAX');
    expect(compileErr('ABS()')).toBe('FORMULA_SYNTAX');
    expect(compileErr('ABS(1, 2)')).toBe('FORMULA_SYNTAX');
    expect(compileErr('MIN()')).toBe('FORMULA_SYNTAX');
    expect(compileErr('TODAY(1)')).toBe('FORMULA_SYNTAX');
    expect(compileErr('ROUND(1, 2, 3)')).toBe('FORMULA_SYNTAX');
    expect(compileErr('IF(TRUE, 1, NOPE(1))')).toBe('FORMULA_SYNTAX');
    expect(compileErr('toString(1)')).toBe('FORMULA_SYNTAX');
    expect(compileErr('constructor(1)')).toBe('FORMULA_SYNTAX');
  });
});

describe('syntax errors and positions', () => {
  it('reports FORMULA_SYNTAX with position', () => {
    for (const src of ['', '1 +', '(1', '1 2', ')', 'abc', '1 $ 2', '{}', '{a', '1.', '1 = = 2', 'IF(1,2', '1,2']) {
      expect(compileErr(src)).toBe('FORMULA_SYNTAX');
    }
    try {
      compileFormula('1 + $', new Set());
    } catch (e) {
      expect(e).toBeInstanceOf(FormulaError);
      expect((e as FormulaError).position).toBe(4);
    }
  });
  it('unknown refs', () => {
    expect(compileErr('{nope}', ['a'])).toBe('FORMULA_UNKNOWN_REF');
    try {
      compileFormula('1 + {nope}', new Set());
    } catch (e) {
      expect((e as FormulaError).position).toBe(4);
    }
  });
  it('collects unique refs in order', () => {
    const f = compileFormula('{b} + {a} + {b}', new Set(['a', 'b']));
    expect(f.refs).toEqual(['b', 'a']);
    expect(f.source).toBe('{b} + {a} + {b}');
  });
  it('re-parses a plain (deserialised) formula object', () => {
    expect(evaluate({ source: '{a} + 1', refs: ['a'] }, { a: 1 })).toBe(2);
  });
});

describe('limits', () => {
  it('source length', () => {
    expect(compileErr('1+'.repeat(1000) + '1')).toBe('FORMULA_LIMIT');
    expect(compileErr(' '.repeat(2001))).toBe('FORMULA_LIMIT');
    expect(codeOf(() => compileFormula('1' + ' '.repeat(1999), new Set()))).toBe('NO_ERROR');
  });
  it('node count', () => {
    expect(codeOf(() => compileFormula(Array(166).fill('1').join('+'), new Set()))).toBe('NO_ERROR'); // 331 nodes
    expect(compileErr(Array(260).fill('1').join('+'))).toBe('FORMULA_LIMIT'); // 519 nodes
  });
  it('nesting depth', () => {
    expect(codeOf(() => compileFormula('('.repeat(40) + '1' + ')'.repeat(40), new Set()))).toBe('NO_ERROR');
    expect(compileErr('('.repeat(60) + '1' + ')'.repeat(60))).toBe('FORMULA_LIMIT');
    expect(compileErr('-'.repeat(60) + '1')).toBe('FORMULA_LIMIT');
    expect(compileErr('NOT '.repeat(60) + 'TRUE')).toBe('FORMULA_LIMIT');
    expect(compileErr('ABS('.repeat(60) + '1' + ')'.repeat(60))).toBe('FORMULA_LIMIT');
  });
  it('evaluation step budget', () => {
    const ast = astOf(compileFormula('1 + 2 + 3', new Set()));
    expect(() => runAst(ast, {}, NOW, 3)).toThrowError(FormulaError);
    expect(codeOf(() => runAst(ast, {}, NOW, 3))).toBe('FORMULA_LIMIT');
    expect(runAst(ast, {}, NOW, 5)).toBe(6);
  });
});

describe('prototype safety', () => {
  it('__proto__, constructor, toString, hasOwnProperty refs resolve to null', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const f = compileFormula(`{${name}}`, new Set([name]));
      expect(evaluate(f, {})).toBeNull();
    }
    expect(run('{__proto__.x}', {}, ['__proto__.x'])).toBeNull();
    expect(run('{constructor.name}', {}, ['constructor.name'])).toBeNull();
    expect(run('{custom.constructor}', { custom: {} }, ['custom.constructor'])).toBeNull();
    expect(run('{custom.__proto__}', { custom: {} }, ['custom.__proto__'])).toBeNull();
  });
  it('does not pollute Object.prototype', () => {
    run('{__proto__} + 1', { a: 1 }, ['__proto__']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
  it('own __proto__ key from JSON is just a value', () => {
    const rec = JSON.parse('{"__proto__": 5}') as Record<string, unknown>;
    expect(evaluate(compileFormula('{__proto__}', new Set(['__proto__'])), rec)).toBe(5);
  });
});

describe('assertNoCycles', () => {
  const f = (src: string, refs: string[]) => compileFormula(src, new Set(refs));
  it('detects 2-node cycle with path', () => {
    const defs = [
      { key: 'a', formula: f('{b} + 1', ['b']) },
      { key: 'b', formula: f('{a} + 1', ['a']) },
    ];
    expect(() => { assertNoCycles(defs); }).toThrowError(/a -> b -> a/);
    expect(codeOf(() => { assertNoCycles(defs); })).toBe('FORMULA_CYCLE');
  });
  it('detects 3-node cycle', () => {
    const defs = [
      { key: 'a', formula: f('{b}', ['b']) },
      { key: 'b', formula: f('{c}', ['c']) },
      { key: 'c', formula: f('{a}', ['a']) },
    ];
    expect(() => { assertNoCycles(defs); }).toThrowError(/a -> b -> c -> a/);
  });
  it('detects self reference', () => {
    expect(() => { assertNoCycles([{ key: 'a', formula: f('{a}', ['a']) }]); }).toThrowError(/a -> a/);
  });
  it('accepts an acyclic DAG, null formulas and non-key refs', () => {
    const defs = [
      { key: 'a', formula: f('{b} + {c} + {amount}', ['b', 'c', 'amount']) },
      { key: 'b', formula: f('{c}', ['c']) },
      { key: 'c', formula: null },
      { key: 'd', formula: f('{a} + {b}', ['a', 'b']) },
    ];
    expect(() => { assertNoCycles(defs); }).not.toThrow();
  });
  it('resolves custom. prefixed refs', () => {
    const defs = [
      { key: 'cf_a', formula: f('{custom.cf_b}', ['custom.cf_b']) },
      { key: 'cf_b', formula: f('{custom.cf_a}', ['custom.cf_a']) },
    ];
    expect(() => { assertNoCycles(defs); }).toThrowError(/cf_a -> cf_b -> cf_a/);
  });
  it('handles __proto__ as a key safely', () => {
    expect(() => { assertNoCycles([{ key: '__proto__', formula: null }]); }).not.toThrow();
  });
});

describe('property tests', () => {
  it('compileFormula either returns or throws FormulaError only', () => {
    const alphabet = fc.string({ unit: fc.constantFrom(...'0123456789+-*/%()<>=!,{}."\\ abcAND_IFOR'.split('')), maxLength: 80 });
    for (const arb of [fc.string({ maxLength: 120 }), alphabet]) {
      fc.assert(
        fc.property(arb, (s) => {
          try {
            const f = compileFormula(s, new Set(['a', 'b', 'abc']));
            evaluate(f, { a: 1, b: 'x', abc: null }, NOW);
          } catch (e) {
            expect(e).toBeInstanceOf(FormulaError);
          }
        }),
        { numRuns: 500 },
      );
    }
  });

  type Expr = { t: 'n'; v: number } | { t: 'r'; name: 'a' | 'b' } | { t: 'b'; op: '+' | '-' | '*'; l: Expr; r: Expr };
  const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
    e: fc.oneof(
      { depthSize: 'small', maxDepth: 4 },
      fc.integer({ min: -9, max: 9 }).map((v): Expr => ({ t: 'n', v })),
      fc.constantFrom<'a' | 'b'>('a', 'b').map((name): Expr => ({ t: 'r', name })),
      fc
        .tuple(fc.constantFrom<'+' | '-' | '*'>('+', '-', '*'), tie('e'), tie('e'))
        .map(([op, l, r]): Expr => ({ t: 'b', op, l, r })),
    ),
  })).e;

  const ENV = { a: 3, b: -4 };
  const render = (e: Expr): string =>
    e.t === 'n' ? `(${String(e.v)})` : e.t === 'r' ? `{${e.name}}` : `(${render(e.l)} ${e.op} ${render(e.r)})`;
  const reference = (e: Expr): number => {
    if (e.t === 'n') return e.v;
    if (e.t === 'r') return ENV[e.name];
    const l = reference(e.l);
    const r = reference(e.r);
    return e.op === '+' ? l + r : e.op === '-' ? l - r : l * r;
  };

  it('fully parenthesised arithmetic matches reference evaluation', () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        expect(run(render(e), ENV)).toBe(reference(e));
      }),
      { numRuns: 300 },
    );
  });

  it('flat expressions honour precedence (* before + -)', () => {
    const flat = fc.tuple(
      fc.array(fc.tuple(fc.constantFrom<'+' | '-' | '*'>('+', '-', '*'), fc.integer({ min: 0, max: 9 })), { maxLength: 12 }),
      fc.integer({ min: 0, max: 9 }),
    );
    fc.assert(
      fc.property(flat, ([rest, first]) => {
        const src = String(first) + rest.map(([op, n]) => ` ${op} ${String(n)}`).join('');
        // reference: sum of signed products
        let total = 0;
        let sign = 1;
        let prod = first;
        for (const [op, n] of rest) {
          if (op === '*') prod *= n;
          else {
            total += sign * prod;
            sign = op === '+' ? 1 : -1;
            prod = n;
          }
        }
        total += sign * prod;
        expect(run(src)).toBe(total);
      }),
      { numRuns: 300 },
    );
  });
});
