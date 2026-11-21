import { Inject, Injectable } from '@nestjs/common';
import { recordScope, type RecordAction, type RecordScope } from '@flexa/authz';
import type { TaskCreate, TaskPatch, TaskTransitionRequest, TaskMoveRequest, TaskBulkRequest, TaskSeriesCreate, z } from '@flexa/contracts';
import { and, eq, isNull, one, schema, sql, type Db, type DbHandle, type SQL } from '@flexa/db';
import type { Formula } from '@flexa/formula';
import { nextOccurrence, occurrence, RecurrenceError, validateSeries, type SeriesSpec } from '@flexa/recurrence';
import {
  keyBetween,
  needsRebalance,
  rebalance,
  resolveTransition,
  wouldCreateCycle,
  type Condition,
  type PostFunction,
  type Validator,
  type Workflow,
} from '@flexa/workflow';
import { mapDbError } from '../../common/http-helpers';
import { ProblemError } from '../../common/problem';
import { dbCtx, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';
import { assertCan, canAssignTo, recordPredicate, type RecordShape } from '../../common/record-access';
import { randomUUID } from 'node:crypto';
import { recordActivity, viewDiff } from '../../common/activity';
import { notify } from '../../common/notify';
import { attachedSegment, CRM, CRM_TYPES, isCrmType, readCrmRow } from '../crm/crm-objects';
import { compileFormulas, loadFieldDefs, taskRegistry, validateCustom, withFormulas, type FieldDefRow } from './task-fields';

type Create = z.infer<typeof TaskCreate>;
type Patch = z.infer<typeof TaskPatch>;

// A type alias (not an interface) so it satisfies the Record<string, unknown> row constraint of db.execute.
export type TaskRow = {
  id: string;
  title: string;
  description: unknown;
  description_text: string | null;
  workflow_id: string;
  status_id: string;
  priority: number;
  owner_type: 'user' | 'queue';
  owner_id: string;
  owner_user_id: string | null;
  queue_id: string | null;
  assignee_user_id: string | null;
  start_at: Date | null;
  due_at: Date | null;
  estimate_minutes: number | null;
  parent_id: string | null;
  depth: number;
  position: string;
  related_type: string | null;
  related_id: string | null;
  series_id: string | null;
  occurrence_index: number | null;
  custom: Record<string, unknown>;
  closed_at: Date | null;
  version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  s_key: string;
  s_category: 'open' | 'in_progress' | 'closed';
  s_label: Record<string, string>;
  s_color: string;
  tag_ids: string[];
};

export const TASK_SELECT = sql`
  SELECT t.id, t.title, t.description, t.description_text, t.workflow_id, t.status_id, t.priority, t.owner_type, t.owner_id,
         t.owner_user_id, t.queue_id, t.assignee_user_id, t.start_at, t.due_at, t.estimate_minutes, t.parent_id, t.depth,
         t.position, t.related_type, t.related_id, t.series_id, t.occurrence_index, t.custom, t.closed_at, t.version,
         t.created_by, t.created_at, t.updated_at, t.deleted_at,
         s.key AS s_key, s.category AS s_category, s.label_i18n AS s_label, s.color_token AS s_color,
         (SELECT coalesce(array_agg(tt.tag_id ORDER BY tt.tag_id), '{}') FROM task_tags tt
           WHERE tt.tenant_id = t.tenant_id AND tt.task_id = t.id) AS tag_ids
  FROM tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id`;

/** permission-matrix.yaml policies.bulk_max_items_own (default; per-tenant policy values arrive with P4b). */
const BULK_MAX_ITEMS_OWN = 100;

export const TASK_SHAPE: RecordShape = {
  type: 'task',
  resource: 'core.task',
  from: sql`tasks t JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id`,
  queueColumn: true,
  assigneeColumn: true,
  registry: async (tx) => taskRegistry(await loadFieldDefs(tx, 'task')),
};

/** Read predicate for tasks (alias t): the task's own scope, or read access to the CRM record it is linked to
 *  (Faz 4: activity/task access derives from the parent record). Writes stay on the task's own scope. */
export async function taskReadPredicate(tx: Db, t: TenantRequestContext): Promise<SQL> {
  // Tenant-wide task read (or an organisation-wide default) already covers every task: no parent subqueries.
  if (recordScope(t.authz, 'read', 'core.task').kind === 'all' || t.access.owd.task === 'read' || t.access.owd.task === 'read_write') {
    return recordPredicate(tx, t, TASK_SHAPE, 'read');
  }
  const terms: SQL[] = [await recordPredicate(tx, t, TASK_SHAPE, 'read')];
  for (const type of CRM_TYPES) {
    const def = CRM[type];
    if (recordScope(t.authz, 'read', def.resource).kind === 'none') continue;
    const parent = await recordPredicate(tx, t, def.shape, 'read');
    terms.push(sql`(t.related_type = ${type} AND t.related_id IN (SELECT t.id FROM ${def.from} WHERE t.deleted_at IS NULL AND ${parent}))`);
  }
  return sql`(${sql.join(terms, sql` OR `)})`;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

const DATE_COLUMNS = ['start_at', 'due_at', 'closed_at', 'created_at', 'updated_at', 'deleted_at'] as const;

/** drizzle's node-postgres driver returns timestamptz as text from raw `execute`; convert once here. */
export function hydrate<R extends TaskRow>(row: R): R {
  const out: Record<string, unknown> = { ...row };
  for (const c of DATE_COLUMNS) {
    const v = out[c];
    if (typeof v === 'string') out[c] = new Date(v);
  }
  return out as R;
}

export interface ViewContext {
  defs: FieldDefRow[];
  formulas: Map<string, Formula>;
}

export function toView(r: TaskRow, vc: ViewContext): Record<string, unknown> {
  const scalars = { priority: r.priority, estimate_minutes: r.estimate_minutes, due_at: iso(r.due_at), start_at: iso(r.start_at), created_at: iso(r.created_at), closed_at: iso(r.closed_at), title: r.title };
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? null,
    descriptionText: r.description_text,
    workflowId: r.workflow_id,
    status: { id: r.status_id, key: r.s_key, category: r.s_category, label: r.s_label, colorToken: r.s_color },
    priority: r.priority,
    owner: { type: r.owner_type, id: r.owner_id },
    assigneeUserId: r.assignee_user_id,
    startAt: iso(r.start_at),
    dueAt: iso(r.due_at),
    estimateMinutes: r.estimate_minutes,
    parentId: r.parent_id,
    depth: r.depth,
    position: r.position,
    related: r.related_type && r.related_id ? { type: r.related_type, id: r.related_id } : null,
    seriesId: r.series_id,
    occurrenceIndex: r.occurrence_index,
    custom: withFormulas(vc.defs, vc.formulas, scalars, r.custom),
    tagIds: r.tag_ids,
    closedAt: iso(r.closed_at),
    version: r.version,
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: iso(r.deleted_at),
  };
}

function scopeOf(t: TenantRequestContext, action: RecordAction): RecordScope {
  return recordScope(t.authz, action, 'core.task');
}

/** Giving a task to a user or queue other than oneself is a reassignment (Matrix A A13). */
function assertAssignable(t: TenantRequestContext, owner: { type: 'user' | 'queue'; id: string } | null, assignee: string | null): void {
  const me = t.principal.userId;
  if (owner && !(owner.type === 'user' && owner.id === me) && !canAssignTo(t, 'core.task', owner.type === 'user' ? { userId: owner.id } : { queueId: owner.id })) {
    throw new ProblemError('FORBIDDEN', 'assigning tasks to others requires the reassign permission for that person or queue');
  }
  if (assignee !== null && assignee !== me && !canAssignTo(t, 'core.task', { userId: assignee })) {
    throw new ProblemError('FORBIDDEN', 'assigning tasks to others requires the reassign permission for that person');
  }
}

@Injectable()
export class TasksService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  ctx(t: TenantRequestContext) {
    return dbCtx(t);
  }

  async viewContext(tx: Db): Promise<ViewContext> {
    const defs = await loadFieldDefs(tx, 'task');
    return { defs, formulas: compileFormulas(defs) };
  }

  /** Reads one task through the caller's read scope; invisible (other tenant, other owner, deleted) → 404. */
  async readRow(tx: Db, t: TenantRequestContext, id: string, opts: { includeDeleted?: boolean; forUpdate?: boolean } = {}): Promise<TaskRow> {
    const r = await tx.execute<TaskRow>(sql`${TASK_SELECT}
      WHERE t.id = ${id} AND ${await taskReadPredicate(tx, t)} ${opts.includeDeleted ? sql`` : sql`AND t.deleted_at IS NULL`}
      ${opts.forUpdate ? sql`FOR UPDATE OF t` : sql``}`);
    const row = r.rows[0];
    if (!row) throw new ProblemError('NOT_FOUND');
    return hydrate(row);
  }

  async get(t: TenantRequestContext, id: string) {
    return this.db.withTenant(this.ctx(t), async (tx) => toView(await this.readRow(tx, t, id), await this.viewContext(tx)));
  }

  // ---------------------------------------------------------------- create
  async create(t: TenantRequestContext, body: Create, extra: { seriesId?: string; occurrenceIndex?: number; dueAt?: Date } = {}) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      const id = await this.insertTask(tx, t, body, extra);
      return toView(await this.readRow(tx, t, id), await this.viewContext(tx));
    });
  }

  async insertTask(tx: Db, t: TenantRequestContext, body: Create, extra: { seriesId?: string; occurrenceIndex?: number; dueAt?: Date }): Promise<string> {
    const me = t.principal.userId;
    const createScope = scopeOf(t, 'create');
    if (createScope.kind === 'none') throw new ProblemError('FORBIDDEN');
    const owner = body.owner ?? { type: 'user' as const, id: me };
    const assignee = body.assigneeUserId ?? null;
    // Giving a task to someone else is a reassignment (Matrix A A13); until teams exist (P4) only a
    // tenant-wide grant may do it.
    assertAssignable(t, owner, assignee);

    const wf = await this.workflowFor(tx, body.workflowId ?? null);
    const initial = wf.statuses.find((s) => s.isInitial);
    if (!initial) throw new ProblemError('WORKFLOW_INVALID', 'workflow has no initial status');
    if (body.parentId) await this.readRow(tx, t, body.parentId);
    const segment = body.related ? await this.assertRelated(tx, t, body.related) : null;
    const defs = await loadFieldDefs(tx, 'task');
    const custom = Object.fromEntries(Object.entries(await validateCustom(tx, defs, body.custom ?? {}, 'create')).filter(([, v]) => v !== null));
    const position = keyBetween(await this.lastPosition(tx, initial.id), null);
    const dueAt = extra.dueAt ?? (body.dueAt ? new Date(body.dueAt) : null);
    const startAt = body.startAt ? new Date(body.startAt) : null;
    if (startAt && dueAt && startAt > dueAt) throw new ProblemError('VALIDATION_FAILED', 'startAt must not be after dueAt');

    try {
      const row = one(await tx.insert(schema.tasks).values({
        tenantId: t.tenant.id,
        title: body.title,
        description: body.description ?? null,
        descriptionText: body.descriptionText ?? null,
        workflowId: wf.id,
        statusId: initial.id,
        priority: body.priority ?? 2,
        ownerType: owner.type,
        ownerId: owner.id,
        ownerUserId: owner.type === 'user' ? owner.id : null,
        queueId: owner.type === 'queue' ? owner.id : null,
        assigneeUserId: assignee,
        startAt,
        dueAt,
        estimateMinutes: body.estimateMinutes ?? null,
        parentId: body.parentId ?? null,
        position,
        relatedType: body.related?.type ?? null,
        relatedId: body.related?.id ?? null,
        segment,
        seriesId: extra.seriesId ?? null,
        occurrenceIndex: extra.occurrenceIndex ?? null,
        custom,
        createdBy: me,
        updatedBy: me,
      }).returning({ id: schema.tasks.id }), 'task');
      if (body.tagIds?.length) await tx.insert(schema.taskTags).values(body.tagIds.map((tagId) => ({ tenantId: t.tenant.id, taskId: row.id, tagId })));
      await recordActivity(tx, t, { type: 'task', id: row.id, kind: 'created' });
      await this.notifyAssignees(tx, t, row.id, [owner.type === 'user' ? owner.id : null, assignee]);
      return row.id;
    } catch (e) {
      const c = (e as { cause?: { constraint?: string } }).cause;
      if (c?.constraint === 'tasks_tenant_id_owner_user_id_fkey' || c?.constraint === 'tasks_tenant_id_queue_id_fkey' || c?.constraint === 'tasks_tenant_id_assignee_user_id_fkey') {
        throw new ProblemError('OWNER_INVALID', 'owner/assignee is not a member or queue of this workspace');
      }
      return mapDbError(e);
    }
  }

  // ---------------------------------------------------------------- update / delete / restore
  async patch(t: TenantRequestContext, id: string, version: number, body: Patch) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      const row = await this.readRow(tx, t, id, { forUpdate: true });
      await this.applyPatch(tx, t, row, version, body);
      return toView(await this.readRow(tx, t, id), await this.viewContext(tx));
    });
  }

  /** Patch / transition inside an existing transaction without If-Match (automation actions). */
  async patchIn(tx: Db, t: TenantRequestContext, id: string, body: Patch): Promise<void> {
    const row = await this.readRow(tx, t, id, { forUpdate: true });
    await this.applyPatch(tx, t, row, null, body);
  }

  async transitionByKeyIn(tx: Db, t: TenantRequestContext, id: string, transitionKey: string): Promise<void> {
    await this.transitionIn(tx, t, id, { transitionKey }, undefined);
  }

  private async applyPatch(tx: Db, t: TenantRequestContext, row: TaskRow, version: number | null, body: Patch, statusChange?: { statusId: string; closedAt: Date | null }): Promise<void> {
    const me = t.principal.userId;
    await assertCan(tx, t, TASK_SHAPE, row.id, 'update');
    if (version !== null && row.version !== version) throw new ProblemError('PRECONDITION_FAILED', 'the task was changed by someone else', { currentVersion: row.version });
    const ownerChange = body.owner !== undefined && (body.owner.type !== row.owner_type || body.owner.id !== row.owner_id);
    const assigneeChange = body.assigneeUserId !== undefined && body.assigneeUserId !== row.assignee_user_id;
    assertAssignable(t, ownerChange && body.owner ? body.owner : null, assigneeChange ? (body.assigneeUserId ?? null) : null);
    if (body.parentId) await this.readRow(tx, t, body.parentId);
    const relatedSegment = body.related ? await this.assertRelated(tx, t, body.related) : null;
    let custom: Record<string, unknown> | undefined;
    if (body.custom) {
      const defs = await loadFieldDefs(tx, 'task');
      const changes = await validateCustom(tx, defs, body.custom, 'update');
      const merged = { ...row.custom, ...changes };
      custom = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null));
    }
    const startAt = body.startAt !== undefined ? (body.startAt ? new Date(body.startAt) : null) : row.start_at;
    const dueAt = body.dueAt !== undefined ? (body.dueAt ? new Date(body.dueAt) : null) : row.due_at;
    if (startAt && dueAt && startAt > dueAt) throw new ProblemError('VALIDATION_FAILED', 'startAt must not be after dueAt');

    const set: Partial<typeof schema.tasks.$inferInsert> = { updatedBy: me, version: row.version + 1 };
    if (body.title !== undefined) set.title = body.title;
    if (body.description !== undefined) set.description = body.description;
    if (body.descriptionText !== undefined) set.descriptionText = body.descriptionText;
    if (body.priority !== undefined) set.priority = body.priority;
    if (body.owner !== undefined) {
      set.ownerType = body.owner.type;
      set.ownerId = body.owner.id;
      set.ownerUserId = body.owner.type === 'user' ? body.owner.id : null;
      set.queueId = body.owner.type === 'queue' ? body.owner.id : null;
    }
    if (body.assigneeUserId !== undefined) set.assigneeUserId = body.assigneeUserId;
    if (body.startAt !== undefined) set.startAt = startAt;
    if (body.dueAt !== undefined) set.dueAt = dueAt;
    if (body.estimateMinutes !== undefined) set.estimateMinutes = body.estimateMinutes;
    if (body.parentId !== undefined) set.parentId = body.parentId;
    if (body.related !== undefined) {
      set.relatedType = body.related?.type ?? null;
      set.relatedId = body.related?.id ?? null;
      // A task linked to a segment-bound record inherits its segment (ADR-0010), so it is hidden with it.
      set.segment = relatedSegment;
    }
    if (custom) set.custom = custom;
    if (statusChange) {
      set.statusId = statusChange.statusId;
      set.closedAt = statusChange.closedAt;
    }
    try {
      const updated = await tx.update(schema.tasks).set(set)
        .where(and(eq(schema.tasks.id, row.id), eq(schema.tasks.version, row.version))).returning({ id: schema.tasks.id });
      if (updated.length === 0) throw new ProblemError('PRECONDITION_FAILED', 'the task was changed by someone else');
      if (body.tagIds) {
        await tx.delete(schema.taskTags).where(eq(schema.taskTags.taskId, row.id));
        if (body.tagIds.length) await tx.insert(schema.taskTags).values(body.tagIds.map((tagId) => ({ tenantId: t.tenant.id, taskId: row.id, tagId })));
      }
      // Timeline diff in API terms; the post-update row is read without the read predicate (it may have been given away).
      const vc = await this.viewContext(tx);
      const after = await tx.execute<TaskRow>(sql`${TASK_SELECT} WHERE t.id = ${row.id}`);
      const afterRow = after.rows[0];
      if (afterRow) await recordActivity(tx, t, { type: 'task', id: row.id, kind: 'field_changed', diff: viewDiff(toView(row, vc), toView(hydrate(afterRow), vc)) });
      await this.notifyAssignees(tx, t, row.id, [
        ownerChange && body.owner?.type === 'user' ? body.owner.id : null,
        assigneeChange ? (body.assigneeUserId ?? null) : null,
      ]);
    } catch (e) {
      if (e instanceof ProblemError) throw e;
      const c = (e as { cause?: { constraint?: string } }).cause;
      if (c?.constraint?.startsWith('tasks_tenant_id_owner') || c?.constraint?.startsWith('tasks_tenant_id_queue') || c?.constraint?.startsWith('tasks_tenant_id_assignee')) {
        throw new ProblemError('OWNER_INVALID', 'owner/assignee is not a member or queue of this workspace');
      }
      mapDbError(e);
    }
  }

  async remove(t: TenantRequestContext, id: string, version: number): Promise<void> {
    await this.db.withTenant(this.ctx(t), async (tx) => {
      const row = await this.readRow(tx, t, id, { forUpdate: true });
      await assertCan(tx, t, TASK_SHAPE, row.id, 'archive');
      if (row.version !== version) throw new ProblemError('PRECONDITION_FAILED', 'the task was changed by someone else', { currentVersion: row.version });
      await tx.update(schema.tasks).set({ deletedAt: new Date(), version: row.version + 1, updatedBy: t.principal.userId }).where(eq(schema.tasks.id, id));
      await recordActivity(tx, t, { type: 'task', id, kind: 'deleted' });
    });
  }

  async restore(t: TenantRequestContext, id: string) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      const row = await this.readRow(tx, t, id, { includeDeleted: true, forUpdate: true });
      await assertCan(tx, t, TASK_SHAPE, row.id, 'archive');
      if (row.deleted_at) {
        await tx.update(schema.tasks).set({ deletedAt: null, version: row.version + 1, updatedBy: t.principal.userId }).where(eq(schema.tasks.id, id));
        await recordActivity(tx, t, { type: 'task', id, kind: 'restored' });
      }
      return toView(await this.readRow(tx, t, id), await this.viewContext(tx));
    });
  }

  // ---------------------------------------------------------------- workflow transitions
  async transition(t: TenantRequestContext, id: string, body: z.infer<typeof TaskTransitionRequest>) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      await this.transitionIn(tx, t, id, 'transitionKey' in body ? { transitionKey: body.transitionKey } : { toStatusId: body.toStatusId }, body.fields);
      return toView(await this.readRow(tx, t, id), await this.viewContext(tx));
    });
  }

  private async transitionIn(tx: Db, t: TenantRequestContext, id: string, target: { transitionKey: string } | { toStatusId: string }, fields: Patch | undefined): Promise<void> {
    const me = t.principal.userId;
    let row = await this.readRow(tx, t, id, { forUpdate: true });
    await assertCan(tx, t, TASK_SHAPE, row.id, 'update');
    if (fields) {
      await this.applyPatch(tx, t, row, null, fields);
      row = await this.readRow(tx, t, id, { forUpdate: true });
    }
    const wf = await this.workflowFor(tx, row.workflow_id);
    const counts = await tx.execute<{ open_subtasks: number; open_blockers: number }>(sql`
      SELECT (SELECT count(*)::int FROM tasks c JOIN statuses cs ON cs.tenant_id = c.tenant_id AND cs.id = c.status_id
               WHERE c.parent_id = ${id} AND c.deleted_at IS NULL AND cs.category <> 'closed') AS open_subtasks,
             (SELECT count(*)::int FROM task_dependencies d JOIN tasks b ON b.tenant_id = d.tenant_id AND b.id = d.blocker_id
               JOIN statuses bs ON bs.tenant_id = b.tenant_id AND bs.id = b.status_id
               WHERE d.blocked_id = ${id} AND b.deleted_at IS NULL AND bs.category <> 'closed') AS open_blockers`);
    const facts = {
      actorUserId: me,
      actorRoleKeys: t.authz.roleKeys,
      ownerUserId: row.owner_user_id,
      record: this.factRecord(row),
      openSubtaskCount: counts.rows[0]?.open_subtasks ?? 0,
      openBlockerCount: counts.rows[0]?.open_blockers ?? 0,
    };
    const result = resolveTransition(wf.engine, row.status_id, target, facts);
    if (!result.ok) {
      const { code, ...rest } = result;
      throw new ProblemError(code, undefined, rest);
    }
    const to = wf.statuses.find((s) => s.id === result.transition.toStatusId);
    if (!to) throw new ProblemError('WORKFLOW_INVALID');
    const fromClosed = row.s_category === 'closed';
    const closing = to.category === 'closed' && !fromClosed;
    const patch: Patch = {};
    for (const [k, v] of Object.entries(result.patch)) {
      if (k === 'assignee_user_id') patch.assigneeUserId = v as string | null;
      else if (k === 'due_at') patch.dueAt = v as string | null;
      else if (k === 'start_at') patch.startAt = v as string | null;
      else if (k === 'priority' && typeof v === 'number') patch.priority = v;
    }
    // Post-functions run with the workflow's authority (configured by an Admin), not the actor's
    // reassign permission, so apply them directly rather than through applyPatch's reassign check.
    await tx.update(schema.tasks).set({
      statusId: to.id,
      closedAt: to.category === 'closed' ? (fromClosed ? row.closed_at : new Date()) : null,
      version: row.version + 1,
      updatedBy: me,
      ...(patch.assigneeUserId !== undefined ? { assigneeUserId: patch.assigneeUserId } : {}),
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt ? new Date(patch.dueAt) : null } : {}),
      ...(patch.startAt !== undefined ? { startAt: patch.startAt ? new Date(patch.startAt) : null } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
    }).where(eq(schema.tasks.id, id));
    await recordActivity(tx, t, { type: 'task', id, kind: 'status_changed', diff: { status: { from: row.s_key, to: to.key } }, data: { transition: result.transition.key } });
    if (closing && row.series_id && row.occurrence_index !== null) await this.materializeNext(tx, t, row);
  }

  /** Users who just became owner or assignee of a task (other than the actor) get an `assigned` notification. */
  private async notifyAssignees(tx: Db, t: TenantRequestContext, id: string, users: (string | null)[]): Promise<void> {
    const targets = [...new Set(users.filter((u): u is string => u !== null && u !== t.principal.userId))];
    if (targets.length === 0) return;
    await recordActivity(tx, t, { type: 'task', id, kind: 'assigned', data: { userIds: targets } });
    await notify(tx, t, { users: targets, kind: 'assigned', sourceType: 'assignment', sourceId: randomUUID(), recordType: 'task', recordId: id });
  }

  private factRecord(r: TaskRow): Record<string, unknown> {
    const rec: Record<string, unknown> = {
      title: r.title, priority: r.priority, assignee_user_id: r.assignee_user_id, due_at: iso(r.due_at), start_at: iso(r.start_at),
      estimate_minutes: r.estimate_minutes, description_text: r.description_text, related_id: r.related_id,
    };
    for (const [k, v] of Object.entries(r.custom)) rec[`custom.${k}`] = v;
    return rec;
  }

  // ---------------------------------------------------------------- ordering
  async move(t: TenantRequestContext, id: string, body: z.infer<typeof TaskMoveRequest>) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      if (body.transitionKey) await this.transitionIn(tx, t, id, { transitionKey: body.transitionKey }, undefined);
      else if (body.toStatusId) await this.transitionIn(tx, t, id, { toStatusId: body.toStatusId }, undefined);
      const row = await this.readRow(tx, t, id, { forUpdate: true });
      await assertCan(tx, t, TASK_SHAPE, row.id, 'update');
      // Positions are compared within the status column; serialise moves per column.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_pos:${row.status_id}`}, 0))`);
      const before = body.beforeId ? (await this.readRow(tx, t, body.beforeId)).position : null;
      const after = body.afterId ? (await this.readRow(tx, t, body.afterId)).position : null;
      if (before !== null && after !== null && before >= after) throw new ProblemError('VALIDATION_FAILED', 'beforeId must sort before afterId');
      const position = before === null && after === null ? keyBetween(await this.lastPosition(tx, row.status_id, id), null) : keyBetween(before, after);
      await tx.update(schema.tasks).set({ position, version: row.version + 1, updatedBy: t.principal.userId }).where(eq(schema.tasks.id, id));
      if (needsRebalance(position)) await this.rebalanceColumn(tx, row.status_id);
      return toView(await this.readRow(tx, t, id), await this.viewContext(tx));
    });
  }

  private async lastPosition(tx: Db, statusId: string, excludeId?: string): Promise<string | null> {
    const r = await tx.execute<{ p: string | null }>(sql`SELECT max(position COLLATE "C") AS p FROM tasks
      WHERE status_id = ${statusId} AND deleted_at IS NULL ${excludeId ? sql`AND id <> ${excludeId}` : sql``}`);
    return r.rows[0]?.p ?? null;
  }

  /** Rewrites every position in the column with evenly spaced short keys (ADR-0005 §5). */
  private async rebalanceColumn(tx: Db, statusId: string): Promise<void> {
    const r = await tx.execute<{ id: string }>(sql`SELECT id FROM tasks WHERE status_id = ${statusId} AND deleted_at IS NULL ORDER BY position COLLATE "C", id`);
    const keys = rebalance(r.rows.length);
    for (const [i, row] of r.rows.entries()) {
      const key = keys[i];
      if (key) await tx.update(schema.tasks).set({ position: key }).where(eq(schema.tasks.id, row.id));
    }
  }

  // ---------------------------------------------------------------- hierarchy and dependencies
  async subtasks(t: TenantRequestContext, id: string) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      await this.readRow(tx, t, id);
      const r = await tx.execute<TaskRow>(sql`${TASK_SELECT} WHERE t.parent_id = ${id} AND t.deleted_at IS NULL AND ${await taskReadPredicate(tx, t)} ORDER BY t.position COLLATE "C", t.id`);
      const vc = await this.viewContext(tx);
      const closed = r.rows.filter((x) => x.s_category === 'closed').length;
      return { data: r.rows.map((x) => toView(hydrate(x), vc)), progress: { total: r.rows.length, closed, percent: r.rows.length ? Math.round((closed / r.rows.length) * 1000) / 10 : 0 } };
    });
  }

  async dependencies(t: TenantRequestContext, id: string) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      await this.readRow(tx, t, id);
      const scope = await taskReadPredicate(tx, t);
      const blockers = await tx.execute<{ blocker_id: string; blocked_id: string; created_at: Date }>(sql`
        SELECT d.blocker_id, d.blocked_id, d.created_at FROM task_dependencies d JOIN tasks t ON t.tenant_id = d.tenant_id AND t.id = d.blocker_id
        WHERE d.blocked_id = ${id} AND t.deleted_at IS NULL AND ${scope} ORDER BY d.created_at`);
      const blocking = await tx.execute<{ blocker_id: string; blocked_id: string; created_at: Date }>(sql`
        SELECT d.blocker_id, d.blocked_id, d.created_at FROM task_dependencies d JOIN tasks t ON t.tenant_id = d.tenant_id AND t.id = d.blocked_id
        WHERE d.blocker_id = ${id} AND t.deleted_at IS NULL AND ${scope} ORDER BY d.created_at`);
      const v = (x: { blocker_id: string; blocked_id: string; created_at: Date }) => ({ blockerId: x.blocker_id, blockedId: x.blocked_id, createdAt: new Date(x.created_at).toISOString() });
      return { blockers: blockers.rows.map(v), blocking: blocking.rows.map(v) };
    });
  }

  async addDependency(t: TenantRequestContext, blockedId: string, blockerId: string) {
    return this.db.withTenant(this.ctx(t), async (tx) => {
      const blocked = await this.readRow(tx, t, blockedId, { forUpdate: true });
      await assertCan(tx, t, TASK_SHAPE, blocked.id, 'update');
      await this.readRow(tx, t, blockerId);
      if (blockerId === blockedId) throw new ProblemError('DEPENDENCY_CYCLE', undefined, { cycle: [blockerId, blockedId] });
      // Same lock as the database trigger: the reachability check and the insert see a stable graph.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task_deps:${t.tenant.id}`}, 0))`);
      const reach = await tx.execute<{ blocker_id: string; blocked_id: string }>(sql`
        WITH RECURSIVE reach(id) AS (
          SELECT ${blockedId}::uuid
          UNION
          SELECT d.blocked_id FROM task_dependencies d JOIN reach r ON d.blocker_id = r.id
        ) SELECT d.blocker_id, d.blocked_id FROM task_dependencies d WHERE d.blocker_id IN (SELECT id FROM reach)`);
      const cycle = wouldCreateCycle(reach.rows.map((e) => [e.blocker_id, e.blocked_id] as const), [blockerId, blockedId]);
      if (cycle) throw new ProblemError('DEPENDENCY_CYCLE', undefined, { cycle });
      try {
        const row = one(await tx.insert(schema.taskDependencies).values({ tenantId: t.tenant.id, blockerId, blockedId, createdBy: t.principal.userId }).returning(), 'dependency');
        return { blockerId: row.blockerId, blockedId: row.blockedId, createdAt: row.createdAt.toISOString() };
      } catch (e) {
        return mapDbError(e);
      }
    });
  }

  async removeDependency(t: TenantRequestContext, blockedId: string, blockerId: string): Promise<void> {
    await this.db.withTenant(this.ctx(t), async (tx) => {
      const blocked = await this.readRow(tx, t, blockedId);
      await assertCan(tx, t, TASK_SHAPE, blocked.id, 'update');
      const r = await tx.delete(schema.taskDependencies)
        .where(and(eq(schema.taskDependencies.blockedId, blockedId), eq(schema.taskDependencies.blockerId, blockerId))).returning({ b: schema.taskDependencies.blockerId });
      if (r.length === 0) throw new ProblemError('NOT_FOUND');
    });
  }

  // ---------------------------------------------------------------- bulk
  async bulk(t: TenantRequestContext, body: z.infer<typeof TaskBulkRequest>) {
    const bulkScope = scopeOf(t, 'bulk');
    if (bulkScope.kind === 'none') throw new ProblemError('FORBIDDEN');
    const ids = [...new Set(body.ids)];
    // Matrix A A24 `bulk_limit`: own-scoped bulk work is capped by the tenant policy (default 100).
    if (bulkScope.kind === 'scoped' && !bulkScope.team && ids.length > BULK_MAX_ITEMS_OWN) throw new ProblemError('LIMIT_EXCEEDED', `at most ${BULK_MAX_ITEMS_OWN} items per bulk operation`);
    const results: { id: string; ok: boolean; code?: string }[] = [];
    const one_ = async (tx: Db, id: string) => {
      const row = await this.readRow(tx, t, id, { forUpdate: true });
      await this.applyPatch(tx, t, row, null, body.patch);
    };
    const codeOf = (e: unknown): string => (e instanceof ProblemError ? e.code : 'INTERNAL');
    if (body.atomic) {
      try {
        await this.db.withTenant(this.ctx(t), async (tx) => {
          for (const id of ids) {
            try {
              await one_(tx, id);
              results.push({ id, ok: true });
            } catch (e) {
              results.push({ id, ok: false, code: codeOf(e) });
              throw e;
            }
          }
        });
      } catch (e) {
        if (!(e instanceof ProblemError)) throw e;
        const failed = results.find((r) => !r.ok);
        throw new ProblemError('VALIDATION_FAILED', 'atomic bulk update rolled back', { failedId: failed?.id, failedCode: failed?.code });
      }
    } else {
      for (const id of ids) {
        try {
          await this.db.withTenant(this.ctx(t), (tx) => one_(tx, id));
          results.push({ id, ok: true });
        } catch (e) {
          if (!(e instanceof ProblemError)) throw e;
          results.push({ id, ok: false, code: codeOf(e) });
        }
      }
    }
    const succeeded = results.filter((r) => r.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  // ---------------------------------------------------------------- recurrence (ADR-0020)
  async createSeries(t: TenantRequestContext, body: z.infer<typeof TaskSeriesCreate>) {
    const spec: SeriesSpec = { rrule: body.rrule, dtstartLocal: body.dtstartLocal, tzid: body.tzid };
    try {
      validateSeries(spec);
    } catch (e) {
      if (e instanceof RecurrenceError) throw new ProblemError(e.code, e.message);
      throw e;
    }
    const first = occurrence(spec, 0);
    if (!first) throw new ProblemError('SERIES_EXHAUSTED');
    return this.db.withTenant(this.ctx(t), async (tx) => {
      const series = one(await tx.insert(schema.taskSeries).values({
        tenantId: t.tenant.id, rrule: body.rrule, dtstartLocal: body.dtstartLocal, tzid: body.tzid, catchUp: body.catchUp, active: true, createdBy: t.principal.userId,
      }).returning(), 'series');
      const taskId = await this.insertTask(tx, t, body.task, { seriesId: series.id, occurrenceIndex: 0, dueAt: first });
      const firstTask = toView(await this.readRow(tx, t, taskId), await this.viewContext(tx));
      return { id: series.id, rrule: series.rrule, dtstartLocal: series.dtstartLocal, tzid: series.tzid, catchUp: series.catchUp, active: series.active, firstTask };
    });
  }

  /** Lazily creates the next occurrence when an occurrence closes; the unique (series, index) index makes
   *  double creation impossible even if two closes race. */
  private async materializeNext(tx: Db, t: TenantRequestContext, row: TaskRow): Promise<void> {
    if (!row.series_id || row.occurrence_index === null) return;
    const [series] = await tx.select().from(schema.taskSeries).where(and(eq(schema.taskSeries.id, row.series_id), eq(schema.taskSeries.active, true)));
    if (!series) return;
    const spec: SeriesSpec = { rrule: series.rrule, dtstartLocal: series.dtstartLocal, tzid: series.tzid };
    const next = nextOccurrence(spec, row.occurrence_index, series.catchUp === 'skip_missed' ? new Date() : null);
    if (!next) return;
    const wf = await this.workflowFor(tx, row.workflow_id);
    const initial = wf.statuses.find((s) => s.isInitial);
    if (!initial) return;
    const shift = row.start_at && row.due_at ? row.due_at.getTime() - row.start_at.getTime() : null;
    const position = keyBetween(await this.lastPosition(tx, initial.id), null);
    await tx.execute(sql`
      INSERT INTO tasks (tenant_id, title, description, description_text, workflow_id, status_id, priority, owner_type, owner_id,
                         owner_user_id, queue_id, assignee_user_id, start_at, due_at, estimate_minutes, parent_id, position,
                         related_type, related_id, segment, series_id, occurrence_index, custom, created_by, updated_by)
      SELECT tenant_id, title, description, description_text, workflow_id, ${initial.id}, priority, owner_type, owner_id,
             owner_user_id, queue_id, assignee_user_id, ${shift === null ? null : new Date(next.at.getTime() - shift)}, ${next.at},
             estimate_minutes, parent_id, ${position}, related_type, related_id, segment, series_id, ${next.index}, custom,
             ${t.principal.userId}, ${t.principal.userId}
      FROM tasks WHERE id = ${row.id}
      ON CONFLICT (tenant_id, series_id, occurrence_index) WHERE series_id IS NOT NULL DO NOTHING`);
  }

  // ---------------------------------------------------------------- helpers
  async workflowFor(tx: Db, workflowId: string | null): Promise<{ id: string; statuses: { id: string; key: string; category: 'open' | 'in_progress' | 'closed'; isInitial: boolean }[]; engine: Workflow }> {
    const [wf] = workflowId
      ? await tx.select().from(schema.workflows).where(and(eq(schema.workflows.id, workflowId), eq(schema.workflows.resourceType, 'task')))
      : await tx.select().from(schema.workflows).where(and(eq(schema.workflows.resourceType, 'task'), eq(schema.workflows.isDefault, true)));
    if (!wf) throw new ProblemError(workflowId ? 'NOT_FOUND' : 'WORKFLOW_INVALID', workflowId ? undefined : 'no default task workflow');
    const statuses = await tx.select().from(schema.statuses).where(eq(schema.statuses.workflowId, wf.id));
    const transitions = await tx.select().from(schema.workflowTransitions).where(eq(schema.workflowTransitions.workflowId, wf.id));
    const st = statuses.map((s) => ({ id: s.id, key: s.key, category: s.category, isInitial: s.isInitial }));
    return {
      id: wf.id,
      statuses: st,
      engine: {
        statuses: st,
        transitions: transitions.map((x) => ({
          id: x.id, key: x.key, fromStatusId: x.fromStatusId, toStatusId: x.toStatusId,
          // Stored definitions were validated against the contract schemas when the workflow was created.
          conditions: x.conditions as Condition[], validators: x.validators as Validator[], postFunctions: x.postFunctions as PostFunction[],
        })),
      },
    };
  }

  /** The related record must exist and be readable by the caller (ADR-0005 §1); returns the segment the task inherits. */
  private async assertRelated(tx: Db, t: TenantRequestContext, ref: { type: string; id: string }): Promise<'b2b' | 'b2c' | null> {
    const r = await tx.select({ d: schema.recordRegistry.deletedAt }).from(schema.recordRegistry)
      .where(and(eq(schema.recordRegistry.recordType, ref.type), eq(schema.recordRegistry.recordId, ref.id), isNull(schema.recordRegistry.deletedAt)));
    if (r.length === 0) throw new ProblemError('RELATED_NOT_FOUND');
    const notFound = () => { throw new ProblemError('RELATED_NOT_FOUND'); };
    if (ref.type === 'task') await this.readRow(tx, t, ref.id).catch(notFound);
    else if (isCrmType(ref.type)) await readCrmRow(tx, t, CRM[ref.type], ref.id).catch(notFound);
    else notFound();
    return attachedSegment(tx, ref.type, ref.id);
  }
}
