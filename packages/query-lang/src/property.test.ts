import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compile, compileQuery, type CompileContext, type FieldRegistry } from './compile';
import { RqlError } from './errors';
import { parse } from './parser';

const NUM_RUNS = 600;
const dialect = new PgDialect();

const registry: FieldRegistry = {
  title: { sql: sql`t.title`, type: 'text', sortable: true },
  'custom.cf_x': { sql: sql`t.custom->>'cf_x'`, type: 'text', sortable: true },
  budget: { sql: sql`t.budget`, type: 'number', sortable: true },
  due: { sql: sql`t.due_on`, type: 'date', sortable: true },
  status: { sql: sql`t.status`, type: 'enum', enumValues: ['open', 'done'], sortable: false },
};
const ctx: CompileContext = {
  userId: '11111111-1111-4111-8111-111111111111',
  timezone: 'Europe/Istanbul',
  now: new Date('2026-03-10T10:30:00Z'),
};

const CORPUS = [
  "' OR 1=1 --",
  "'; DROP TABLE tasks; --",
  '"; DROP TABLE tasks; --',
  '$1',
  '$1; SELECT pg_sleep(10)',
  '\\',
  '\\\\"',
  "\\' OR '1'='1",
  '/* c */ UNION SELECT password FROM users',
  '’ OR ’1’=’1',
  '＇ OR 1=1 --',
  '%_%',
  '\n--\r\n',
  '${sql}',
];

const noNul = (s: string): boolean => !s.includes('\u0000');
const valueArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.string({ unit: 'binary', maxLength: 40 }),
    fc.string({ unit: 'grapheme', maxLength: 40 }),
    fc.string({ maxLength: 40 }),
    fc.constantFrom(...CORPUS),
    fc.tuple(fc.constantFrom(...CORPUS), fc.string({ maxLength: 8 })).map(([a, b]) => a + b),
  )
  .filter(noNul);

const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const likeEscape = (v: string): string => v.replace(/[\\%_]/g, (c) => `\\${c}`);

// ---- (a) parse never throws anything but RqlError -------------------------------------------------------------

const TOKENS = [
  'a', 'title', 'status', 'custom.cf_x', 'budget', 'due', '=', '!=', '<', '<=', '>', '>=', '~', '(', ')', ',',
  'AND', 'OR', 'NOT', 'IN', 'IS', 'EMPTY', 'ORDER', 'BY', 'ASC', 'DESC', 've', 'VEYA', 'değil', 'İÇİNDE', 'BOŞ',
  '"x"', "'y'", '"', "'", '\\', '1', '-1.5', '+7d', '-2w', '3M', '2026-03-10', '2026-03-10T09:00', 'true', 'me()', 'today()', 'foo()',
  ' ', ' ', ' ', '.', ';', '--', '$1', '’', 'ş',
];
const soupArb = fc.array(fc.constantFrom(...TOKENS), { maxLength: 24 }).map((xs) => xs.join(' '));

function outcome(fn: () => unknown): 'ok' | RqlError {
  try {
    fn();
    return 'ok';
  } catch (e) {
    if (e instanceof RqlError) return e;
    throw e;
  }
}

describe('property (a): parse/compile only ever throw RqlError', () => {
  it('arbitrary unicode strings', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary', maxLength: 200 }), fc.string({ unit: 'grapheme', maxLength: 200 }), fc.string({ maxLength: 200 })), (s) => {
        const r = outcome(() => parse(s));
        if (r !== 'ok') {
          expect(Number.isInteger(r.position)).toBe(true);
          expect(r.position).toBeGreaterThanOrEqual(0);
          expect(r.position).toBeLessThanOrEqual(Math.max(s.length, 4096));
          expect(r.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 1500 },
    );
  });

  it('token soup (reaches deep parser states) through parse and compile', () => {
    fc.assert(
      fc.property(soupArb, (s) => {
        const r = outcome(() => compileQuery(s, registry, ctx));
        if (r !== 'ok') expect(['RQL_SYNTAX', 'UNKNOWN_FIELD', 'BAD_OPERATOR', 'BAD_VALUE', 'LIMIT_EXCEEDED']).toContain(r.code);
      }),
      { numRuns: 3000 },
    );
  });

  it('very long and deeply nested inputs fail cleanly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.constantFrom('(', 'NOT ', 'a = 1 AND ', 'x IN ('), (n, unit) => {
        outcome(() => parse(unit.repeat(n)));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---- (b) SQL text is value-independent; values live in params --------------------------------------------------

type Leaf =
  | { k: 'text'; field: 'title' | 'custom.cf_x'; op: '=' | '!=' | '~'; v: string }
  | { k: 'in'; field: 'title' | 'custom.cf_x'; negated: boolean; vs: string[] }
  | { k: 'num'; op: '=' | '!=' | '<' | '<=' | '>' | '>='; n: number }
  | { k: 'date'; op: '=' | '<' | '>='; amount: number; unit: 'd' | 'w' | 'M' | 'h' }
  | { k: 'empty'; field: 'title' | 'custom.cf_x' | 'budget' | 'due'; negated: boolean };
type Node = Leaf | { k: 'and' | 'or'; items: Node[] } | { k: 'not'; e: Node };

const leafArb: fc.Arbitrary<Leaf> = fc.oneof(
  fc.record({ k: fc.constant('text' as const), field: fc.constantFrom('title' as const, 'custom.cf_x' as const), op: fc.constantFrom('=' as const, '!=' as const, '~' as const), v: valueArb }),
  fc.record({ k: fc.constant('in' as const), field: fc.constantFrom('title' as const, 'custom.cf_x' as const), negated: fc.boolean(), vs: fc.array(valueArb, { minLength: 1, maxLength: 4 }) }),
  fc.record({ k: fc.constant('num' as const), op: fc.constantFrom('=' as const, '!=' as const, '<' as const, '<=' as const, '>' as const, '>=' as const), n: fc.integer({ min: -1_000_000, max: 1_000_000 }) }),
  fc.record({ k: fc.constant('date' as const), op: fc.constantFrom('=' as const, '<' as const, '>=' as const), amount: fc.integer({ min: -400, max: 400 }), unit: fc.constantFrom('d' as const, 'w' as const, 'M' as const, 'h' as const) }),
  fc.record({ k: fc.constant('empty' as const), field: fc.constantFrom('title' as const, 'custom.cf_x' as const, 'budget' as const, 'due' as const), negated: fc.boolean() }),
);

const nodeArb: fc.Arbitrary<Node> = fc.letrec<{ node: Node }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3, depthSize: 'small' },
    leafArb,
    fc.record({ k: fc.constantFrom('and' as const, 'or' as const), items: fc.array(tie('node'), { minLength: 2, maxLength: 3 }) }),
    fc.record({ k: fc.constant('not' as const), e: tie('node') }),
  ),
})).node;

interface Rendered {
  query: string;
  params: unknown[];
}

/** Renders a tree; `mask` replaces every user value with a constant so only structure remains. */
function render(node: Node, mask: boolean): Rendered {
  switch (node.k) {
    case 'text': {
      const v = mask ? 'x' : node.v;
      return { query: `${node.field} ${node.op} ${quote(v)}`, params: [node.op === '~' ? `%${likeEscape(v)}%` : v] };
    }
    case 'in': {
      const vs = mask ? node.vs.map(() => 'x') : node.vs;
      return { query: `${node.field} ${node.negated ? 'NOT ' : ''}IN (${vs.map(quote).join(', ')})`, params: vs };
    }
    case 'num': {
      const n = mask ? 1 : node.n;
      return { query: `budget ${node.op} ${n}`, params: [n] };
    }
    case 'date': {
      const amount = mask ? 1 : node.amount;
      return { query: `due ${node.op} ${amount < 0 ? '-' : '+'}${Math.abs(amount)}${node.unit}`, params: [] };
    }
    case 'empty':
      return { query: `${node.field} IS ${node.negated ? 'NOT ' : ''}EMPTY`, params: [] };
    case 'and':
    case 'or': {
      const parts = node.items.map((i) => render(i, mask));
      return {
        query: `(${parts.map((p) => p.query).join(node.k === 'and' ? ' AND ' : ' OR ')})`,
        params: parts.flatMap((p) => p.params),
      };
    }
    case 'not': {
      const inner = render(node.e, mask);
      return { query: `NOT (${inner.query})`, params: inner.params };
    }
  }
}

function sqlOf(query: string): { text: string; params: unknown[] } {
  const { where } = compileQuery(query, registry, ctx);
  if (where === null) throw new Error('missing where');
  const q = dialect.sqlToQuery(where);
  return { text: q.sql, params: q.params };
}

describe('property (b): compiled SQL text is value-independent and values are parameters', () => {
  it('generated valid queries', () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const real = render(node, false);
        const masked = render(node, true);
        const a = sqlOf(real.query);
        const b = sqlOf(masked.query);
        // the SQL text does not depend on any user value ...
        expect(a.text).toBe(b.text);
        // ... every text/number value is in params, in order (date queries add computed date params of their own)
        const userParams = a.params.filter((p) => !(typeof p === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p) && !real.params.includes(p)));
        expect(userParams).toEqual(real.params);
        // placeholders and params agree
        const placeholders = a.text.match(/\$\d+/g) ?? [];
        expect(placeholders).toHaveLength(a.params.length);
        // known-dangerous generated payloads never leak into the text
        for (const p of CORPUS) if (p.length > 3) expect(a.text).not.toContain(p);
        // nothing user-supplied can introduce statements or comments
        expect(a.text).not.toMatch(/;|--|\/\*/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('any text value round-trips through the lexer unchanged (escape fidelity)', () => {
    fc.assert(
      fc.property(valueArb, fc.constantFrom('"', "'"), (v, q) => {
        const lit = q === '"' ? quote(v) : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
        const r = sqlOf(`title = ${lit}`);
        expect(r.text).toBe('(t.title) = $1');
        expect(r.params).toEqual([v]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('enum / number fields given arbitrary text values either compile to params or throw RqlError', () => {
    fc.assert(
      fc.property(valueArb, fc.constantFrom('status', 'budget', 'due'), (v, field) => {
        const r = outcome(() => sqlOf(`${field} = ${quote(v)}`));
        if (r !== 'ok') expect(['BAD_VALUE', 'RQL_SYNTAX']).toContain(r.code);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('generated trees stay within limits for compile() on parsed ASTs', () => {
    fc.assert(
      fc.property(nodeArb, (node) => {
        const q = parse(render(node, false).query);
        const r = outcome(() => compile(q, registry, ctx));
        expect(r).toBe('ok');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---- (c) injection corpus in value and field positions ---------------------------------------------------------

describe('property (c): injection payloads in field and value positions', () => {
  const FORBIDDEN = /;|\/\*|--/;

  it('arbitrary text in field position: UNKNOWN_FIELD / RQL_SYNTAX / … or a clean registry-only query', () => {
    fc.assert(
      fc.property(fc.oneof(valueArb, fc.string({ maxLength: 30 }), fc.constantFrom(...CORPUS)), fc.constantFrom('', 'ORDER BY '), (s, prefix) => {
        const q = prefix === '' ? `${s} = 1` : `${prefix}${s}`;
        let result: { text: string } | null = null;
        const r = outcome(() => {
          const { where, orderBy } = compileQuery(q, registry, ctx);
          const parts = [where, ...orderBy].filter((x) => x !== null).map((x) => dialect.sqlToQuery(x).sql);
          result = { text: parts.join(' ') };
        });
        if (r !== 'ok') {
          expect(['UNKNOWN_FIELD', 'RQL_SYNTAX', 'BAD_VALUE', 'BAD_OPERATOR', 'LIMIT_EXCEEDED']).toContain(r.code);
        } else {
          const text = (result as { text: string } | null)?.text ?? '';
          expect(text).not.toMatch(FORBIDDEN);
          for (const p of CORPUS) if (p.length > 3) expect(text).not.toContain(p);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('a field-position token that is not a registry key and not valid syntax is UNKNOWN_FIELD or RQL_SYNTAX', () => {
    const identArb = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,12}(\.[A-Za-z_][A-Za-z0-9_]{0,8}){0,2}$/);
    fc.assert(
      fc.property(identArb, (name) => {
        const r = outcome(() => compileQuery(`${name} = 1`, registry, ctx));
        if (Object.hasOwn(registry, name)) return;
        if (r === 'ok') {
          // only possible when the name is a keyword/boolean, which cannot parse as a field either; so must not be ok
          throw new Error(`"${name}" compiled`);
        }
        expect(['UNKNOWN_FIELD', 'RQL_SYNTAX']).toContain(r.code);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it.each(CORPUS)('corpus payload %j, quoted in each value position, is only ever a parameter', (payload) => {
    for (const lit of [quote(payload), `'${payload.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`]) {
      for (const q of [`title = ${lit}`, `title != ${lit}`, `title ~ ${lit}`, `title IN (${lit})`, `custom.cf_x NOT IN (${lit}, ${lit})`]) {
        const { text, params } = sqlOf(q);
        expect(text).not.toMatch(/;|--|\/\*/);
        if (payload.length > 3) expect(text).not.toContain(payload);
        expect(params.length).toBeGreaterThan(0);
        expect(params.every((p) => typeof p === 'string' && p.includes(q.includes('~') ? likeEscape(payload) : payload))).toBe(true);
      }
    }
  });

  it.each(CORPUS)('corpus payload %j unquoted or in field position never compiles into SQL', (payload) => {
    for (const q of [`title = ${payload}`, `${payload} = 1`, `title = 1 AND ${payload}`, `ORDER BY ${payload}`, `title IN (${payload})`]) {
      const r = outcome(() => compileQuery(q, registry, ctx));
      expect(r).not.toBe('ok');
    }
  });
});
