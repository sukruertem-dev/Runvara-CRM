import type { BinaryOp, Node } from './ast';
import { FormulaError, MAX_DEPTH, MAX_NODES } from './errors';
import { tokenize, type Token } from './lexer';

/** name -> [minArgs, maxArgs] (Map: no prototype lookups). */
export const FUNCTIONS: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>([
  ['IF', [3, 3]],
  ['ROUND', [1, 2]],
  ['ABS', [1, 1]],
  ['MIN', [1, Infinity]],
  ['MAX', [1, Infinity]],
  ['COALESCE', [1, Infinity]],
  ['DAYS_BETWEEN', [2, 2]],
  ['TODAY', [0, 0]],
  ['CONCAT', [0, Infinity]],
  ['LEN', [1, 1]],
]);

const CMP: ReadonlyMap<string, BinaryOp> = new Map<string, BinaryOp>([
  ['=', 'eq'],
  ['!=', 'ne'],
  ['<', 'lt'],
  ['<=', 'le'],
  ['>', 'gt'],
  ['>=', 'ge'],
]);

class Parser {
  private idx = 0;
  private nodes = 0;
  private depth = 0;
  readonly refs: string[] = [];

  constructor(
    private readonly tokens: readonly Token[],
    private readonly knownRefs: ReadonlySet<string>,
  ) {}

  private peek(): Token {
    const t = this.tokens[this.idx] ?? this.tokens[this.tokens.length - 1];
    if (t === undefined) throw new FormulaError('FORMULA_SYNTAX', 'empty token stream', 0);
    return t;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.idx++;
    return t;
  }

  private isOp(text: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.text === text;
  }

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.text.toUpperCase() === word;
  }

  private mk(node: Node, pos: number): Node {
    this.nodes++;
    if (this.nodes > MAX_NODES) {
      throw new FormulaError('FORMULA_LIMIT', `formula has more than ${String(MAX_NODES)} nodes`, pos);
    }
    return node;
  }

  private enter(pos: number): void {
    this.depth++;
    if (this.depth > MAX_DEPTH) {
      throw new FormulaError('FORMULA_LIMIT', `nesting deeper than ${String(MAX_DEPTH)}`, pos);
    }
  }

  parseAll(): Node {
    const node = this.parseOr();
    const t = this.peek();
    if (t.type !== 'eof') throw new FormulaError('FORMULA_SYNTAX', `unexpected token '${t.text}'`, t.pos);
    return node;
  }

  private parseOr(): Node {
    this.enter(this.peek().pos);
    let left = this.parseAnd();
    while (this.isKeyword('OR')) {
      const pos = this.next().pos;
      const right = this.parseAnd();
      left = this.mk({ kind: 'bin', op: 'or', left, right }, pos);
    }
    this.depth--;
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isKeyword('AND')) {
      const pos = this.next().pos;
      const right = this.parseNot();
      left = this.mk({ kind: 'bin', op: 'and', left, right }, pos);
    }
    return left;
  }

  private parseNot(): Node {
    if (this.isKeyword('NOT')) {
      const pos = this.next().pos;
      this.enter(pos);
      const arg = this.parseNot();
      this.depth--;
      return this.mk({ kind: 'not', arg }, pos);
    }
    return this.parseCmp();
  }

  private parseCmp(): Node {
    let left = this.parseAdd();
    for (;;) {
      const t = this.peek();
      const op = t.type === 'op' ? CMP.get(t.text) : undefined;
      if (op === undefined) return left;
      this.next();
      const right = this.parseAdd();
      left = this.mk({ kind: 'bin', op, left, right }, t.pos);
    }
  }

  private parseAdd(): Node {
    let left = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || (t.text !== '+' && t.text !== '-')) return left;
      this.next();
      const right = this.parseMul();
      left = this.mk({ kind: 'bin', op: t.text === '+' ? 'add' : 'sub', left, right }, t.pos);
    }
  }

  private parseMul(): Node {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || (t.text !== '*' && t.text !== '/' && t.text !== '%')) return left;
      this.next();
      const right = this.parseUnary();
      const op: BinaryOp = t.text === '*' ? 'mul' : t.text === '/' ? 'div' : 'mod';
      left = this.mk({ kind: 'bin', op, left, right }, t.pos);
    }
  }

  private parseUnary(): Node {
    if (this.isOp('-')) {
      const pos = this.next().pos;
      this.enter(pos);
      const arg = this.parseUnary();
      this.depth--;
      return this.mk({ kind: 'neg', arg }, pos);
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return this.mk({ kind: 'num', value: t.num }, t.pos);
      case 'str':
        return this.mk({ kind: 'str', value: t.text }, t.pos);
      case 'ref':
        if (!this.knownRefs.has(t.text)) {
          throw new FormulaError('FORMULA_UNKNOWN_REF', `unknown reference '${t.text}'`, t.pos);
        }
        if (!this.refs.includes(t.text)) this.refs.push(t.text);
        return this.mk({ kind: 'ref', name: t.text }, t.pos);
      case 'op':
        if (t.text === '(') {
          const inner = this.parseOr();
          this.expectOp(')');
          return inner;
        }
        throw new FormulaError('FORMULA_SYNTAX', `unexpected token '${t.text}'`, t.pos);
      case 'ident':
        return this.parseIdent(t);
      case 'eof':
        throw new FormulaError('FORMULA_SYNTAX', 'unexpected end of formula', t.pos);
    }
  }

  private expectOp(text: string): void {
    const t = this.next();
    if (t.type !== 'op' || t.text !== text) {
      throw new FormulaError('FORMULA_SYNTAX', `expected '${text}'`, t.pos);
    }
  }

  private parseIdent(t: Token): Node {
    const upper = t.text.toUpperCase();
    if (upper === 'TRUE' || upper === 'FALSE') return this.mk({ kind: 'bool', value: upper === 'TRUE' }, t.pos);
    if (upper === 'NULL') return this.mk({ kind: 'null' }, t.pos);
    if (!this.isOp('(')) throw new FormulaError('FORMULA_SYNTAX', `unexpected identifier '${t.text}'`, t.pos);
    const arity = FUNCTIONS.get(upper);
    if (arity === undefined) throw new FormulaError('FORMULA_SYNTAX', `unknown function '${t.text}'`, t.pos);
    this.next();
    const args: Node[] = [];
    if (!this.isOp(')')) {
      for (;;) {
        args.push(this.parseOr());
        if (this.isOp(',')) {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(')');
    if (args.length < arity[0] || args.length > arity[1]) {
      throw new FormulaError('FORMULA_SYNTAX', `wrong number of arguments for ${upper}`, t.pos);
    }
    return this.mk({ kind: 'call', name: upper, args }, t.pos);
  }
}

export function parse(source: string, knownRefs: ReadonlySet<string>): { ast: Node; refs: string[] } {
  const parser = new Parser(tokenize(source), knownRefs);
  const ast = parser.parseAll();
  return { ast, refs: parser.refs };
}
