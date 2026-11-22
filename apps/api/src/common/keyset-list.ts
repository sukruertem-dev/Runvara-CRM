import { sql, type Db, type SQL } from '@flexa/db';
import { compileQuery, parse, RqlError, type FieldRegistry } from '@flexa/query-lang';
import { createHash } from 'node:crypto';
import type { CursorCodec } from './http-helpers';
import { ProblemError } from './problem';
import type { TenantRequestContext } from './request-context';

// One list engine for every resource (ADR-0008): RQL filter (?q=), sort keys (?sort=), signed keyset cursor
// with NULLS LAST in both directions, optional total. Callers supply the FROM clause, the full view SELECT and
// the always-on filters (soft delete, record scope).

export interface ListQuery {
  q?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
  fields?: string;
  count?: string;
}

interface SortKey {
  expr: SQL;
  dir: 'asc' | 'desc';
  nullable: boolean;
}

export interface ListSpec {
  /** Resource name, part of the cursor fingerprint so a cursor cannot be replayed on another list. */
  resource: string;
  /** FROM clause whose aliases the registry SQL uses, e.g. `tasks t JOIN statuses s ON …`. */
  from: SQL;
  /** Full view query; must expose the primary key as `id`. */
  select: SQL;
  /** Primary key expression in `from`. */
  idExpr: SQL;
  /** Always-applied predicates (soft delete, record scope, extra fixed filters). */
  base: SQL[];
  registry: FieldRegistry;
  defaultSort?: string;
}

/** RQL errors become 400 problems carrying the error position (for the filter bar, ADR-0008). */
export function rqlProblem(e: unknown): never {
  if (e instanceof RqlError) throw new ProblemError(e.code, e.message, { position: e.position });
  throw e;
}

function cursorValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

export function parseSort(raw: string | undefined, registry: FieldRegistry, fallback = '-created'): SortKey[] {
  const items = (raw ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length > 5) throw new ProblemError('LIMIT_EXCEEDED', 'at most 5 sort keys');
  return items.map((item) => {
    const desc = item.startsWith('-');
    const name = desc ? item.slice(1) : item;
    const def = Object.prototype.hasOwnProperty.call(registry, name) ? registry[name] : undefined;
    if (!def) throw new ProblemError('UNKNOWN_FIELD', `unknown field "${name}"`);
    if (!def.sortable) throw new ProblemError('BAD_OPERATOR', `field "${name}" is not sortable`);
    return { expr: def.sql, dir: desc ? 'desc' : 'asc', nullable: def.nullable !== false };
  });
}

export function parseLimit(raw: string | undefined): number {
  const limit = raw === undefined ? 50 : Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ProblemError('VALIDATION_FAILED', 'limit must be 1–200');
  return limit;
}

export function parseFields(raw: string | undefined, allowed: ReadonlySet<string>): string[] | null {
  const fields = raw ? raw.split(',').map((f) => f.trim()).filter(Boolean) : null;
  const bad = fields?.find((f) => !allowed.has(f));
  if (bad !== undefined) throw new ProblemError('UNKNOWN_FIELD', `unknown field "${bad}"`);
  return fields;
}

export function pickFields(view: Record<string, unknown>, fields: string[] | null): Record<string, unknown> {
  if (!fields) return view;
  const picked: Record<string, unknown> = { id: view.id };
  for (const f of fields) picked[f] = view[f];
  return picked;
}

export interface Page<R> {
  rows: R[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export async function keysetPage<R extends Record<string, unknown>>(
  tx: Db,
  t: TenantRequestContext,
  cursors: CursorCodec,
  spec: ListSpec,
  query: ListQuery,
): Promise<Page<R>> {
  const limit = parseLimit(query.limit);
  const q = query.q ?? '';
  let where: SQL | null;
  try {
    if (parse(q).orderBy.length > 0) throw new ProblemError('BAD_OPERATOR', 'ORDER BY is not supported here; use the sort parameter');
    where = compileQuery(q, spec.registry, { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() }).where;
  } catch (e) {
    if (e instanceof ProblemError) throw e;
    return rqlProblem(e);
  }
  const sortKeys = parseSort(query.sort, spec.registry, spec.defaultSort);
  const idKey: SortKey = { expr: spec.idExpr, dir: sortKeys.at(-1)?.dir ?? 'desc', nullable: false };
  const keys = [...sortKeys, idKey];
  const fingerprint = createHash('sha256').update(JSON.stringify([spec.resource, q, query.sort ?? '', t.principal.userId])).digest('hex').slice(0, 24);

  const base: SQL[] = [...spec.base];
  if (where) base.push(sql`(${where})`);
  const filters = [...base];
  if (query.cursor) filters.push(after(keys, cursors.decode(query.cursor, fingerprint)));

  const orderBy = sql.join(keys.map((k) => (k.nullable ? sql`(${k.expr}) IS NULL, ${k.expr} ${sql.raw(k.dir)}` : sql`${k.expr} ${sql.raw(k.dir)}`)), sql`, `);
  const keyCols = sql.join(keys.map((k, i) => sql`${k.expr} AS ${sql.raw(`k${i}`)}`), sql`, `);
  const pageOrder = sql.join(
    keys.map((k, i) => {
      const col = sql.raw(`page.k${i}`);
      return k.nullable ? sql`${col} IS NULL, ${col} ${sql.raw(k.dir)}` : sql`${col} ${sql.raw(k.dir)}`;
    }),
    sql`, `,
  );
  // The page is chosen on the narrow key columns first, then joined to the full view (keeps the sort cheap).
  const rows = await tx.execute<R>(sql`
    WITH page AS (
      SELECT ${spec.idExpr} AS page_id, ${keyCols}
      FROM ${spec.from}
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    )
    SELECT base_v.*, page.* FROM (${spec.select}) AS base_v JOIN page ON page.page_id = base_v.id
    ORDER BY ${pageOrder}`);
  const hasMore = rows.rows.length > limit;
  const pageRows = rows.rows.slice(0, limit);
  const lastRow = pageRows.at(-1);
  const nextCursor = hasMore && lastRow ? cursors.encode(keys.map((_, i) => cursorValue(lastRow[`k${i}`])), fingerprint) : null;

  let total: number | undefined;
  if (query.count === 'true') {
    const c = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${spec.from} WHERE ${sql.join(base, sql` AND `)}`);
    total = c.rows[0]?.n ?? 0;
  }
  return { rows: pageRows as R[], nextCursor, hasMore, ...(total !== undefined ? { total } : {}) };
}

/** Keyset predicate "strictly after the cursor" for keys sorted with NULLS LAST in either direction. */
function after(keys: SortKey[], values: unknown[]): SQL {
  if (values.length !== keys.length) throw new ProblemError('CURSOR_INVALID');
  const branches: SQL[] = [];
  for (let i = 0; i < keys.length; i++) {
    const parts: SQL[] = [];
    for (let j = 0; j < i; j++) parts.push(equal(keys[j] as SortKey, values[j]));
    const gt = greater(keys[i] as SortKey, values[i]);
    if (!gt) continue;
    parts.push(gt);
    branches.push(sql`(${sql.join(parts, sql` AND `)})`);
  }
  return branches.length ? sql`(${sql.join(branches, sql` OR `)})` : sql`FALSE`;
}

function equal(k: SortKey, v: unknown): SQL {
  return v === null ? sql`(${k.expr}) IS NULL` : sql`(${k.expr}) = ${v}`;
}

function greater(k: SortKey, v: unknown): SQL | null {
  if (v === null) return null; // inside the NULL group nothing sorts after on this key; later keys decide
  const op = sql.raw(k.dir === 'asc' ? '>' : '<');
  return k.nullable ? sql`((${k.expr}) IS NULL OR (${k.expr}) ${op} ${v})` : sql`(${k.expr}) ${op} ${v}`;
}

// ---------------------------------------------------------------- aggregation (dashboards, pipeline totals)
export interface AggregateQuery {
  q?: string;
  groupBy?: string;
  /** `count` or `sum:<number field>`. */
  metric?: string;
  /** For datetime/date groupings: `day` (default), `week` or `month`, in the tenant's time zone. */
  interval?: string;
}

const GROUPABLE: ReadonlySet<string> = new Set(['text', 'enum', 'user', 'uuid', 'number', 'bool', 'date', 'datetime']);
const INTERVALS: ReadonlySet<string> = new Set(['day', 'week', 'month']);
const MAX_GROUPS = 200;

/**
 * Counts (and optionally sums) the rows a list would return — same FROM, same always-on predicates (soft delete,
 * record scope) and the same RQL filter — grouped by one registry field. Hidden fields are absent from the
 * registry, so they can be neither grouped nor summed (UNKNOWN_FIELD).
 */
export async function aggregate(
  tx: Db,
  t: TenantRequestContext,
  spec: Pick<ListSpec, 'from' | 'base' | 'registry'>,
  query: AggregateQuery,
): Promise<{ data: { key: string | null; count: number; sum?: string }[]; total: number }> {
  const field = (name: string): NonNullable<FieldRegistry[string]> => {
    const def = Object.prototype.hasOwnProperty.call(spec.registry, name) ? spec.registry[name] : undefined;
    if (!def) throw new ProblemError('UNKNOWN_FIELD', `unknown field "${name}"`);
    return def;
  };
  let where: SQL | null;
  try {
    where = compileQuery(query.q ?? '', spec.registry, { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() }).where;
  } catch (e) {
    return rqlProblem(e);
  }
  const filters = [...spec.base, ...(where ? [sql`(${where})`] : [])];

  let keyExpr: SQL = sql`NULL::text`;
  if (query.groupBy) {
    const def = field(query.groupBy);
    if (!GROUPABLE.has(def.type)) throw new ProblemError('VALIDATION_FAILED', `cannot group by "${query.groupBy}"`);
    if (def.type === 'datetime' || def.type === 'date') {
      const interval = query.interval ?? 'day';
      if (!INTERVALS.has(interval)) throw new ProblemError('VALIDATION_FAILED', 'interval must be day, week or month');
      // `interval` is one of three literals checked above; the time zone is bound as a parameter.
      keyExpr = def.type === 'datetime'
        ? sql`to_char(date_trunc(${interval}, (${def.sql}) AT TIME ZONE ${t.tenant.timezone}), 'YYYY-MM-DD')`
        : sql`to_char(date_trunc(${interval}, (${def.sql})::timestamp), 'YYYY-MM-DD')`;
    } else {
      keyExpr = sql`(${def.sql})::text`;
    }
  }

  const metric = query.metric ?? 'count';
  let sumExpr: SQL | null = null;
  if (metric !== 'count') {
    const m = /^sum:([A-Za-z_][\w.]*)$/.exec(metric);
    if (!m?.[1]) throw new ProblemError('VALIDATION_FAILED', 'metric must be count or sum:<number field>');
    const def = field(m[1]);
    if (def.type !== 'number') throw new ProblemError('VALIDATION_FAILED', `"${m[1]}" is not a number field`);
    sumExpr = def.sql;
  }

  const r = await tx.execute<{ key: string | null; n: number; s: string | null }>(sql`
    SELECT ${keyExpr} AS key, count(*)::int AS n, ${sumExpr ? sql`coalesce(sum(${sumExpr}), 0)::text` : sql`NULL::text`} AS s
    FROM ${spec.from}
    WHERE ${sql.join(filters, sql` AND `)}
    GROUP BY 1
    ORDER BY 2 DESC, 1
    LIMIT ${MAX_GROUPS}`);
  const data = r.rows.map((row) => ({ key: row.key, count: row.n, ...(sumExpr ? { sum: row.s ?? '0' } : {}) }));
  return { data, total: data.reduce((n, g) => n + g.count, 0) };
}
