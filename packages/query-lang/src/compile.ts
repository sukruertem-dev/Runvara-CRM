import { sql, type SQL } from 'drizzle-orm';
import type { DateTime } from 'luxon';
import {
  checkLimits,
  MAX_IN_VALUES,
  MAX_ORDER_ITEMS,
  type Expr,
  type FuncName,
  type Query,
  type RqlOp,
  type RqlValue,
} from './ast';
import {
  addRelative,
  assertZone,
  isoDate,
  nextDayStart,
  nowIn,
  parseIso,
  startOfDay,
  startOfMonth,
  startOfWeek,
  type Temporal,
} from './dates';
import { RqlError } from './errors';
import { parse } from './parser';

export type FieldType = 'text' | 'number' | 'date' | 'datetime' | 'bool' | 'uuid' | 'enum' | 'user';
export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=';

export interface FieldDef {
  /** Column / expression, e.g. sql`t.due_at`. Must be a trusted, developer-written fragment. */
  sql: SQL;
  type: FieldType;
  sortable: boolean;
  /** Required when type === 'enum'. */
  enumValues?: readonly string[];
  /** IS EMPTY allowed (default true). */
  nullable?: boolean;
}
export type FieldRegistry = Readonly<Record<string, FieldDef>>;

export interface CompileContext {
  userId: string;
  timezone: string;
  now: Date;
  teamIds?: readonly string[];
  queueIds?: readonly string[];
}

export interface Compiled {
  where: SQL | null;
  orderBy: SQL[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALL_COMPARE: ReadonlySet<RqlOp> = new Set<RqlOp>(['=', '!=', '<', '<=', '>', '>=']);
const EQUALITY: ReadonlySet<RqlOp> = new Set<RqlOp>(['=', '!=']);
const OPERATORS: Readonly<Record<FieldType, ReadonlySet<RqlOp>>> = {
  text: new Set<RqlOp>(['=', '!=', '~']),
  number: ALL_COMPARE,
  date: ALL_COMPARE,
  datetime: ALL_COMPARE,
  bool: EQUALITY,
  uuid: EQUALITY,
  user: EQUALITY,
  enum: EQUALITY,
};
const IN_TYPES: ReadonlySet<FieldType> = new Set<FieldType>(['text', 'number', 'enum', 'uuid', 'user', 'date']);

interface Env {
  readonly registry: FieldRegistry;
  readonly ctx: CompileContext;
  readonly zone: string;
  readonly now: DateTime;
}

function lookup(env: Env, name: string, pos: number): FieldDef {
  if (!Object.hasOwn(env.registry, name)) throw new RqlError('UNKNOWN_FIELD', `unknown field "${name}"`, pos);
  const def = env.registry[name];
  if (def === undefined) throw new RqlError('UNKNOWN_FIELD', `unknown field "${name}"`, pos);
  return def;
}

/** Field expression as compared against values (dates compare per day). */
function fieldExpr(def: FieldDef): SQL {
  return def.type === 'date' ? sql`(${def.sql})::date` : sql`(${def.sql})`;
}
function rawField(def: FieldDef): SQL {
  return sql`(${def.sql})`;
}

function opSql(op: RqlOp, pos: number): SQL {
  switch (op) {
    case '=':
      return sql`=`;
    case '<':
      return sql`<`;
    case '<=':
      return sql`<=`;
    case '>':
      return sql`>`;
    case '>=':
      return sql`>=`;
    case '!=':
    case '~':
      throw new RqlError('BAD_OPERATOR', `operator "${op}" is not a plain comparison`, pos);
  }
}

function stringOf(value: RqlValue): string | null {
  return value.kind === 'string' || value.kind === 'word' ? value.value : null;
}

function isMe(value: RqlValue): boolean {
  return (value.kind === 'func' && value.name === 'me') || (value.kind === 'word' && value.value === 'me');
}

function userIdParam(env: Env, pos: number): SQL {
  if (!UUID_RE.test(env.ctx.userId)) throw new RqlError('BAD_VALUE', 'context userId is not a UUID', pos);
  return sql`${env.ctx.userId.toLowerCase()}`;
}

function resolveTemporal(value: RqlValue, env: Env): Temporal {
  switch (value.kind) {
    case 'date':
    case 'string': {
      const parsed = parseIso(value.value, env.zone, value.pos);
      if (parsed === null) {
        throw new RqlError('BAD_VALUE', 'invalid date, expected YYYY-MM-DD or YYYY-MM-DDTHH:mm[:ss]', value.pos);
      }
      return parsed;
    }
    case 'rel':
      return { kind: 'instant', at: addRelative(env.now, value.amount, value.unit, value.pos) };
    case 'func':
      switch (value.name) {
        case 'today':
          return { kind: 'day', start: startOfDay(env.now) };
        case 'now':
          return { kind: 'instant', at: env.now };
        case 'startOfWeek':
          return { kind: 'instant', at: startOfWeek(env.now) };
        case 'startOfMonth':
          return { kind: 'instant', at: startOfMonth(env.now) };
        default:
          throw new RqlError('BAD_VALUE', `${value.name}() cannot be used with a date field`, value.pos);
      }
    default:
      throw new RqlError('BAD_VALUE', 'expected a date value (YYYY-MM-DD, +7d, today(), …)', value.pos);
  }
}

function temporalDate(t: Temporal, pos: number): string {
  return isoDate(t.kind === 'day' ? t.start : t.at, pos);
}

/** A single value as an SQL parameter for non-datetime field types. */
function scalarParam(def: FieldDef, name: string, value: RqlValue, env: Env): SQL {
  switch (def.type) {
    case 'text': {
      const s = stringOf(value);
      if (s === null) throw new RqlError('BAD_VALUE', `field "${name}" expects a text value`, value.pos);
      return sql`${s}`;
    }
    case 'enum': {
      const s = stringOf(value);
      if (s === null || !(def.enumValues ?? []).includes(s)) {
        throw new RqlError('BAD_VALUE', `value is not allowed for field "${name}"`, value.pos);
      }
      return sql`${s}`;
    }
    case 'number': {
      if (value.kind !== 'number' || !Number.isFinite(value.value)) {
        throw new RqlError('BAD_VALUE', `field "${name}" expects a finite number`, value.pos);
      }
      return sql`${value.value}`;
    }
    case 'bool': {
      if (value.kind !== 'bool') throw new RqlError('BAD_VALUE', `field "${name}" expects true or false`, value.pos);
      return sql`${value.value}`;
    }
    case 'uuid':
    case 'user': {
      if (isMe(value)) return userIdParam(env, value.pos);
      const s = stringOf(value);
      if (s === null || !UUID_RE.test(s)) {
        throw new RqlError('BAD_VALUE', `field "${name}" expects a UUID or me()`, value.pos);
      }
      return sql`${s.toLowerCase()}`;
    }
    case 'date':
      return sql`${temporalDate(resolveTemporal(value, env), value.pos)}::date`;
    case 'datetime':
      throw new RqlError('BAD_OPERATOR', `IN is not supported for datetime field "${name}"`, value.pos);
  }
}

function isIdListFunc(value: RqlValue): value is { kind: 'func'; name: FuncName; pos: number } {
  return value.kind === 'func' && (value.name === 'myTeams' || value.name === 'myQueues');
}

function idList(f: SQL, ids: readonly string[], negated: boolean, pos: number): SQL {
  if (ids.length > MAX_IN_VALUES) {
    throw new RqlError('LIMIT_EXCEEDED', `id list has more than ${MAX_IN_VALUES} entries`, pos);
  }
  if (ids.length === 0) return negated ? sql`TRUE` : sql`FALSE`;
  const params = ids.map((id) => {
    if (!UUID_RE.test(id)) throw new RqlError('BAD_VALUE', 'context id list contains a non-UUID value', pos);
    return sql`${id.toLowerCase()}`;
  });
  const list = sql.join(params, sql`, `);
  return negated ? sql`(${f} NOT IN (${list}) OR ${f} IS NULL)` : sql`${f} IN (${list})`;
}

function compileCmp(e: Extract<Expr, { kind: 'cmp' }>, env: Env): SQL {
  const def = lookup(env, e.field, e.fieldPos);
  if (!OPERATORS[def.type].has(e.op)) {
    throw new RqlError('BAD_OPERATOR', `operator "${e.op}" is not supported for ${def.type} field "${e.field}"`, e.opPos);
  }
  const value = e.value;

  if (e.op === '~') {
    const s = stringOf(value);
    if (s === null) throw new RqlError('BAD_VALUE', '"~" expects a text value', value.pos);
    const pattern = `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return sql`${rawField(def)} ILIKE ${pattern} ESCAPE '\\'`;
  }

  if (isIdListFunc(value)) {
    if (def.type !== 'uuid' && def.type !== 'user') {
      throw new RqlError('BAD_VALUE', `${value.name}() requires a uuid or user field`, value.pos);
    }
    const ids = (value.name === 'myTeams' ? env.ctx.teamIds : env.ctx.queueIds) ?? [];
    return idList(rawField(def), ids, e.op === '!=', value.pos);
  }

  if (def.type === 'datetime') {
    const t = resolveTemporal(value, env);
    const f = rawField(def);
    if (t.kind === 'instant') {
      const p = sql`${t.at.toJSDate()}`;
      if (e.op === '!=') return sql`(${f} <> ${p} OR ${f} IS NULL)`;
      return sql`${f} ${opSql(e.op, e.opPos)} ${p}`;
    }
    const start = sql`${t.start.toJSDate()}`;
    const next = sql`${nextDayStart(t.start).toJSDate()}`;
    switch (e.op) {
      case '=':
        return sql`(${f} >= ${start} AND ${f} < ${next})`;
      case '!=':
        return sql`(${f} < ${start} OR ${f} >= ${next} OR ${f} IS NULL)`;
      case '<':
        return sql`${f} < ${start}`;
      case '<=':
        return sql`${f} < ${next}`;
      case '>':
        return sql`${f} >= ${next}`;
      case '>=':
        return sql`${f} >= ${start}`;
    }
  }

  const f = fieldExpr(def);
  const p = scalarParam(def, e.field, value, env);
  if (e.op === '!=') return sql`(${f} <> ${p} OR ${rawField(def)} IS NULL)`;
  return sql`${f} ${opSql(e.op, e.opPos)} ${p}`;
}

function compileIn(e: Extract<Expr, { kind: 'in' }>, env: Env): SQL {
  const def = lookup(env, e.field, e.fieldPos);
  if (!IN_TYPES.has(def.type)) {
    throw new RqlError('BAD_OPERATOR', `IN is not supported for ${def.type} field "${e.field}"`, e.fieldPos);
  }
  const params = e.values.map((v) => {
    if (v.kind === 'func' && (v.name === 'myTeams' || v.name === 'myQueues')) {
      throw new RqlError('BAD_VALUE', `${v.name}() is only valid as "field = ${v.name}()"`, v.pos);
    }
    return scalarParam(def, e.field, v, env);
  });
  const list = sql.join(params, sql`, `);
  const f = fieldExpr(def);
  if (e.negated) return sql`(${f} NOT IN (${list}) OR ${rawField(def)} IS NULL)`;
  return sql`${f} IN (${list})`;
}

function compileEmpty(e: Extract<Expr, { kind: 'empty' }>, env: Env): SQL {
  const def = lookup(env, e.field, e.fieldPos);
  if (def.nullable === false) {
    throw new RqlError('BAD_OPERATOR', `field "${e.field}" cannot be empty`, e.fieldPos);
  }
  const f = rawField(def);
  if (def.type === 'text') {
    return e.negated ? sql`(${f} IS NOT NULL AND ${f} <> '')` : sql`(${f} IS NULL OR ${f} = '')`;
  }
  return e.negated ? sql`${f} IS NOT NULL` : sql`${f} IS NULL`;
}

function compileExpr(e: Expr, env: Env): SQL {
  switch (e.kind) {
    case 'and':
    case 'or': {
      const parts = e.items.map((item) => compileExpr(item, env));
      const [only] = parts;
      if (parts.length === 1 && only !== undefined) return only;
      return sql`(${sql.join(parts, e.kind === 'and' ? sql` AND ` : sql` OR `)})`;
    }
    case 'not':
      return sql`NOT (${compileExpr(e.expr, env)})`;
    case 'cmp':
      return compileCmp(e, env);
    case 'in':
      return compileIn(e, env);
    case 'empty':
      return compileEmpty(e, env);
  }
}

export function compile(q: Query, registry: FieldRegistry, ctx: CompileContext): Compiled {
  const zone = assertZone(ctx.timezone);
  const env: Env = { registry, ctx, zone, now: nowIn(ctx.now, zone) };
  if (q.orderBy.length > MAX_ORDER_ITEMS) {
    throw new RqlError('LIMIT_EXCEEDED', `ORDER BY has more than ${MAX_ORDER_ITEMS} fields`, 0);
  }
  let where: SQL | null = null;
  if (q.where !== null) {
    checkLimits(q.where);
    where = compileExpr(q.where, env);
  }
  const orderBy = q.orderBy.map((item) => {
    const def = lookup(env, item.field, item.fieldPos);
    if (!def.sortable) throw new RqlError('BAD_OPERATOR', 'field is not sortable', item.fieldPos);
    return item.direction === 'desc' ? sql`${rawField(def)} DESC NULLS LAST` : sql`${rawField(def)} ASC NULLS LAST`;
  });
  return { where, orderBy };
}

export function compileQuery(input: string, registry: FieldRegistry, ctx: CompileContext): Compiled {
  return compile(parse(input), registry, ctx);
}
