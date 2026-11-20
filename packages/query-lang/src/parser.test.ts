import { describe, expect, it } from 'vitest';
import type { Expr } from './ast';
import { RqlError, type RqlErrorCode } from './errors';
import { parse } from './parser';

function fail(input: string): RqlError {
  try {
    parse(input);
  } catch (e) {
    if (e instanceof RqlError) return e;
    throw e;
  }
  throw new Error(`expected "${input}" to fail`);
}

/** Compact S-expression rendering of the AST for precedence assertions. */
function show(e: Expr): string {
  switch (e.kind) {
    case 'and':
    case 'or':
      return `(${e.kind} ${e.items.map(show).join(' ')})`;
    case 'not':
      return `(not ${show(e.expr)})`;
    case 'cmp':
      return `${e.field}${e.op}${e.value.kind === 'func' ? `${e.value.name}()` : String('value' in e.value ? e.value.value : `${e.value.amount}${e.value.unit}`)}`;
    case 'in':
      return `${e.field}${e.negated ? ' notin' : ' in'}[${e.values.length}]`;
    case 'empty':
      return `${e.field}${e.negated ? ' notempty' : ' empty'}`;
  }
}

function where(input: string): string {
  const q = parse(input);
  if (q.where === null) throw new Error('no where');
  return show(q.where);
}

describe('parser', () => {
  it('empty and whitespace-only input yields an empty query', () => {
    expect(parse('')).toEqual({ where: null, orderBy: [] });
    expect(parse(' \t\n ')).toEqual({ where: null, orderBy: [] });
  });

  it('precedence: OR < AND < NOT', () => {
    expect(where('a = 1 OR b = 2 AND c = 3')).toBe('(or a=1 (and b=2 c=3))');
    expect(where('a = 1 AND b = 2 OR c = 3')).toBe('(or (and a=1 b=2) c=3)');
    expect(where('NOT a = 1 AND b = 2')).toBe('(and (not a=1) b=2)');
    expect(where('NOT a = 1 OR b = 2')).toBe('(or (not a=1) b=2)');
    expect(where('a = 1 OR NOT b = 2 AND c = 3')).toBe('(or a=1 (and (not b=2) c=3))');
  });

  it('chains of the same operator are flattened and left-associative groups stay equivalent', () => {
    expect(where('a=1 OR b=2 OR c=3')).toBe('(or a=1 b=2 c=3)');
    expect(where('a=1 AND b=2 AND c=3')).toBe('(and a=1 b=2 c=3)');
    expect(where('a=1 OR b=2 AND c=3 AND d=4 OR e=5')).toBe('(or a=1 (and b=2 c=3 d=4) e=5)');
  });

  it('parentheses override precedence', () => {
    expect(where('(a = 1 OR b = 2) AND c = 3')).toBe('(and (or a=1 b=2) c=3)');
    expect(where('((a = 1))')).toBe('a=1');
    expect(where('NOT (a = 1 OR b = 2)')).toBe('(not (or a=1 b=2))');
    expect(where('NOT NOT a = 1')).toBe('(not (not a=1))');
  });

  it('Turkish keywords behave identically', () => {
    expect(where('a = 1 VEYA b = 2 VE c = 3')).toBe('(or a=1 (and b=2 c=3))');
    expect(where('DEĞİL a = 1')).toBe('(not a=1)');
    expect(where('değil a = 1')).toBe('(not a=1)');
    expect(where('a İçinde (1, 2)')).toBe('a in[2]');
    expect(where('a içinde (1)')).toBe('a in[1]');
    expect(where('a IS BOŞ')).toBe('a empty');
    expect(where('a IS DEĞİL BOŞ')).toBe('a notempty');
    expect(where('a DEĞİL BOŞ')).toBe('a notempty');
    expect(where('a boş')).toBe('a empty');
  });

  it('values: strings, words, numbers, booleans, dates, relative dates, functions', () => {
    const q = parse(`a = "x" AND b = open AND c = -1.5 AND d = true AND e = 2026-03-10 AND f = 2026-03-10T09:00 AND g < +7d AND h = Me() AND i = startOfWeek() AND j = myTeams()`);
    const items = q.where?.kind === 'and' ? q.where.items : [];
    const values = items.map((i) => (i.kind === 'cmp' ? i.value : null));
    expect(values.map((v) => v?.kind)).toEqual(['string', 'word', 'number', 'bool', 'date', 'date', 'rel', 'func', 'func', 'func']);
    expect(values[5]).toMatchObject({ hasTime: true });
    expect(values[4]).toMatchObject({ hasTime: false });
    expect(values[7]).toMatchObject({ name: 'me' });
    expect(values[8]).toMatchObject({ name: 'startOfWeek' });
  });

  it('IN / NOT IN / IS EMPTY / IS NOT EMPTY / ~', () => {
    expect(where('a IN (1, 2, 3)')).toBe('a in[3]');
    expect(where('a NOT IN (1)')).toBe('a notin[1]');
    expect(where('a IS EMPTY')).toBe('a empty');
    expect(where('a IS NOT EMPTY')).toBe('a notempty');
    expect(where('a ~ "x"')).toBe('a~x');
  });

  it('ORDER BY with directions, with and without WHERE', () => {
    expect(parse('a = 1 ORDER BY b DESC, c ASC, d')).toMatchObject({
      orderBy: [
        { field: 'b', direction: 'desc', fieldPos: 15 },
        { field: 'c', direction: 'asc' },
        { field: 'd', direction: 'asc' },
      ],
    });
    expect(parse('order by custom.cf_x desc')).toEqual({
      where: null,
      orderBy: [{ field: 'custom.cf_x', direction: 'desc', fieldPos: 9 }],
    });
  });

  it('records positions on nodes', () => {
    const q = parse('  a = 1 AND bb != 2');
    expect(q.where).toMatchObject({
      kind: 'and',
      items: [
        { kind: 'cmp', field: 'a', fieldPos: 2, opPos: 4, value: { pos: 6 } },
        { kind: 'cmp', field: 'bb', fieldPos: 12, opPos: 15, value: { pos: 18 } },
      ],
    });
  });

  describe('syntax errors carry position and a clear message', () => {
    const cases: [string, number, RegExp][] = [
      ['a =', 3, /expected a value but found end of input/],
      ['a = = 1', 4, /expected a value/],
      ['a 1', 2, /expected an operator/],
      ['= 1', 0, /expected a field name/],
      ['a = 1 b = 2', 6, /unexpected "b"/],
      ['a = 1 AND', 9, /expected a field name/],
      ['(a = 1', 6, /expected "\)"/],
      ['a = 1)', 5, /unexpected "\)"/],
      ['a IN 1', 5, /expected "\("/],
      ['a IN ()', 6, /expected a value/],
      ['a IN (1,)', 8, /expected a value/],
      ['a IN myTeams()', 5, /expected "\("/],
      ['a IS 1', 5, /expected EMPTY/],
      ['a IS NOT 1', 9, /expected EMPTY/],
      ['a ~ 5', 4, /expected a quoted string after "~"/],
      ['a ~ b', 4, /expected a quoted string after "~"/],
      ['a = foo()', 4, /unknown function "foo"/],
      ['a = me(1)', 7, /expected "\)"/],
      ['a = b.c', 4, /expected a value/],
      ['a = AND', 4, /expected a value/],
      ['a = 1 ORDER', 11, /expected BY/],
      ['a = 1 ORDER BY', 14, /expected a field name in ORDER BY/],
      ['a = 1 ORDER BY b,', 17, /expected a field name in ORDER BY/],
      ['a = 1 ORDER BY b c', 17, /unexpected "c"/],
      ['ORDER BY a ORDER BY b', 11, /unexpected "ORDER"/],
      ['NOT', 3, /expected a field name/],
      ['a = "x', 4, /unterminated/],
      ['a = 1 ;', 6, /unexpected character/],
      ['a = true IS', 9, /unexpected/],
    ];
    it.each(cases)('%s', (input, position, message) => {
      const e = fail(input);
      expect(e.code).toBe('RQL_SYNTAX' satisfies RqlErrorCode);
      expect(e.position).toBe(position);
      expect(e.message).toMatch(message);
    });
  });

  describe('limits', () => {
    it('rejects input longer than 4096 characters', () => {
      const ok = `a = "${'x'.repeat(4096 - 6)}"`;
      expect(ok.length).toBe(4096);
      expect(() => parse(ok)).not.toThrow();
      const e = fail(`${ok} `);
      expect(e).toMatchObject({ code: 'LIMIT_EXCEEDED', position: 4096 });
    });

    it('allows exactly 50 comparisons and rejects the 51st', () => {
      const mk = (n: number): string => Array.from({ length: n }, (_, i) => `a = ${i}`).join(' OR ');
      expect(() => parse(mk(50))).not.toThrow();
      const e = fail(mk(51));
      expect(e.code).toBe('LIMIT_EXCEEDED');
      expect(e.position).toBe(mk(50).length + 4);
    });

    it('counts IN and IS EMPTY as comparisons', () => {
      const mk = (n: number): string => Array.from({ length: n }, (_, i) => (i % 2 ? 'a IS EMPTY' : 'a IN (1)')).join(' AND ');
      expect(() => parse(mk(50))).not.toThrow();
      expect(fail(mk(51)).code).toBe('LIMIT_EXCEEDED');
    });

    it('allows nesting depth 10 and rejects 11', () => {
      const nest = (n: number): string => `${'('.repeat(n)}a = 1${')'.repeat(n)}`;
      expect(() => parse(nest(10))).not.toThrow();
      const e = fail(nest(11));
      expect(e).toMatchObject({ code: 'LIMIT_EXCEEDED', position: 10 });
      expect(() => parse(`${'NOT '.repeat(10)}a = 1`)).not.toThrow();
      expect(fail(`${'NOT '.repeat(11)}a = 1`).code).toBe('LIMIT_EXCEEDED');
    });

    it('rejects structural depth beyond 10 even when parentheses are shallow', () => {
      // each level adds an AND/OR group node
      let q = 'a = 1';
      for (let i = 0; i < 11; i++) q = `(${i % 2 ? 'x = 1 AND ' : 'x = 1 OR '}${q})`;
      expect(fail(q).code).toBe('LIMIT_EXCEEDED');
    });

    it('allows 500 IN values and rejects 501', () => {
      const mk = (n: number): string => `a IN (${Array.from({ length: n }, (_, i) => i).join(',')})`;
      expect(() => parse(mk(500))).not.toThrow();
      const e = fail(mk(501));
      expect(e.code).toBe('LIMIT_EXCEEDED');
    });

    it('rejects more than 10 ORDER BY fields', () => {
      const mk = (n: number): string => `ORDER BY ${Array.from({ length: n }, (_, i) => `f${i}`).join(', ')}`;
      expect(() => parse(mk(10))).not.toThrow();
      expect(fail(mk(11)).code).toBe('LIMIT_EXCEEDED');
    });
  });

  it('non-string input is a syntax error, not a crash', () => {
    expect(() => parse(undefined as unknown as string)).toThrow(RqlError);
    expect(() => parse({} as unknown as string)).toThrow(RqlError);
  });
});
