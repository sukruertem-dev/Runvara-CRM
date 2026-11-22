// P2 task core tables (migrations/0002_tasks.sql).
import { sql } from 'drizzle-orm';
import { boolean, customType, integer, jsonb, pgEnum, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);

export const segmentEnum = pgEnum('segment', ['b2b', 'b2c']);

export const recordRegistry = pgTable(
  'record_registry',
  {
    tenantId: uuid('tenant_id').notNull(),
    recordType: text('record_type').notNull(),
    recordId: uuid('record_id').notNull(),
    segment: segmentEnum('segment'),
    segments: segmentEnum('segments').array(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.recordType, t.recordId] })],
);

export const queues = pgTable('queues', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['work', 'call'] }).notNull(),
  name: text('name').notNull(),
  segment: segmentEnum('segment'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const queueMembers = pgTable(
  'queue_members',
  {
    tenantId: uuid('tenant_id').notNull(),
    queueId: uuid('queue_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role', { enum: ['member', 'supervisor'] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.queueId, t.userId] })],
);

export const workflows = pgTable('workflows', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  resourceType: text('resource_type').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull(),
  version: integer('version').notNull(),
  segment: segmentEnum('segment'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const statuses = pgTable('statuses', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  key: text('key').notNull(),
  labelI18n: jsonb('label_i18n').$type<Record<string, string>>().notNull(),
  category: text('category', { enum: ['open', 'in_progress', 'closed'] }).notNull(),
  colorToken: text('color_token').notNull(),
  position: text('position').notNull(),
  isInitial: boolean('is_initial').notNull(),
  wipLimit: integer('wip_limit'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const workflowTransitions = pgTable('workflow_transitions', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  key: text('key').notNull(),
  labelI18n: jsonb('label_i18n').$type<Record<string, string>>().notNull(),
  fromStatusId: uuid('from_status_id'),
  toStatusId: uuid('to_status_id').notNull(),
  conditions: jsonb('conditions').$type<unknown[]>().notNull(),
  validators: jsonb('validators').$type<unknown[]>().notNull(),
  postFunctions: jsonb('post_functions').$type<unknown[]>().notNull(),
});

export const taskSeries = pgTable('task_series', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  rrule: text('rrule').notNull(),
  dtstartLocal: text('dtstart_local').notNull(),
  tzid: text('tzid').notNull(),
  catchUp: text('catch_up', { enum: ['skip_missed', 'create_next'] }).notNull(),
  active: boolean('active').notNull(),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export type CustomFieldType = 'text' | 'number' | 'date' | 'select' | 'multi_select' | 'user' | 'relation' | 'formula';

export const customFieldDefinitions = pgTable('custom_field_definitions', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  resourceType: text('resource_type').notNull(),
  key: text('key').notNull(),
  type: text('type', { enum: ['text', 'number', 'date', 'select', 'multi_select', 'user', 'relation', 'formula'] }).notNull(),
  labelI18n: jsonb('label_i18n').$type<Record<string, string>>().notNull(),
  required: boolean('required').notNull(),
  defaultValue: jsonb('default_value'),
  options: jsonb('options').$type<{ id: string; label: Record<string, string> }[]>().notNull(),
  relationTarget: text('relation_target'),
  formula: text('formula'),
  indexed: boolean('indexed').notNull(),
  position: text('position').notNull(),
  archivedAt: ts('archived_at'),
  version: integer('version').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const tasks = pgTable('tasks', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  title: text('title').notNull(),
  description: jsonb('description'),
  descriptionText: text('description_text'),
  workflowId: uuid('workflow_id').notNull(),
  statusId: uuid('status_id').notNull(),
  priority: smallint('priority').notNull(),
  ownerType: text('owner_type', { enum: ['user', 'queue'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  ownerUserId: uuid('owner_user_id'),
  queueId: uuid('queue_id'),
  assigneeUserId: uuid('assignee_user_id'),
  startAt: ts('start_at'),
  dueAt: ts('due_at'),
  estimateMinutes: integer('estimate_minutes'),
  parentId: uuid('parent_id'),
  depth: smallint('depth').notNull().default(0),
  position: text('position').notNull(),
  relatedType: text('related_type'),
  relatedId: uuid('related_id'),
  segment: segmentEnum('segment'),
  seriesId: uuid('series_id'),
  occurrenceIndex: integer('occurrence_index'),
  custom: jsonb('custom').$type<Record<string, unknown>>().notNull(),
  closedAt: ts('closed_at'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    tenantId: uuid('tenant_id').notNull(),
    blockerId: uuid('blocker_id').notNull(),
    blockedId: uuid('blocked_id').notNull(),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.blockerId, t.blockedId] })],
);

export const tags = pgTable('tags', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  name: citext('name').notNull(),
  colorToken: text('color_token').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const taskTags = pgTable(
  'task_tags',
  {
    tenantId: uuid('tenant_id').notNull(),
    taskId: uuid('task_id').notNull(),
    tagId: uuid('tag_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.taskId, t.tagId] })],
);
