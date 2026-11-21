import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { sql, type DbHandle, type SQL } from '@flexa/db';
import { createHash } from 'node:crypto';
import { CursorCodec } from '../../common/http-helpers';
import { keysetPage, parseFields, pickFields, type ListQuery } from '../../common/keyset-list';
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
