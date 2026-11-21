import { z } from 'zod';
import { Uuid } from './schemas';

const IsoDateTime = z.iso.datetime({ offset: true });
const LabelI18n = z.record(z.string().regex(/^[a-z]{2}$/), z.string().min(1).max(120));
const Key = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/);

export const ProseMirrorDoc = z
  .object({ type: z.literal('doc'), content: z.array(z.unknown()).max(2000).optional() })
  .loose()
  .openapi('ProseMirrorDoc');

export const Owner = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), id: Uuid }),
  z.object({ type: z.literal('queue'), id: Uuid }),
]);

export const RelatedRef = z.object({ type: z.string().regex(/^[a-z][a-z_]{1,31}$/), id: Uuid });

const taskWritable = {
  title: z.string().trim().min(1).max(500),
  description: ProseMirrorDoc.nullable(),
  descriptionText: z.string().max(100_000).nullable(),
  priority: z.number().int().min(0).max(4),
  owner: Owner,
  assigneeUserId: Uuid.nullable(),
  startAt: IsoDateTime.nullable(),
  dueAt: IsoDateTime.nullable(),
  estimateMinutes: z.number().int().min(0).max(10_000_000).nullable(),
  related: RelatedRef.nullable(),
  custom: z.record(z.string().regex(/^cf_[a-z0-9_]{1,45}$/), z.unknown()),
};

export const TaskCreate = z
  .object({
    ...taskWritable,
    title: taskWritable.title,
    workflowId: Uuid.optional(),
    parentId: Uuid.nullable().optional(),
    tagIds: z.array(Uuid).max(50).optional(),
  })
  .partial({ description: true, descriptionText: true, priority: true, owner: true, assigneeUserId: true, startAt: true, dueAt: true, estimateMinutes: true, related: true, custom: true })
  .strict()
  .openapi('TaskCreate');

export const TaskPatch = z
  .object({ ...taskWritable, parentId: Uuid.nullable(), tagIds: z.array(Uuid).max(50) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty patch')
  .openapi('TaskPatch');

export const StatusView = z
  .object({ id: Uuid, key: z.string(), category: z.enum(['open', 'in_progress', 'closed']), label: LabelI18n, colorToken: z.string() })
  .openapi('StatusView');

export const TaskView = z
  .object({
    id: Uuid,
    title: z.string(),
    description: ProseMirrorDoc.nullable(),
    descriptionText: z.string().nullable(),
    workflowId: Uuid,
    status: StatusView,
    priority: z.number().int(),
    owner: Owner,
    assigneeUserId: Uuid.nullable(),
    startAt: z.string().nullable(),
    dueAt: z.string().nullable(),
    estimateMinutes: z.number().int().nullable(),
    parentId: Uuid.nullable(),
    depth: z.number().int(),
    position: z.string(),
    related: RelatedRef.nullable(),
    seriesId: Uuid.nullable(),
    occurrenceIndex: z.number().int().nullable(),
    custom: z.record(z.string(), z.unknown()),
    tagIds: z.array(Uuid),
    closedAt: z.string().nullable(),
    version: z.number().int(),
    createdBy: Uuid.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
  })
  .partial()
  .required({ id: true })
  .openapi('TaskView');

export const TaskListResponse = z
  .object({
    data: z.array(TaskView),
    page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
    meta: z.object({ total: z.number().int() }).optional(),
  })
  .openapi('TaskListResponse');

export const TaskTransitionRequest = z
  .union([
    z.object({ transitionKey: Key, fields: TaskPatch.optional() }).strict(),
    z.object({ toStatusId: Uuid, fields: TaskPatch.optional() }).strict(),
  ])
  .openapi('TaskTransitionRequest');

export const TaskMoveRequest = z
  .object({ beforeId: Uuid.nullable().optional(), afterId: Uuid.nullable().optional(), transitionKey: Key.optional(), toStatusId: Uuid.optional() })
  .strict()
  .refine((v) => !(v.transitionKey && v.toStatusId), 'use transitionKey or toStatusId, not both')
  .openapi('TaskMoveRequest');

export const DependencyCreate = z.object({ blockerId: Uuid }).strict().openapi('DependencyCreate');
export const DependencyView = z
  .object({ blockerId: Uuid, blockedId: Uuid, createdAt: z.string() })
  .openapi('DependencyView');
export const DependencyListResponse = z
  .object({ blockers: z.array(DependencyView), blocking: z.array(DependencyView) })
  .openapi('DependencyListResponse');

export const SubtaskListResponse = z
  .object({ data: z.array(TaskView), progress: z.object({ total: z.number().int(), closed: z.number().int(), percent: z.number() }) })
  .openapi('SubtaskListResponse');

export const TaskBulkRequest = z
  .object({
    ids: z.array(Uuid).min(1).max(1000),
    patch: z.object({ priority: taskWritable.priority, assigneeUserId: Uuid.nullable(), dueAt: IsoDateTime.nullable() }).partial().strict(),
    atomic: z.boolean().default(false),
  })
  .strict()
  .refine((v) => Object.keys(v.patch).length > 0, 'empty patch')
  .openapi('TaskBulkRequest');
export const TaskBulkResponse = z
  .object({ results: z.array(z.object({ id: Uuid, ok: z.boolean(), code: z.string().optional() })), succeeded: z.number().int(), failed: z.number().int() })
  .openapi('TaskBulkResponse');

// ------------------------------------------------------------------ workflows
export const TransitionView = z
  .object({ id: Uuid, key: z.string(), label: LabelI18n, fromStatusId: Uuid.nullable(), toStatusId: Uuid, conditions: z.array(z.unknown()), validators: z.array(z.unknown()), postFunctions: z.array(z.unknown()) })
  .openapi('TransitionView');
export const WorkflowView = z
  .object({ id: Uuid, key: z.string(), name: z.string(), resourceType: z.string(), isDefault: z.boolean(), statuses: z.array(StatusView.extend({ isInitial: z.boolean(), position: z.string(), wipLimit: z.number().int().nullable() })), transitions: z.array(TransitionView) })
  .openapi('WorkflowView');
export const WorkflowListResponse = z.object({ data: z.array(WorkflowView) }).openapi('WorkflowListResponse');

const ConditionInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), anyOf: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('is_owner') }),
  z.object({ kind: z.literal('field_present'), field: z.string() }),
  z.object({ kind: z.literal('field_equals'), field: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]) }),
]);
const ValidatorInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('required_fields'), fields: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal('subtasks_closed') }),
  z.object({ kind: z.literal('no_open_blockers') }),
]);
const PostFunctionInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set_field'), field: z.enum(['priority', 'assignee_user_id', 'due_at']), value: z.union([z.string(), z.number(), z.null()]) }),
  z.object({ kind: z.literal('clear_field'), field: z.enum(['assignee_user_id', 'due_at', 'start_at']) }),
  z.object({ kind: z.literal('assign_to_actor') }),
]);

export const WorkflowCreate = z
  .object({
    key: Key,
    name: z.string().trim().min(1).max(120),
    statuses: z.array(z.object({ key: Key, label: LabelI18n, category: z.enum(['open', 'in_progress', 'closed']), colorToken: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).default('text-secondary'), isInitial: z.boolean().default(false), wipLimit: z.number().int().min(1).max(1000).nullable().default(null) })).min(2).max(30),
    transitions: z.array(z.object({ key: Key, label: LabelI18n.default({}), from: Key.nullable(), to: Key, conditions: z.array(ConditionInput).max(10).default([]), validators: z.array(ValidatorInput).max(10).default([]), postFunctions: z.array(PostFunctionInput).max(10).default([]) })).min(1).max(100),
  })
  .strict()
  .openapi('WorkflowCreate');

// ------------------------------------------------------------------ custom fields
export const CustomFieldType = z.enum(['text', 'number', 'date', 'select', 'multi_select', 'user', 'relation', 'formula']);
export const CustomFieldCreate = z
  .object({
    resourceType: z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']),
    key: z.string().regex(/^cf_[a-z0-9_]{1,45}$/),
    type: CustomFieldType,
    label: LabelI18n,
    required: z.boolean().default(false),
    defaultValue: z.unknown().optional(),
    options: z.array(z.object({ id: z.string().regex(/^[a-z0-9_]{1,40}$/), label: LabelI18n })).max(200).default([]),
    relationTarget: z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']).optional(),
    formula: z.string().min(1).max(2000).optional(),
    indexed: z.boolean().default(false),
  })
  .strict()
  .openapi('CustomFieldCreate');
export const CustomFieldView = z
  .object({ id: Uuid, resourceType: z.string(), key: z.string(), type: CustomFieldType, label: LabelI18n, required: z.boolean(), defaultValue: z.unknown(), options: z.array(z.object({ id: z.string(), label: LabelI18n })), relationTarget: z.string().nullable(), formula: z.string().nullable(), indexed: z.boolean(), archived: z.boolean() })
  .openapi('CustomFieldView');
export const CustomFieldListResponse = z.object({ data: z.array(CustomFieldView) }).openapi('CustomFieldListResponse');

// ------------------------------------------------------------------ recurrence
export const TaskSeriesCreate = z
  .object({
    rrule: z.string().min(5).max(500),
    dtstartLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
    tzid: z.string().min(1).max(64),
    catchUp: z.enum(['skip_missed', 'create_next']).default('skip_missed'),
    task: TaskCreate,
  })
  .strict()
  .openapi('TaskSeriesCreate');
export const TaskSeriesView = z
  .object({ id: Uuid, rrule: z.string(), dtstartLocal: z.string(), tzid: z.string(), catchUp: z.string(), active: z.boolean(), firstTask: TaskView })
  .openapi('TaskSeriesView');

// ------------------------------------------------------------------ RQL
export const RqlValidateRequest = z.object({ resource: z.enum(['task', 'account', 'contact', 'lead', 'opportunity', 'case']), q: z.string().max(4096) }).strict().openapi('RqlValidateRequest');
export const RqlValidateResponse = z
  .object({ ok: z.boolean(), error: z.object({ code: z.string(), message: z.string(), position: z.number().int() }).optional() })
  .openapi('RqlValidateResponse');
export const RqlFieldsResponse = z
  .object({ data: z.array(z.object({ name: z.string(), type: z.string(), sortable: z.boolean(), enumValues: z.array(z.string()).optional() })) })
  .openapi('RqlFieldsResponse');
