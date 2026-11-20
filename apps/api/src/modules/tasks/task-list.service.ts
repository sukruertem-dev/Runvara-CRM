import { Inject, Injectable } from '@nestjs/common';
import { recordScope } from '@flexa/authz';
import type { ApiEnv } from '@flexa/config';
import { sql, type DbHandle, type SQL } from '@flexa/db';
import { compileQuery, parse, RqlError, type FieldRegistry } from '@flexa/query-lang';
import { createHash } from 'node:crypto';
import { CursorCodec } from '../../common/http-helpers';
import { ProblemError } from '../../common/problem';
import type { TenantRequestContext } from '../../common/request-context';
import { DB, ENV } from '../../infra/tokens';
import { taskRegistry } from './task-fields';
import { hydrate, scopeSql, TASK_SELECT, toView, TasksService, type TaskRow } from './tasks.service';

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

const VIEW_FIELDS = new Set([
  'id', 'title', 'description', 'descriptionText', 'workflowId', 'status', 'priority', 'owner', 'assigneeUserId', 'startAt', 'dueAt',
  'estimateMinutes', 'parentId', 'depth', 'position', 'related', 'seriesId', 'occurrenceIndex', 'custom', 'tagIds', 'closedAt',
  'version', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
]);

/** RQL errors become 400 problems carrying the error position (for the filter bar, ADR-0008). */
export function rqlProblem(e: unknown): never {
  if (e instanceof RqlError) throw new ProblemError(e.code, e.message, { position: e.position });
  throw e;
}

/** Normalises a key value returned by PostgreSQL for storage in a cursor. */
function cursorValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v ?? null;
}

@Injectable()
export class TaskListService {
  private readonly cursors: CursorCodec;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) env: ApiEnv,
    private readonly tasks: TasksService,
  ) {
    this.cursors = new CursorCodec(createHash('sha256').update(`cursor-key:${env.CSRF_SECRET}`).digest('hex'));
  }

  static parseSort(raw: string | undefined, registry: FieldRegistry): SortKey[] {
    const items = (raw ?? '-created').split(',').map((s) => s.trim()).filter(Boolean);
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

  async list(t: TenantRequestContext, query: ListQuery) {
    const scope = recordScope(t.authz, 'read');
    if (scope.kind === 'none') throw new ProblemError('FORBIDDEN');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new ProblemError('VALIDATION_FAILED', 'limit must be 1–200');
    const fields = query.fields ? query.fields.split(',').map((f) => f.trim()).filter(Boolean) : null;
    if (fields?.some((f) => !VIEW_FIELDS.has(f))) throw new ProblemError('UNKNOWN_FIELD', `unknown field "${fields.find((f) => !VIEW_FIELDS.has(f)) ?? ''}"`);
    const q = query.q ?? '';

    return this.db.withTenant(this.tasks.ctx(t), async (tx) => {
      const vc = await this.tasks.viewContext(tx);
      const registry = taskRegistry(vc.defs);
      let where: SQL | null;
      try {
        if (parse(q).orderBy.length > 0) throw new ProblemError('BAD_OPERATOR', 'ORDER BY is not supported here; use the sort parameter');
        where = compileQuery(q, registry, { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() }).where;
      } catch (e) {
        if (e instanceof ProblemError) throw e;
        return rqlProblem(e);
      }
      const sortKeys = TaskListService.parseSort(query.sort, registry);
      const last = sortKeys.at(-1);
      const idKey: SortKey = { expr: sql`t.id`, dir: last?.dir ?? 'desc', nullable: false };
      const keys = [...sortKeys, idKey];
      const fingerprint = createHash('sha256').update(JSON.stringify([q, query.sort ?? '', t.principal.userId])).digest('hex').slice(0, 24);

      const base: SQL[] = [sql`t.deleted_at IS NULL`, scopeSql(scope, t.principal.userId)];
      if (where) base.push(sql`(${where})`);
      const filters = [...base];
      if (query.cursor) filters.push(this.after(keys, this.cursors.decode(query.cursor, fingerprint)));

      const orderBy = sql.join(keys.map((k) => (k.nullable ? sql`(${k.expr}) IS NULL, ${k.expr} ${sql.raw(k.dir)}` : sql`${k.expr} ${sql.raw(k.dir)}`)), sql`, `);
      const keyCols = sql.join(keys.map((k, i) => sql`${k.expr} AS ${sql.raw(`k${i}`)}`), sql`, `);
      // The page is chosen on the narrow key columns first, then joined to the full view (keeps the sort cheap).
      const pageOrder = sql.join(
        keys.map((k, i) => {
          const col = sql.raw(`page.k${i}`);
          return k.nullable ? sql`${col} IS NULL, ${col} ${sql.raw(k.dir)}` : sql`${col} ${sql.raw(k.dir)}`;
        }),
        sql`, `,
      );
      const rows = await tx.execute<TaskRow & Record<string, unknown>>(sql`
        WITH page AS (
          SELECT t.id AS page_id, ${keyCols}
          FROM tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id
          WHERE ${sql.join(filters, sql` AND `)}
          ORDER BY ${orderBy}
          LIMIT ${limit + 1}
        )
        SELECT base_v.*, page.* FROM (${TASK_SELECT}) AS base_v JOIN page ON page.page_id = base_v.id
        ORDER BY ${pageOrder}`);
      const hasMore = rows.rows.length > limit;
      const pageRows = rows.rows.slice(0, limit);
      const lastRow = pageRows.at(-1);
      const nextCursor = hasMore && lastRow ? this.cursors.encode(keys.map((_, i) => cursorValue(lastRow[`k${i}`])), fingerprint) : null;

      let total: number | undefined;
      if (query.count === 'true') {
        const c = await tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id WHERE ${sql.join(base, sql` AND `)}`);
        total = c.rows[0]?.n ?? 0;
      }
      const data = pageRows.map((row) => {
        const v = toView(hydrate(row), vc);
        if (!fields) return v;
        const picked: Record<string, unknown> = { id: v.id };
        for (const f of fields) picked[f] = v[f];
        return picked;
      });
      return { data, page: { nextCursor, hasMore }, ...(total !== undefined ? { meta: { total } } : {}) };
    });
  }

  /** Keyset predicate "strictly after the cursor" for keys sorted with NULLS LAST in either direction. */
  private after(keys: SortKey[], values: unknown[]): SQL {
    if (values.length !== keys.length) throw new ProblemError('CURSOR_INVALID');
    const branches: SQL[] = [];
    for (let i = 0; i < keys.length; i++) {
      const parts: SQL[] = [];
      for (let j = 0; j < i; j++) parts.push(this.equal(keys[j] as SortKey, values[j]));
      const gt = this.greater(keys[i] as SortKey, values[i]);
      if (!gt) continue;
      parts.push(gt);
      branches.push(sql`(${sql.join(parts, sql` AND `)})`);
    }
    return branches.length ? sql`(${sql.join(branches, sql` OR `)})` : sql`FALSE`;
  }

  private equal(k: SortKey, v: unknown): SQL {
    return v === null ? sql`(${k.expr}) IS NULL` : sql`(${k.expr}) = ${v}`;
  }

  private greater(k: SortKey, v: unknown): SQL | null {
    if (v === null) return null; // inside the NULL group nothing sorts after on this key; later keys decide
    const op = sql.raw(k.dir === 'asc' ? '>' : '<');
    return k.nullable ? sql`((${k.expr}) IS NULL OR (${k.expr}) ${op} ${v})` : sql`(${k.expr}) ${op} ${v}`;
  }
}
