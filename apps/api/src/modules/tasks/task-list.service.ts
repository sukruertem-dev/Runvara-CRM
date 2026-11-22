import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { sql, type DbHandle, type SQL } from '@flexa/db';
import { createHash } from 'node:crypto';
import { CursorCodec } from '../../common/http-helpers';
import { aggregate, keysetPage, parseFields, pickFields, type AggregateQuery, type ListQuery } from '../../common/keyset-list';
import { uuidArray } from '../../common/record-access';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB, ENV } from '../../infra/tokens';
import { taskRegistry } from './task-fields';
import { hydrate, TASK_SELECT, taskReadPredicate, toView, TasksService, type TaskRow } from './tasks.service';

export type { ListQuery } from '../../common/keyset-list';

const VIEW_FIELDS = new Set([
  'id', 'title', 'description', 'descriptionText', 'workflowId', 'status', 'priority', 'owner', 'assigneeUserId', 'startAt', 'dueAt',
  'estimateMinutes', 'parentId', 'depth', 'position', 'related', 'seriesId', 'occurrenceIndex', 'custom', 'tagIds', 'closedAt',
  'version', 'createdBy', 'createdAt', 'updatedAt', 'deletedAt',
]);

export function cursorCodec(env: ApiEnv): CursorCodec {
  return new CursorCodec(createHash('sha256').update(`cursor-key:${env.CSRF_SECRET}`).digest('hex'));
}

@Injectable()
export class TaskListService {
  private readonly cursors: CursorCodec;

  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(ENV) env: ApiEnv,
    private readonly tasks: TasksService,
  ) {
    this.cursors = cursorCodec(env);
  }

  /** Dependency edges among the given tasks, both ends readable by the caller (Gantt arrows, critical path). */
  async dependencyEdges(t: TenantRequestContext, ids: string[]) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await tx.execute<{ blocker_id: string; blocked_id: string }>(sql`
        WITH visible AS (
          SELECT t.id FROM tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id
          WHERE t.id = ANY(${uuidArray(ids)}) AND t.deleted_at IS NULL AND ${await taskReadPredicate(tx, t)}
        )
        SELECT d.blocker_id, d.blocked_id FROM task_dependencies d
        WHERE d.blocker_id IN (SELECT id FROM visible) AND d.blocked_id IN (SELECT id FROM visible)
        ORDER BY d.blocked_id, d.blocker_id`);
      return { data: r.rows.map((x) => ({ blockerId: x.blocker_id, blockedId: x.blocked_id })) };
    });
  }

  /** Grouped counts/sums over exactly what the task list would return (dashboards, P6b). */
  async aggregate(t: TenantRequestContext, query: AggregateQuery) {
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const vc = await this.tasks.viewContext(tx);
      return aggregate(tx, t, {
        from: sql`tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id`,
        base: [sql`t.deleted_at IS NULL`, await taskReadPredicate(tx, t)],
        registry: taskRegistry(vc.defs),
      }, query);
    });
  }

  /** Task list; `extra` adds fixed predicates (e.g. related record) on alias `t`. */
  async list(t: TenantRequestContext, query: ListQuery, extra: SQL[] = []) {
    // Tasks are also readable through their parent record (taskReadPredicate), so no early 403 here.
    const fields = parseFields(query.fields, VIEW_FIELDS);
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const vc = await this.tasks.viewContext(tx);
      const page = await keysetPage<TaskRow & Record<string, unknown>>(tx, t, this.cursors, {
        resource: 'task',
        from: sql`tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id`,
        select: TASK_SELECT,
        idExpr: sql`t.id`,
        base: [sql`t.deleted_at IS NULL`, await taskReadPredicate(tx, t), ...extra],
        registry: taskRegistry(vc.defs),
      }, query);
      return {
        data: page.rows.map((row) => pickFields(toView(hydrate(row), vc), fields)),
        page: { nextCursor: page.nextCursor, hasMore: page.hasMore },
        ...(page.total !== undefined ? { meta: { total: page.total } } : {}),
      };
    });
  }
}
