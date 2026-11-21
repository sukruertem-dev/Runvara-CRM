// P4a authorization tables (migrations/0004_authz.sql).
import { sql } from 'drizzle-orm';
import { boolean, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { segmentEnum } from './schema-tasks';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const SHARE_RESOURCES = ['task', 'account', 'contact', 'lead', 'opportunity', 'case'] as const;

export const userSegmentGrants = pgTable(
  'user_segment_grants',
  {
    tenantId: uuid('tenant_id').notNull(),
    userId: uuid('user_id').notNull(),
    segment: segmentEnum('segment').notNull(),
    validUntil: ts('valid_until'),
    grantedBy: uuid('granted_by'),
    grantedAt: ts('granted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.userId, t.segment] })],
);

export const teams = pgTable('teams', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  parentTeamId: uuid('parent_team_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const teamMembers = pgTable(
  'team_members',
  {
    tenantId: uuid('tenant_id').notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: text('role', { enum: ['member', 'manager'] }).notNull().default('member'),
    addedBy: uuid('added_by'),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.teamId, t.userId] })],
);

export const sharingDefaults = pgTable(
  'sharing_defaults',
  {
    tenantId: uuid('tenant_id').notNull(),
    resourceType: text('resource_type', { enum: SHARE_RESOURCES }).notNull(),
    access: text('access', { enum: ['private', 'read', 'read_write'] }).notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.resourceType] })],
);

export const recordShares = pgTable('record_shares', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  recordType: text('record_type').notNull(),
  recordId: uuid('record_id').notNull(),
  granteeType: text('grantee_type', { enum: ['user', 'team'] }).notNull(),
  granteeId: uuid('grantee_id').notNull(),
  access: text('access', { enum: ['read', 'edit'] }).notNull(),
  source: text('source', { enum: ['manual', 'mention'] }).notNull().default('manual'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const sharingRules = pgTable('sharing_rules', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  resourceType: text('resource_type', { enum: SHARE_RESOURCES }).notNull(),
  name: text('name').notNull(),
  criteria: text('criteria').notNull(),
  granteeTeamId: uuid('grantee_team_id').notNull(),
  access: text('access', { enum: ['read', 'edit'] }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const fieldPolicies = pgTable(
  'field_policies',
  {
    tenantId: uuid('tenant_id').notNull(),
    roleId: uuid('role_id').notNull(),
    resourceType: text('resource_type', { enum: ['account', 'contact', 'lead', 'opportunity', 'case'] }).notNull(),
    field: text('field').notNull(),
    access: text('access', { enum: ['hidden', 'read'] }).notNull(),
    updatedBy: uuid('updated_by'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.roleId, t.resourceType, t.field] })],
);
