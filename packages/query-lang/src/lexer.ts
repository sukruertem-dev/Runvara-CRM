import type { RelUnit, RqlOp } from './ast';
import { RqlError } from './errors';

export type Keyword = 'AND' | 'OR' | 'NOT' | 'IN' | 'IS' | 'EMPTY' | 'ORDER' | 'BY' | 'ASC' | 'DESC';

export type Token =
  | { readonly type: 'ident'; readonly value: string; readonly pos: number; readonly end: number }
  | { readonly type: 'string'; readonly value: string; readonly pos: number; readonly end: number }
  | { readonly type: 'number'; readonly value: number; readonly pos: number; readonly end: number }
  | { readonly type: 'bool'; readonly value: boolean; readonly pos: number; readonly end: number }
  | { readonly type: 'date'; readonly value: string; readonly pos: number; readonly end: number }
  | { readonly type: 'rel'; readonly amount: number; readonly unit: RelUnit; readonly pos: number; readonly end: number }
  | { readonly type: 'op'; readonly value: RqlOp; readonly pos: number; readonly end: number }
  | { readonly type: 'kw'; readonly value: Keyword; readonly pos: number; readonly end: number }
  | { readonly type: '(' | ')' | ',' | 'eof'; readonly pos: number; readonly end: number };

const KEYWORDS: Readonly<Record<string, Keyword>> = Object.freeze({
  AND: 'AND',
  VE: 'AND',
  OR: 'OR',
  VEYA: 'OR',
  NOT: 'NOT',
  DEĞİL: 'NOT',
  DEĞIL: 'NOT',
  IN: 'IN',
  İÇİNDE: 'IN',
  IS: 'IS',
  EMPTY: 'EMPTY',
  BOŞ: 'EMPTY',
  ORDER: 'ORDER',
  BY: 'BY',
  ASC: 'ASC',
  DESC: 'DESC',
});

/** Case-insensitive keyword lookup that understands Turkish dotted/dotless I (`değil`, `İçinde`, `in`). */
export function keywordOf(word: string): Keyword | null {
  const candidates = [word.toUpperCase(), word.toLocaleUpperCase('tr-TR')];
  for (const candidate of candidates) {
    if (Object.hasOwn(KEYWORDS, candidate)) return KEYWORDS[candidate] ?? null;
  }
  return null;
}

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{N}_]/u;
const ASCII_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REL = /([+-])(\d+)([mhdwM])(?![\p{L}\p{N}_])/uy;
const DATETIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?(?![\p{L}\p{N}_])/uy;
const DATE = /\d{4}-\d{2}-\d{2}(?![\p{L}\p{N}_])/uy;
const NUMBER = /-?\d+(?:\.\d+)?(?![\p{L}\p{N}_.])/uy;

function matchAt(re: RegExp, input: string, index: number): RegExpExecArray | null {
  re.lastIndex = index;
  return re.exec(input);
}

function charAt(input: string, index: number): string {
  const cp = input.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function show(text: string): string {
  const printable = Array.from(text)
    .map((c) => (/\p{C}/u.test(c) ? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}` : c))
    .join('');
  return JSON.stringify(printable.length > 24 ? `${printable.slice(0, 24)}…` : printable);
}

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '\\': '\\',
  '"': '"',
  "'": "'",
  n: '\n',
  r: '\r',
  t: '\t',
});

function readString(input: string, start: number): Token {
  const quote = input.charAt(start);
  let out = '';
  let i = start + 1;
  while (i < input.length) {
    const c = input.charAt(i);
    if (c === quote) return { type: 'string', value: out, pos: start, end: i + 1 };
    if (c === '\\') {
      const next = input.charAt(i + 1);
      if (next === '' || !Object.hasOwn(ESCAPES, next)) {
        throw new RqlError('RQL_SYNTAX', `invalid escape sequence ${show(input.slice(i, i + 2))} in string`, i);
      }
      out += ESCAPES[next] ?? '';
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  throw new RqlError('RQL_SYNTAX', 'unterminated string literal', start);
}

function readWord(input: string, start: number): Token {
  let i = start;
  for (;;) {
    while (i < input.length && WORD_PART.test(charAt(input, i))) i += charAt(input, i).length;
    if (input.charAt(i) === '.' && WORD_START.test(charAt(input, i + 1))) {
      i += 1;
      continue;
    }
    break;
  }
  const text = input.slice(start, i);
  if (!text.includes('.')) {
    const kw = keywordOf(text);
    if (kw !== null) return { type: 'kw', value: kw, pos: start, end: i };
    const lower = text.toLowerCase();
    if (lower === 'true' || lower === 'false') return { type: 'bool', value: lower === 'true', pos: start, end: i };
  }
  if (!text.split('.').every((segment) => ASCII_IDENT.test(segment))) {
    const bad = Array.from(text).find((c) => !/[A-Za-z0-9_.]/.test(c)) ?? text;
    throw new RqlError('RQL_SYNTAX', `invalid character ${show(bad)} in identifier ${show(text)}`, start);
  }
  return { type: 'ident', value: text, pos: start, end: i };
}

function readNumeric(input: string, start: number): Token {
  const first = input.charAt(start);
  if (first === '+' || first === '-') {
    const rel = matchAt(REL, input, start);
    if (rel) {
      return {
        type: 'rel',
        amount: (rel[1] === '-' ? -1 : 1) * Number(rel[2]),
        unit: rel[3] as RelUnit,
        pos: start,
        end: start + rel[0].length,
      };
    }
    if (first === '+') {
      throw new RqlError('RQL_SYNTAX', 'unexpected character "+" (relative dates look like +7d, -2w, +3M)', start);
    }
  } else {
    const dt = matchAt(DATETIME, input, start) ?? matchAt(DATE, input, start);
    if (dt) return { type: 'date', value: dt[0], pos: start, end: start + dt[0].length };
  }
  const num = matchAt(NUMBER, input, start);
  if (num) return { type: 'number', value: Number(num[0]), pos: start, end: start + num[0].length };
  throw new RqlError('RQL_SYNTAX', 'invalid numeric literal', start);
}

export function tokenize(input: string): Token[] {
  const nul = input.indexOf('\u0000');
  if (nul >= 0) throw new RqlError('RQL_SYNTAX', 'NUL character is not allowed', nul);
  const tokens: Token[] = [];
  const n = input.length;
  let i = 0;
  while (i < n) {
    const c = input.charAt(i);
    if (/\s/u.test(c)) {
      i += 1;
      continue;
    }
    let tok: Token;
    if (c === '(' || c === ')' || c === ',') {
      tok = { type: c, pos: i, end: i + 1 };
    } else if (c === '=' || c === '~') {
      tok = { type: 'op', value: c, pos: i, end: i + 1 };
    } else if (c === '!') {
      if (input.charAt(i + 1) !== '=') {
        throw new RqlError('RQL_SYNTAX', 'unexpected character "!" (did you mean "!=" or NOT?)', i);
      }
      tok = { type: 'op', value: '!=', pos: i, end: i + 2 };
    } else if (c === '<' || c === '>') {
      tok =
        input.charAt(i + 1) === '='
          ? { type: 'op', value: c === '<' ? '<=' : '>=', pos: i, end: i + 2 }
          : { type: 'op', value: c, pos: i, end: i + 1 };
    } else if (c === '"' || c === "'") {
      tok = readString(input, i);
    } else if (c === '+' || c === '-' || (c >= '0' && c <= '9')) {
      tok = readNumeric(input, i);
    } else if (WORD_START.test(charAt(input, i))) {
      tok = readWord(input, i);
    } else {
      throw new RqlError('RQL_SYNTAX', `unexpected character ${show(charAt(input, i))}`, i);
    }
    tokens.push(tok);
    i = tok.end;
  }
  tokens.push({ type: 'eof', pos: n, end: n });
  return tokens;
}
