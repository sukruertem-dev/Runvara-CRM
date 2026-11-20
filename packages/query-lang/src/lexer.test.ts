import { describe, expect, it } from 'vitest';
import { RqlError } from './errors';
import { keywordOf, tokenize, type Token } from './lexer';

function kinds(input: string): string[] {
  return tokenize(input)
    .filter((t) => t.type !== 'eof')
    .map((t) => {
      switch (t.type) {
        case 'ident':
        case 'string':
        case 'number':
        case 'bool':
        case 'date':
        case 'op':
        case 'kw':
          return `${t.type}:${String(t.value)}`;
        case 'rel':
          return `rel:${t.amount}${t.unit}`;
        default:
          return t.type;
      }
    });
}

function fail(input: string): RqlError {
  try {
    tokenize(input);
  } catch (e) {
    if (e instanceof RqlError) return e;
    throw e;
  }
  throw new Error(`expected "${input}" to fail`);
}

describe('lexer', () => {
  it('tokenizes identifiers, dotted fields, operators and punctuation', () => {
    expect(kinds('custom.cf_budget >= 5')).toEqual(['ident:custom.cf_budget', 'op:>=', 'number:5']);
    expect(kinds('a=1 b!=2 c<3 d<=4 e>5 f>=6 g~"x"')).toEqual([
      'ident:a', 'op:=', 'number:1', 'ident:b', 'op:!=', 'number:2', 'ident:c', 'op:<', 'number:3',
      'ident:d', 'op:<=', 'number:4', 'ident:e', 'op:>', 'number:5', 'ident:f', 'op:>=', 'number:6',
      'ident:g', 'op:~', 'string:x',
    ]);
    expect(kinds('(a,b)')).toEqual(['(', 'ident:a', ',', 'ident:b', ')']);
  });

  it('records positions', () => {
    const toks = tokenize('  ab = 12');
    expect(toks.map((t) => [t.type, t.pos, t.end])).toEqual([
      ['ident', 2, 4],
      ['op', 5, 6],
      ['number', 7, 9],
      ['eof', 9, 9],
    ]);
  });

  it('reads double and single quoted strings with backslash escapes', () => {
    expect(kinds(String.raw`"a\"b" 'c\'d' "e\\f" "g\nh\ti\rj"`)).toEqual([
      'string:a"b', "string:c'd", 'string:e\\f', 'string:g\nh\ti\rj',
    ]);
    expect(kinds(`"it's" 'say "hi"'`)).toEqual(["string:it's", 'string:say "hi"']);
    expect(kinds('""')).toEqual(['string:']);
  });

  it('keeps unicode quotes and SQL metacharacters inside strings verbatim', () => {
    const t = tokenize(`"’ OR 1=1 -- ; $1 “"`)[0];
    expect(t).toMatchObject({ type: 'string', value: '’ OR 1=1 -- ; $1 “' });
  });

  it('numbers: ints, decimals, negatives', () => {
    expect(kinds('1 -2 3.5 -0.25 007')).toEqual(['number:1', 'number:-2', 'number:3.5', 'number:-0.25', 'number:7']);
  });

  it('booleans are case-insensitive', () => {
    expect(kinds('true FALSE True')).toEqual(['bool:true', 'bool:false', 'bool:true']);
  });

  it('relative dates', () => {
    expect(kinds('+7d -2w +3M +12h -30m +0d')).toEqual(['rel:7d', 'rel:-2w', 'rel:3M', 'rel:12h', 'rel:-30m', 'rel:0d']);
  });

  it('-5 is a number but -5d is a relative date', () => {
    expect(kinds('-5 -5d')).toEqual(['number:-5', 'rel:-5d']);
  });

  it('ISO dates and datetimes', () => {
    expect(kinds('2026-03-10 2026-03-10T09:30 2026-03-10T09:30:15.123Z 2026-03-10T09:30:00+03:00')).toEqual([
      'date:2026-03-10', 'date:2026-03-10T09:30', 'date:2026-03-10T09:30:15.123Z', 'date:2026-03-10T09:30:00+03:00',
    ]);
  });

  it('keywords are case-insensitive', () => {
    expect(kinds('and Or NOT in Is empty order by asc DESC')).toEqual([
      'kw:AND', 'kw:OR', 'kw:NOT', 'kw:IN', 'kw:IS', 'kw:EMPTY', 'kw:ORDER', 'kw:BY', 'kw:ASC', 'kw:DESC',
    ]);
  });

  it('Turkish synonyms map to the same tokens', () => {
    expect(kinds('ve VE veya VEYA değil DEĞİL deĞİl İçinde içinde İÇİNDE boş BOŞ bOş')).toEqual([
      'kw:AND', 'kw:AND', 'kw:OR', 'kw:OR', 'kw:NOT', 'kw:NOT', 'kw:NOT', 'kw:IN', 'kw:IN', 'kw:IN',
      'kw:EMPTY', 'kw:EMPTY', 'kw:EMPTY',
    ]);
    expect(keywordOf('in')).toBe('IN');
    expect(keywordOf('IN')).toBe('IN');
    expect(keywordOf('ıs')).toBe('IS');
    expect(keywordOf('status')).toBeNull();
    expect(keywordOf('constructor')).toBeNull();
    expect(keywordOf('__proto__')).toBeNull();
  });

  it('a dotted name starting with a keyword is a field, not a keyword', () => {
    expect(kinds('order.x in.y')).toEqual(['ident:order.x', 'ident:in.y']);
  });

  it('rejects non-ASCII identifiers', () => {
    const e = fail('  şirket = 1');
    expect(e.code).toBe('RQL_SYNTAX');
    expect(e.position).toBe(2);
  });

  it('rejects unterminated strings at the opening quote', () => {
    const e = fail('a = "abc');
    expect(e).toMatchObject({ code: 'RQL_SYNTAX', position: 4 });
    expect(e.message).toMatch(/unterminated/);
  });

  it('rejects invalid escapes at the backslash', () => {
    expect(fail(String.raw`a = "x\qy"`)).toMatchObject({ code: 'RQL_SYNTAX', position: 6 });
    expect(fail('a = "x\\')).toMatchObject({ code: 'RQL_SYNTAX' });
  });

  it('rejects NUL anywhere', () => {
    expect(fail('a = "x\u0000y"')).toMatchObject({ code: 'RQL_SYNTAX', position: 6 });
    expect(fail('\u0000')).toMatchObject({ code: 'RQL_SYNTAX', position: 0 });
  });

  it('rejects stray characters with their position', () => {
    expect(fail('a = 1 ; b')).toMatchObject({ code: 'RQL_SYNTAX', position: 6 });
    expect(fail('a ! b')).toMatchObject({ code: 'RQL_SYNTAX', position: 2 });
    expect(fail('a = +5')).toMatchObject({ code: 'RQL_SYNTAX', position: 4 });
    expect(fail('a = -')).toMatchObject({ code: 'RQL_SYNTAX', position: 4 });
    expect(fail('a = 12abc')).toMatchObject({ code: 'RQL_SYNTAX', position: 4 });
    expect(fail('a = 1.')).toMatchObject({ code: 'RQL_SYNTAX', position: 4 });
    expect(fail('a = ’x’')).toMatchObject({ code: 'RQL_SYNTAX', position: 4 });
    expect(fail('a = 1 /* c */')).toMatchObject({ code: 'RQL_SYNTAX', position: 6 });
  });

  it('always ends with eof', () => {
    const toks: Token[] = tokenize('');
    expect(toks).toEqual([{ type: 'eof', pos: 0, end: 0 }]);
  });
});
