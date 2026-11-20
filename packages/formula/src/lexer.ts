import { FormulaError, MAX_SOURCE_LENGTH } from './errors';

export interface Token {
  readonly type: 'num' | 'str' | 'ref' | 'ident' | 'op' | 'eof';
  /** Raw text for ident/op, name inside braces for ref, decoded text for str. */
  readonly text: string;
  readonly num: number;
  readonly pos: number;
}

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isRefChar = (c: string): boolean => isIdentStart(c) || isDigit(c) || c === '.';

export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new FormulaError('FORMULA_LIMIT', `formula longer than ${String(MAX_SOURCE_LENGTH)} characters`, 0);
  }
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const start = i;
    if (isDigit(c)) {
      while (i < source.length && isDigit(source.charAt(i))) i++;
      if (source.charAt(i) === '.') {
        i++;
        if (!isDigit(source.charAt(i))) throw new FormulaError('FORMULA_SYNTAX', 'digits expected after decimal point', i);
        while (i < source.length && isDigit(source.charAt(i))) i++;
      }
      out.push({ type: 'num', text: source.slice(start, i), num: Number(source.slice(start, i)), pos: start });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < source.length && (isIdentStart(source.charAt(i)) || isDigit(source.charAt(i)))) i++;
      out.push({ type: 'ident', text: source.slice(start, i), num: 0, pos: start });
      continue;
    }
    if (c === '"') {
      i++;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const ch = source.charAt(i);
        if (ch === '\\') {
          const next = source.charAt(i + 1);
          if (next !== '"' && next !== '\\') throw new FormulaError('FORMULA_SYNTAX', 'invalid escape sequence', i);
          value += next;
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) throw new FormulaError('FORMULA_SYNTAX', 'unterminated string literal', start);
      out.push({ type: 'str', text: value, num: 0, pos: start });
      continue;
    }
    if (c === '{') {
      i++;
      const nameStart = i;
      while (i < source.length && isRefChar(source.charAt(i))) i++;
      if (i === nameStart) throw new FormulaError('FORMULA_SYNTAX', 'empty or invalid reference', start);
      if (source.charAt(i) !== '}') throw new FormulaError('FORMULA_SYNTAX', 'unterminated reference', start);
      out.push({ type: 'ref', text: source.slice(nameStart, i), num: 0, pos: start });
      i++;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === '!=' || two === '<=' || two === '>=') {
      out.push({ type: 'op', text: two, num: 0, pos: start });
      i += 2;
      continue;
    }
    if ('+-*/%=<>(),'.includes(c)) {
      out.push({ type: 'op', text: c, num: 0, pos: start });
      i++;
      continue;
    }
    throw new FormulaError('FORMULA_SYNTAX', `unexpected character '${c}'`, i);
  }
  out.push({ type: 'eof', text: '', num: 0, pos: source.length });
  return out;
}
