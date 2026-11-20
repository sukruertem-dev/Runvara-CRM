import {
  checkLimits,
  MAX_COMPARISONS,
  MAX_DEPTH,
  MAX_IN_VALUES,
  MAX_INPUT_LENGTH,
  MAX_ORDER_ITEMS,
  type Expr,
  type FuncName,
  type OrderItem,
  type Query,
  type RqlValue,
} from './ast';
import { RqlError } from './errors';
import { tokenize, type Keyword, type Token } from './lexer';

const FUNCTIONS: Readonly<Record<string, FuncName>> = Object.freeze({
  me: 'me',
  today: 'today',
  now: 'now',
  startofweek: 'startOfWeek',
  startofmonth: 'startOfMonth',
  myteams: 'myTeams',
  myqueues: 'myQueues',
});

// Binding powers: OR < AND < NOT (prefix).
const BP_OR = 1;
const BP_AND = 2;
const BP_NOT = 3;

class Parser {
  private index = 0;
  private comparisons = 0;
  private nesting = 0;

  constructor(
    private readonly input: string,
    private readonly tokens: readonly Token[],
  ) {}

  private peek(offset = 0): Token {
    const last = this.tokens.length - 1;
    const tok = this.tokens[Math.min(this.index + offset, last)];
    if (tok === undefined) throw new RqlError('RQL_SYNTAX', 'empty token stream', 0);
    return tok;
  }

  private next(): Token {
    const tok = this.peek();
    if (tok.type !== 'eof') this.index += 1;
    return tok;
  }

  private describe(tok: Token): string {
    if (tok.type === 'eof') return 'end of input';
    const text = this.input.slice(tok.pos, tok.end);
    return JSON.stringify(text.length > 24 ? `${text.slice(0, 24)}…` : text);
  }

  private isKw(tok: Token, kw: Keyword): boolean {
    return tok.type === 'kw' && tok.value === kw;
  }

  private expectKw(kw: Keyword): Token {
    const tok = this.peek();
    if (!this.isKw(tok, kw)) {
      throw new RqlError('RQL_SYNTAX', `expected ${kw} but found ${this.describe(tok)}`, tok.pos);
    }
    return this.next();
  }

  private expectPunct(type: '(' | ')'): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new RqlError('RQL_SYNTAX', `expected "${type}" but found ${this.describe(tok)}`, tok.pos);
    }
    return this.next();
  }

  parseQuery(): Query {
    let where: Expr | null = null;
    const first = this.peek();
    if (first.type !== 'eof' && !this.isKw(first, 'ORDER')) where = this.parseExpr(0);
    const orderBy: OrderItem[] = [];
    if (this.isKw(this.peek(), 'ORDER')) {
      this.next();
      this.expectKw('BY');
      for (;;) {
        orderBy.push(this.parseOrderItem());
        if (this.peek().type !== ',') break;
        this.next();
        if (orderBy.length >= MAX_ORDER_ITEMS) {
          throw new RqlError('LIMIT_EXCEEDED', `ORDER BY has more than ${MAX_ORDER_ITEMS} fields`, this.peek().pos);
        }
      }
    }
    const rest = this.peek();
    if (rest.type !== 'eof') {
      throw new RqlError('RQL_SYNTAX', `unexpected ${this.describe(rest)}`, rest.pos);
    }
    if (where !== null) checkLimits(where);
    return { where, orderBy };
  }

  private parseOrderItem(): OrderItem {
    const tok = this.peek();
    if (tok.type !== 'ident') {
      throw new RqlError('RQL_SYNTAX', `expected a field name in ORDER BY but found ${this.describe(tok)}`, tok.pos);
    }
    this.next();
    let direction: 'asc' | 'desc' = 'asc';
    const dir = this.peek();
    if (this.isKw(dir, 'ASC')) this.next();
    else if (this.isKw(dir, 'DESC')) {
      this.next();
      direction = 'desc';
    }
    return { field: tok.value, fieldPos: tok.pos, direction };
  }

  private enter(pos: number): void {
    this.nesting += 1;
    if (this.nesting > MAX_DEPTH) {
      throw new RqlError('LIMIT_EXCEEDED', `query nesting is deeper than ${MAX_DEPTH} levels`, pos);
    }
  }

  private parseExpr(minBp: number): Expr {
    let left = this.parsePrefix();
    let built: 'and' | 'or' | null = null;
    let items: Expr[] = [];
    let groupPos = 0;
    for (;;) {
      const tok = this.peek();
      let kind: 'and' | 'or';
      let bp: number;
      if (this.isKw(tok, 'OR')) {
        kind = 'or';
        bp = BP_OR;
      } else if (this.isKw(tok, 'AND')) {
        kind = 'and';
        bp = BP_AND;
      } else break;
      if (bp < minBp) break;
      this.next();
      const right = this.parseExpr(bp + 1);
      if (built === kind) {
        items.push(right);
      } else {
        groupPos = left.pos;
        items = [left, right];
        built = kind;
      }
      left = { kind, items, pos: groupPos };
    }
    return left;
  }

  private parsePrefix(): Expr {
    const tok = this.peek();
    if (this.isKw(tok, 'NOT')) {
      this.enter(tok.pos);
      this.next();
      const expr = this.parseExpr(BP_NOT);
      this.nesting -= 1;
      return { kind: 'not', expr, pos: tok.pos };
    }
    if (tok.type === '(') {
      this.enter(tok.pos);
      this.next();
      const expr = this.parseExpr(0);
      this.expectPunct(')');
      this.nesting -= 1;
      return expr;
    }
    if (tok.type === 'ident') return this.parseComparison();
    throw new RqlError('RQL_SYNTAX', `expected a field name, "(" or NOT but found ${this.describe(tok)}`, tok.pos);
  }

  private countComparison(pos: number): void {
    this.comparisons += 1;
    if (this.comparisons > MAX_COMPARISONS) {
      throw new RqlError('LIMIT_EXCEEDED', `query has more than ${MAX_COMPARISONS} comparisons`, pos);
    }
  }

  private parseComparison(): Expr {
    const fieldTok = this.next();
    if (fieldTok.type !== 'ident') throw new RqlError('RQL_SYNTAX', 'expected a field name', fieldTok.pos);
    const field = fieldTok.value;
    const fieldPos = fieldTok.pos;
    this.countComparison(fieldPos);
    const tok = this.peek();

    if (tok.type === 'op') {
      this.next();
      if (tok.value === '~') {
        const str = this.peek();
        if (str.type !== 'string') {
          throw new RqlError('RQL_SYNTAX', `expected a quoted string after "~" but found ${this.describe(str)}`, str.pos);
        }
        this.next();
        return {
          kind: 'cmp',
          field,
          fieldPos,
          op: '~',
          opPos: tok.pos,
          value: { kind: 'string', value: str.value, pos: str.pos },
          pos: fieldPos,
        };
      }
      const value = this.parseValue();
      return { kind: 'cmp', field, fieldPos, op: tok.value, opPos: tok.pos, value, pos: fieldPos };
    }

    if (this.isKw(tok, 'IN')) {
      this.next();
      return this.parseIn(field, fieldPos, false);
    }
    if (this.isKw(tok, 'NOT') && this.isKw(this.peek(1), 'IN')) {
      this.next();
      this.next();
      return this.parseIn(field, fieldPos, true);
    }

    // `field IS [NOT] EMPTY`; the IS is optional in `field EMPTY` / `field NOT EMPTY` (Turkish: `alan DEĞİL BOŞ`).
    if (this.isKw(tok, 'IS') || this.isKw(tok, 'EMPTY') || (this.isKw(tok, 'NOT') && this.isKw(this.peek(1), 'EMPTY'))) {
      if (this.isKw(tok, 'IS')) this.next();
      let negated = false;
      if (this.isKw(this.peek(), 'NOT')) {
        this.next();
        negated = true;
      }
      this.expectKw('EMPTY');
      return { kind: 'empty', field, fieldPos, negated, pos: fieldPos };
    }

    throw new RqlError(
      'RQL_SYNTAX',
      `expected an operator (=, !=, <, <=, >, >=, ~, IN, IS EMPTY) after field "${field}" but found ${this.describe(tok)}`,
      tok.pos,
    );
  }

  private parseIn(field: string, fieldPos: number, negated: boolean): Expr {
    this.expectPunct('(');
    const values: RqlValue[] = [this.parseValue()];
    while (this.peek().type === ',') {
      this.next();
      if (values.length >= MAX_IN_VALUES) {
        throw new RqlError('LIMIT_EXCEEDED', `IN list has more than ${MAX_IN_VALUES} values`, this.peek().pos);
      }
      values.push(this.parseValue());
    }
    this.expectPunct(')');
    return { kind: 'in', field, fieldPos, negated, values, pos: fieldPos };
  }

  private parseValue(): RqlValue {
    const tok = this.peek();
    switch (tok.type) {
      case 'string':
        this.next();
        return { kind: 'string', value: tok.value, pos: tok.pos };
      case 'number':
        this.next();
        return { kind: 'number', value: tok.value, pos: tok.pos };
      case 'bool':
        this.next();
        return { kind: 'bool', value: tok.value, pos: tok.pos };
      case 'date':
        this.next();
        return { kind: 'date', value: tok.value, hasTime: tok.value.includes('T'), pos: tok.pos };
      case 'rel':
        this.next();
        return { kind: 'rel', amount: tok.amount, unit: tok.unit, pos: tok.pos };
      case 'ident': {
        this.next();
        if (tok.value.includes('.')) {
          throw new RqlError('RQL_SYNTAX', `expected a value but found field-like name "${tok.value}" (quote text values)`, tok.pos);
        }
        if (this.peek().type === '(') {
          const lower = tok.value.toLowerCase();
          const name = Object.hasOwn(FUNCTIONS, lower) ? FUNCTIONS[lower] : undefined;
          if (name === undefined) throw new RqlError('RQL_SYNTAX', `unknown function "${tok.value}"`, tok.pos);
          this.next();
          this.expectPunct(')');
          return { kind: 'func', name, pos: tok.pos };
        }
        return { kind: 'word', value: tok.value, pos: tok.pos };
      }
      default:
        throw new RqlError('RQL_SYNTAX', `expected a value but found ${this.describe(tok)}`, tok.pos);
    }
  }
}

/** Parses RQL text into an AST. Throws only {@link RqlError}. */
export function parse(input: string): Query {
  if (typeof (input as unknown) !== 'string') throw new RqlError('RQL_SYNTAX', 'query must be a string', 0);
  if (input.length > MAX_INPUT_LENGTH) {
    throw new RqlError('LIMIT_EXCEEDED', `query is longer than ${MAX_INPUT_LENGTH} characters`, MAX_INPUT_LENGTH);
  }
  return new Parser(input, tokenize(input)).parseQuery();
}
