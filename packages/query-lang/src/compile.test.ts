import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { compile, compileQuery, type CompileContext, type FieldRegistry } from './compile';
import { RqlError, type RqlErrorCode } from './errors';
import { parse } from './parser';

const USER = '11111111-1111-4111-8111-111111111111';
const TEAM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEAM_B = 'BBBBBBBB-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUEUE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const registry: FieldRegistry = {
  status: { sql: sql`t.status`, type: 'enum', enumValues: ['open', 'in_progress', 'done'], sortable: true },
  title: { sql: sql`t.title`, type: 'text', sortable: true },
  required: { sql: sql`t.required`, type: 'text', sortable: false, nullable: false },
  budget: { sql: sql`(t.custom->>'cf_budget')::numeric`, type: 'number', sortable: true },
  due: { sql: sql`t.due_on`, type: 'date', sortable: true },
  created: { sql: sql`t.created_at`, type: 'datetime', sortable: true },
  flag: { sql: sql`t.flag`, type: 'bool', sortable: false },
  owner: { sql: sql`t.owner_user_id`, type: 'user', sortable: false },
  ref: { sql: sql`t.ref_id`, type: 'uuid', sortable: false },
  'custom.cf_x': { sql: sql`t.custom->>'cf_x'`, type: 'text', sortable: true },
};

const dialect = new PgDialect();
const baseCtx: CompileContext = {
  userId: USER,
  timezone: 'Europe/Istanbul',
  now: new Date('2026-03-10T10:30:00Z'), // 13:30 in Istanbul, 06:30 EDT in New York
  teamIds: [TEAM_A, TEAM_B],
  queueIds: [QUEUE],
};

function run(input: string, ctx: CompileContext = baseCtx, reg: FieldRegistry = registry): { text: string; params: unknown[] } {
  const { where } = compileQuery(input, reg, ctx);
  if (where === null) throw new Error('no where');
  const q = dialect.sqlToQuery(where);
  return { text: q.sql, params: q.params };
}

function fail(input: string, ctx: CompileContext = baseCtx): RqlError {
  try {
    compileQuery(input, registry, ctx);
  } catch (e) {
    if (e instanceof RqlError) return e;
    throw e;
  }
  throw new Error(`expected "${input}" to fail`);
}

function expectError(input: string, code: RqlErrorCode, position: number, ctx: CompileContext = baseCtx): RqlError {
  const e = fail(input, ctx);
  expect(e.code).toBe(code);
  expect(e.position).toBe(position);
  return e;
}

describe('compile: exact SQL for representative queries', () => {
  it('enum equality / inequality', () => {
    expect(run('status = open')).toEqual({ text: '(t.status) = $1', params: ['open'] });
    expect(run('status = "in_progress"')).toEqual({ text: '(t.status) = $1', params: ['in_progress'] });
    expect(run('status != done')).toEqual({ text: '((t.status) <> $1 OR (t.status) IS NULL)', params: ['done'] });
  });

  it('AND / OR / NOT nesting and precedence', () => {
    expect(run('status = open OR status = done AND title = "x"')).toEqual({
      text: '((t.status) = $1 OR ((t.status) = $2 AND (t.title) = $3))',
      params: ['open', 'done', 'x'],
    });
    expect(run('NOT status = open')).toEqual({ text: 'NOT ((t.status) = $1)', params: ['open'] });
    expect(run('(status = open OR status = done) VE DEĞİL title = "x"')).toEqual({
      text: '(((t.status) = $1 OR (t.status) = $2) AND NOT ((t.title) = $3))',
      params: ['open', 'done', 'x'],
    });
  });

  it('numbers', () => {
    expect(run('budget >= 10.5')).toEqual({ text: "((t.custom->>'cf_budget')::numeric) >= $1", params: [10.5] });
    expect(run('budget < -3').params).toEqual([-3]);
    expect(run('budget != 0').text).toBe("(((t.custom->>'cf_budget')::numeric) <> $1 OR ((t.custom->>'cf_budget')::numeric) IS NULL)");
    for (const op of ['=', '<', '<=', '>', '>=']) expect(run(`budget ${op} 1`).text).toContain(` ${op} $1`);
  });

  it('text: =, !=, ~ with LIKE escaping', () => {
    expect(run('title = "a b"')).toEqual({ text: '(t.title) = $1', params: ['a b'] });
    expect(run("title != 'a'")).toEqual({ text: '((t.title) <> $1 OR (t.title) IS NULL)', params: ['a'] });
    expect(run('title ~ "foo"')).toEqual({ text: "(t.title) ILIKE $1 ESCAPE '\\'", params: ['%foo%'] });
    expect(run(String.raw`title ~ "100%_\\x"`).params).toEqual([String.raw`%100\%\_\\x%`]);
    expect(run('custom.cf_x ~ "q"')).toEqual({ text: "(t.custom->>'cf_x') ILIKE $1 ESCAPE '\\'", params: ['%q%'] });
  });

  it('bool', () => {
    expect(run('flag = true')).toEqual({ text: '(t.flag) = $1', params: [true] });
    expect(run('flag != false').params).toEqual([false]);
  });

  it('IN and NOT IN', () => {
    expect(run('status IN (open, done)')).toEqual({ text: '(t.status) IN ($1, $2)', params: ['open', 'done'] });
    expect(run('status NOT IN (open)')).toEqual({ text: '((t.status) NOT IN ($1) OR (t.status) IS NULL)', params: ['open'] });
    expect(run('title İÇİNDE ("a", "b")').params).toEqual(['a', 'b']);
    expect(run('budget IN (1, 2, 3)').text).toBe("((t.custom->>'cf_budget')::numeric) IN ($1, $2, $3)");
    expect(run('due IN (2026-03-10, +1d)')).toEqual({
      text: '(t.due_on)::date IN ($1::date, $2::date)',
      params: ['2026-03-10', '2026-03-11'],
    });
  });

  it('IS EMPTY / IS NOT EMPTY', () => {
    expect(run('title IS EMPTY').text).toBe("((t.title) IS NULL OR (t.title) = '')");
    expect(run('title IS NOT EMPTY').text).toBe("((t.title) IS NOT NULL AND (t.title) <> '')");
    expect(run('title DEĞİL BOŞ').text).toBe("((t.title) IS NOT NULL AND (t.title) <> '')");
    expect(run('owner IS EMPTY')).toEqual({ text: '(t.owner_user_id) IS NULL', params: [] });
    expect(run('budget IS NOT EMPTY').text).toBe("((t.custom->>'cf_budget')::numeric) IS NOT NULL");
    expect(run('due IS EMPTY').text).toBe('(t.due_on) IS NULL');
  });

  it('ORDER BY', () => {
    const { where, orderBy } = compileQuery('ORDER BY title DESC, budget, custom.cf_x ASC', registry, baseCtx);
    expect(where).toBeNull();
    expect(orderBy.map((o) => dialect.sqlToQuery(o).sql)).toEqual([
      '(t.title) DESC NULLS LAST',
      "((t.custom->>'cf_budget')::numeric) ASC NULLS LAST",
      "(t.custom->>'cf_x') ASC NULLS LAST",
    ]);
  });

  it('empty / whitespace query', () => {
    expect(compileQuery('', registry, baseCtx)).toEqual({ where: null, orderBy: [] });
    expect(compileQuery('  \n ', registry, baseCtx)).toEqual({ where: null, orderBy: [] });
    expect(compile({ where: null, orderBy: [] }, registry, baseCtx)).toEqual({ where: null, orderBy: [] });
  });
});

describe('compile: user, uuid, teams, queues', () => {
  it('me() and bare me resolve to ctx.userId (lower-cased)', () => {
    expect(run('owner = me()')).toEqual({ text: '(t.owner_user_id) = $1', params: [USER] });
    expect(run('owner = me')).toEqual({ text: '(t.owner_user_id) = $1', params: [USER] });
    expect(run('owner != ME()').text).toBe('((t.owner_user_id) <> $1 OR (t.owner_user_id) IS NULL)');
    expect(run('ref = me()').params).toEqual([USER]);
    expect(run('owner IN (me(), "22222222-2222-4222-8222-222222222222")').params).toEqual([USER, '22222222-2222-4222-8222-222222222222']);
    expect(run('owner = me()', { ...baseCtx, userId: USER.toUpperCase() }).params).toEqual([USER]);
  });

  it('UUID literal values are validated and lower-cased', () => {
    expect(run(`ref = "${TEAM_B}"`).params).toEqual([TEAM_B.toLowerCase()]);
    expectError('ref = "nope"', 'BAD_VALUE', 6);
    expectError('ref = 5', 'BAD_VALUE', 6);
    expectError('owner = "1; DROP TABLE x"', 'BAD_VALUE', 8);
    expectError('owner = me()', 'BAD_VALUE', 8, { ...baseCtx, userId: 'not-a-uuid' });
  });

  it('myTeams() / myQueues() expand to IN lists of UUID params', () => {
    expect(run('owner = myTeams()')).toEqual({
      text: '(t.owner_user_id) IN ($1, $2)',
      params: [TEAM_A, TEAM_B.toLowerCase()],
    });
    expect(run('ref = myQueues()')).toEqual({ text: '(t.ref_id) IN ($1)', params: [QUEUE] });
    expect(run('ref != myQueues()').text).toBe('((t.ref_id) NOT IN ($1) OR (t.ref_id) IS NULL)');
  });

  it('missing teamIds / queueIds match nothing', () => {
    const bare: CompileContext = { userId: USER, timezone: 'UTC', now: baseCtx.now };
    expect(run('ref = myTeams()', bare)).toEqual({ text: 'FALSE', params: [] });
    expect(run('ref = myQueues()', { ...bare, queueIds: [] })).toEqual({ text: 'FALSE', params: [] });
    expect(run('ref != myTeams()', bare).text).toBe('TRUE');
  });

  it('myTeams() misuse', () => {
    expectError('budget = myTeams()', 'BAD_VALUE', 9);
    expectError('title = myTeams()', 'BAD_VALUE', 8);
    expectError('owner IN (myTeams())', 'BAD_VALUE', 10);
    expectError('owner = myTeams()', 'BAD_VALUE', 8, { ...baseCtx, teamIds: ['x'] });
    expectError('owner = myTeams()', 'LIMIT_EXCEEDED', 8, { ...baseCtx, teamIds: Array.from({ length: 501 }, () => TEAM_A) });
  });

  it('<, > are not allowed on uuid/user', () => {
    expectError('owner < me()', 'BAD_OPERATOR', 6);
    expectError('ref >= me()', 'BAD_OPERATOR', 4);
  });
});

describe('compile: operators per type', () => {
  it('text allows only = != ~', () => {
    for (const op of ['<', '<=', '>', '>=']) expectError(`title ${op} "a"`, 'BAD_OPERATOR', 6);
  });
  it('bool, enum allow only = !=', () => {
    expectError('flag < true', 'BAD_OPERATOR', 5);
    expectError('flag ~ "t"', 'BAD_OPERATOR', 5);
    expectError('status > open', 'BAD_OPERATOR', 7);
    expectError('status ~ "op"', 'BAD_OPERATOR', 7);
  });
  it('number / date / datetime reject ~', () => {
    expectError('budget ~ "1"', 'BAD_OPERATOR', 7);
    expectError('due ~ "1"', 'BAD_OPERATOR', 4);
    expectError('created ~ "1"', 'BAD_OPERATOR', 8);
  });
  it('IN is not allowed on bool / datetime', () => {
    expectError('flag IN (true)', 'BAD_OPERATOR', 0);
    expectError('created IN (+1d)', 'BAD_OPERATOR', 0);
  });
  it('IS EMPTY respects nullable === false', () => {
    expectError('required IS EMPTY', 'BAD_OPERATOR', 0);
    expectError('required IS NOT EMPTY', 'BAD_OPERATOR', 0);
  });
});

describe('compile: value typing', () => {
  it('number field rejects text, bool and non-finite numbers', () => {
    expectError('budget = "5"', 'BAD_VALUE', 9);
    expectError('budget = abc', 'BAD_VALUE', 9);
    expectError('budget = true', 'BAD_VALUE', 9);
    expectError('budget = 2026-03-10', 'BAD_VALUE', 9);
    expectError(`budget = 1${'0'.repeat(400)}`, 'BAD_VALUE', 9);
    expectError('budget IN (1, "x")', 'BAD_VALUE', 14);
  });
  it('enum value must be listed', () => {
    const e = expectError('status = nope', 'BAD_VALUE', 9);
    expect(e.message).toBe('value is not allowed for field "status"');
    expectError('status = OPEN', 'BAD_VALUE', 9);
    expectError('status = 5', 'BAD_VALUE', 9);
    expectError('status IN (open, nope)', 'BAD_VALUE', 17);
    expectError('status = me()', 'BAD_VALUE', 9);
  });
  it('enum with no enumValues matches nothing legal', () => {
    const reg: FieldRegistry = { e: { sql: sql`t.e`, type: 'enum', sortable: false } };
    expect(() => compileQuery('e = a', reg, baseCtx)).toThrow(RqlError);
  });
  it('text field rejects numbers, bools and functions', () => {
    expectError('title = 5', 'BAD_VALUE', 8);
    expectError('title = true', 'BAD_VALUE', 8);
    expectError('title = today()', 'BAD_VALUE', 8);
    expectError('title ~ "x" AND title = +1d', 'BAD_VALUE', 24);
  });
  it('bool field rejects non-bools', () => {
    expectError('flag = "true"', 'BAD_VALUE', 7);
    expectError('flag = 1', 'BAD_VALUE', 7);
  });
  it('date/datetime fields reject non-dates', () => {
    expectError('due = 5', 'BAD_VALUE', 6);
    expectError('due = "tomorrow"', 'BAD_VALUE', 6);
    expectError('due = 2026-02-30', 'BAD_VALUE', 6);
    expectError('due = 2026-13-01', 'BAD_VALUE', 6);
    expectError('created = 2026-03-10T25:00', 'BAD_VALUE', 10);
    expectError('due = me()', 'BAD_VALUE', 6);
    expectError('due = myTeams()', 'BAD_VALUE', 6);
    expectError('created = true', 'BAD_VALUE', 10);
  });
  it('relative amount and range limits', () => {
    expect(() => compileQuery('due = +100000d', registry, baseCtx)).not.toThrow();
    expectError('due = +100001d', 'BAD_VALUE', 6);
    expectError('due = +99999M', 'BAD_VALUE', 6);
    expectError('created = +99999M', 'BAD_VALUE', 10);
  });
  it('bad context is reported, not crashed on', () => {
    expect(() => compileQuery('title = "a"', registry, { ...baseCtx, timezone: 'Mars/Base' })).toThrow(RqlError);
    expect(() => compileQuery('title = "a"', registry, { ...baseCtx, now: new Date(NaN) })).toThrow(RqlError);
  });
});

describe('compile: dates in Europe/Istanbul (UTC+3, now = 2026-03-10T10:30Z = 13:30 local)', () => {
  it('relative dates on datetime fields are exact instants', () => {
    expect(run('created < +7d').params).toEqual([new Date('2026-03-17T10:30:00Z')]);
    expect(run('created >= -2w').params).toEqual([new Date('2026-02-24T10:30:00Z')]);
    expect(run('created = +12h').params).toEqual([new Date('2026-03-10T22:30:00Z')]);
    expect(run('created > -30m').params).toEqual([new Date('2026-03-10T10:00:00Z')]);
    expect(run('created < +3M').params).toEqual([new Date('2026-06-10T10:30:00Z')]);
    expect(run('created < +7d').text).toBe('(t.created_at) < $1');
    expect(run('created != +1d')).toEqual({
      text: '((t.created_at) <> $1 OR (t.created_at) IS NULL)',
      params: [new Date('2026-03-11T10:30:00Z')],
    });
  });

  it('relative dates on date fields compare the local calendar day', () => {
    expect(run('due < +7d')).toEqual({ text: '(t.due_on)::date < $1::date', params: ['2026-03-17'] });
    expect(run('due >= -2w').params).toEqual(['2026-02-24']);
    expect(run('due = +3M').params).toEqual(['2026-06-10']);
    expect(run('due = +10h').params).toEqual(['2026-03-10']); // 23:30 local, still the same day
    expect(run('due = +11h').params).toEqual(['2026-03-11']); // 00:30 local, next day
  });

  it('today(), startOfWeek(), startOfMonth(), now()', () => {
    expect(run('due = today()')).toEqual({ text: '(t.due_on)::date = $1::date', params: ['2026-03-10'] });
    expect(run('due >= startOfWeek()').params).toEqual(['2026-03-09']); // Monday
    expect(run('due >= startOfMonth()').params).toEqual(['2026-03-01']);
    expect(run('due <= now()').params).toEqual(['2026-03-10']);
    expect(run('created >= startOfWeek()').params).toEqual([new Date('2026-03-08T21:00:00Z')]);
    expect(run('created >= startOfMonth()').params).toEqual([new Date('2026-02-28T21:00:00Z')]);
    expect(run('created <= now()').params).toEqual([new Date('2026-03-10T10:30:00Z')]);
  });

  it('date literals and quoted ISO strings', () => {
    expect(run('due = 2026-12-31').params).toEqual(['2026-12-31']);
    expect(run('due = "2026-12-31"').params).toEqual(['2026-12-31']);
    expect(run('due = 2026-03-10T23:30').params).toEqual(['2026-03-10']);
    expect(run('due = 2026-03-10T22:30:00Z').params).toEqual(['2026-03-11']); // 01:30 local next day
    expect(run('created > 2026-03-10T09:30').params).toEqual([new Date('2026-03-10T06:30:00Z')]);
    expect(run('created > "2026-03-10T09:30:15.250+01:00"').params).toEqual([new Date('2026-03-10T08:30:15.250Z')]);
    expect(run('created > 2026-03-10T09:30Z').params).toEqual([new Date('2026-03-10T09:30:00Z')]);
  });

  it('day-valued operands on datetime fields cover the whole local day', () => {
    const start = new Date('2026-03-09T21:00:00Z');
    const next = new Date('2026-03-10T21:00:00Z');
    expect(run('created = today()')).toEqual({ text: '((t.created_at) >= $1 AND (t.created_at) < $2)', params: [start, next] });
    expect(run('created != today()')).toEqual({
      text: '((t.created_at) < $1 OR (t.created_at) >= $2 OR (t.created_at) IS NULL)',
      params: [start, next],
    });
    expect(run('created < today()')).toEqual({ text: '(t.created_at) < $1', params: [start] });
    expect(run('created <= today()')).toEqual({ text: '(t.created_at) < $1', params: [next] });
    expect(run('created > today()')).toEqual({ text: '(t.created_at) >= $1', params: [next] });
    expect(run('created >= today()')).toEqual({ text: '(t.created_at) >= $1', params: [start] });
    expect(run('created = 2026-03-10').params).toEqual([start, next]);
  });

  it('today() flips with the local calendar day', () => {
    const lateUtc = { ...baseCtx, now: new Date('2026-03-10T22:30:00Z') }; // 01:30 on 2026-03-11 in Istanbul
    expect(run('due = today()', lateUtc).params).toEqual(['2026-03-11']);
    expect(run('created = today()', lateUtc).params).toEqual([new Date('2026-03-10T21:00:00Z'), new Date('2026-03-11T21:00:00Z')]);
  });
});

describe('compile: dates in America/New_York (DST starts 2026-03-08)', () => {
  const ny = (now: string): CompileContext => ({ ...baseCtx, timezone: 'America/New_York', now: new Date(now) });

  it('today/startOf* use local midnight with the right offset', () => {
    const ctx = ny('2026-03-10T10:30:00Z'); // 06:30 EDT
    expect(run('due = today()', ctx).params).toEqual(['2026-03-10']);
    expect(run('created = today()', ctx).params).toEqual([new Date('2026-03-10T04:00:00Z'), new Date('2026-03-11T04:00:00Z')]);
    expect(run('created >= startOfWeek()', ctx).params).toEqual([new Date('2026-03-09T04:00:00Z')]);
    expect(run('created >= startOfMonth()', ctx).params).toEqual([new Date('2026-03-01T05:00:00Z')]); // still EST
  });

  it('the local date lags UTC late in the evening', () => {
    const ctx = ny('2026-03-11T02:30:00Z'); // 22:30 EDT on 03-10
    expect(run('due = today()', ctx).params).toEqual(['2026-03-10']);
    expect(run('due = +2h', ctx).params).toEqual(['2026-03-11']);
  });

  it('+Nd is calendar-day arithmetic, +Nh is elapsed time, across the DST jump', () => {
    const ctx = ny('2026-03-07T15:00:00Z'); // 10:00 EST on Saturday
    expect(run('created = +1d', ctx).params).toEqual([new Date('2026-03-08T14:00:00Z')]); // 10:00 EDT
    expect(run('created = +24h', ctx).params).toEqual([new Date('2026-03-08T15:00:00Z')]); // 11:00 EDT
    expect(run('created = +1w', ctx).params).toEqual([new Date('2026-03-14T14:00:00Z')]);
    expect(run('created = 2026-03-08T12:00', ctx).params).toEqual([new Date('2026-03-08T16:00:00Z')]);
  });

  it('a DST-transition day is 23 hours long', () => {
    const ctx = ny('2026-03-08T12:00:00Z');
    expect(run('created = today()', ctx).params).toEqual([new Date('2026-03-08T05:00:00Z'), new Date('2026-03-09T04:00:00Z')]);
  });
});

describe('compile: limits are enforced on hand-built ASTs too', () => {
  it('too many comparisons', () => {
    const leaf = parse('title = "a"').where;
    if (leaf === null) throw new Error('unreachable');
    const e = (() => {
      try {
        compile({ where: { kind: 'and', items: Array.from({ length: 51 }, () => leaf), pos: 0 }, orderBy: [] }, registry, baseCtx);
      } catch (err) {
        return err as RqlError;
      }
      throw new Error('should fail');
    })();
    expect(e.code).toBe('LIMIT_EXCEEDED');
  });
  it('too deep, and an empty group', () => {
    let node = parse('title = "a"').where;
    if (node === null) throw new Error('unreachable');
    for (let i = 0; i < 11; i++) node = { kind: 'not', expr: node, pos: 0 };
    expect(() => compile({ where: node, orderBy: [] }, registry, baseCtx)).toThrow(/nesting/);
    expect(() => compile({ where: { kind: 'or', items: [], pos: 3 }, orderBy: [] }, registry, baseCtx)).toThrow(RqlError);
  });
  it('IN list of 501', () => {
    const values = Array.from({ length: 501 }, (_, i) => ({ kind: 'number' as const, value: i, pos: 0 }));
    expect(() =>
      compile({ where: { kind: 'in', field: 'budget', fieldPos: 0, negated: false, values, pos: 0 }, orderBy: [] }, registry, baseCtx),
    ).toThrow(/500/);
  });
  it('too many ORDER BY items', () => {
    const orderBy = Array.from({ length: 11 }, () => ({ field: 'title', fieldPos: 0, direction: 'asc' as const }));
    expect(() => compile({ where: null, orderBy }, registry, baseCtx)).toThrow(RqlError);
  });
  it('unknown node kinds and bad fields in hand-built ASTs never reach SQL', () => {
    const evil = { kind: 'cmp', field: "x'; DROP TABLE t; --", fieldPos: 0, op: '=', opPos: 0, value: { kind: 'string', value: 'a', pos: 0 }, pos: 0 } as const;
    expect(() => compile({ where: evil, orderBy: [] }, registry, baseCtx)).toThrow(/unknown field/);
    const op = { ...evil, field: 'title', op: '; DROP' } as unknown as Parameters<typeof compile>[0]['where'];
    expect(() => compile({ where: op, orderBy: [] }, registry, baseCtx)).toThrow(RqlError);
  });
});

describe('compile: unknown fields and sorting', () => {
  it('unknown field anywhere → UNKNOWN_FIELD with a uniform message', () => {
    const e = expectError('nope = 1', 'UNKNOWN_FIELD', 0);
    expect(e.message).toBe('unknown field "nope"');
    expectError('title = "a" AND nope IS EMPTY', 'UNKNOWN_FIELD', 16);
    expectError('nope IN (1)', 'UNKNOWN_FIELD', 0);
    expectError('NOT (nope ~ "a")', 'UNKNOWN_FIELD', 5);
    expectError('ORDER BY nope', 'UNKNOWN_FIELD', 9);
    expectError('title = "a" ORDER BY title, nope DESC', 'UNKNOWN_FIELD', 28);
  });

  it('hidden (FLS-removed) and nonexistent fields give the identical message', () => {
    const { budget: _hidden, ...masked } = registry;
    const fieldsMsg = (reg: FieldRegistry, q: string): string => {
      try {
        compileQuery(q, reg, baseCtx);
      } catch (e) {
        if (e instanceof RqlError) return e.message.replace(/"[^"]*"/, '"?"');
      }
      return '';
    };
    expect(fieldsMsg(masked, 'budget = 1')).toBe('unknown field "?"');
    expect(fieldsMsg(masked, 'budget = 1')).toBe(fieldsMsg(masked, 'zzz = 1'));
  });

  it('field lookup is own-property only (no prototype leaks)', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      expectError(`${name} = 1`, 'UNKNOWN_FIELD', 0);
      expectError(`ORDER BY ${name}`, 'UNKNOWN_FIELD', 9);
    }
  });

  it('field names are case-sensitive and never normalised', () => {
    expectError('Title = "a"', 'UNKNOWN_FIELD', 0);
    expectError('custom.cf_X = "a"', 'UNKNOWN_FIELD', 0);
    expectError('custom = "a"', 'UNKNOWN_FIELD', 0);
  });

  it('non-sortable fields cannot be ordered by', () => {
    const e = expectError('ORDER BY flag', 'BAD_OPERATOR', 9);
    expect(e.message).toBe('field is not sortable');
    expectError('ORDER BY title, owner DESC', 'BAD_OPERATOR', 16);
  });
});

describe('compile: injection safety (deterministic corpus)', () => {
  const corpus = [
    "' OR 1=1 --",
    "'; DROP TABLE tasks; --",
    '"; DROP TABLE tasks; --',
    '$1',
    '$1; SELECT pg_sleep(10)',
    '\\',
    "\\' OR '1'='1",
    '%',
    '_',
    '/* c */ UNION SELECT password FROM users',
    '’ OR ’1’=’1',
    '＇ OR 1=1 --',
    "Robert'); DROP TABLE Students;--",
    '${sql}',
    '`; DROP`',
    '\u0000',
  ];
  const quote = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  it.each(corpus.filter((v) => !v.includes('\u0000')))('value position: %j stays a parameter', (payload) => {
    const eq = run(`title = ${quote(payload)}`);
    expect(eq.text).toBe('(t.title) = $1');
    expect(eq.params).toEqual([payload]);
    const like = run(`title ~ ${quote(payload)}`);
    expect(like.text).toBe("(t.title) ILIKE $1 ESCAPE '\\'");
    expect(like.params[0]).toBe(`%${payload.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const list = run(`title IN (${quote(payload)}, ${quote(payload)})`);
    expect(list.text).toBe('(t.title) IN ($1, $2)');
    expect(list.params).toEqual([payload, payload]);
    for (const text of [eq.text, like.text, list.text]) {
      if (payload.length > 3) expect(text).not.toContain(payload);
      expect(text).not.toMatch(/DROP|UNION|pg_sleep/);
    }
  });

  it('NUL is rejected', () => {
    expectError('title = "a\u0000b"', 'RQL_SYNTAX', 10);
  });

  it.each(corpus)('typed fields reject the payload as a value: %j', (payload) => {
    for (const q of [`budget = ${quote(payload)}`, `status = ${quote(payload)}`, `due = ${quote(payload)}`, `flag = ${quote(payload)}`, `owner = ${quote(payload)}`]) {
      const e = fail(q);
      expect(['BAD_VALUE', 'RQL_SYNTAX']).toContain(e.code);
    }
  });

  it.each(corpus.filter((v) => !/^[A-Za-z_]\w*$/.test(v)))('unquoted payload in value position is a syntax/value error: %j', (payload) => {
    expect(() => compileQuery(`title = ${payload}`, registry, baseCtx)).toThrow(RqlError);
  });

  it.each(corpus)('payload in field position never reaches SQL: %j', (payload) => {
    for (const q of [`${payload} = 1`, `title = 1 AND ${payload} = 1`, `ORDER BY ${payload}`, `${payload} IS EMPTY`]) {
      let thrown: unknown;
      try {
        compileQuery(q, registry, baseCtx);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RqlError);
      expect(['UNKNOWN_FIELD', 'RQL_SYNTAX', 'BAD_VALUE', 'BAD_OPERATOR']).toContain((thrown as RqlError).code);
    }
  });

  it('a quoted field name is not a field', () => {
    expectError('"title" = "a"', 'RQL_SYNTAX', 0);
  });

  it('ESCAPE clause is a constant and the ILIKE pattern is a parameter', () => {
    const { text, params } = run(`title ~ "' ESCAPE ''; DROP TABLE x; --"`);
    expect(text).toBe("(t.title) ILIKE $1 ESCAPE '\\'");
    expect(params).toHaveLength(1);
  });
});
