// P3 CRM tables (migrations/0003_crm.sql).
import { sql } from 'drizzle-orm';
import { boolean, char, customType, date, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { segmentEnum } from './schema-tasks';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => uuid('id').primaryKey().default(sql`uuidv7()`);
const segments = () => segmentEnum('segments').array().notNull();

const audit = {
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
};
const rich = {
  description: jsonb('description'),
  descriptionText: text('description_text'),
  custom: jsonb('custom').$type<Record<string, unknown>>().notNull().default({}),
};

export const accounts = pgTable('accounts', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  domain: citext('domain'),
  website: text('website'),
  industry: text('industry'),
  parentAccountId: uuid('parent_account_id'),
  segments: segments(),
  ownerUserId: uuid('owner_user_id').notNull(),
  ...rich,
  mergedInto: uuid('merged_into'),
  ...audit,
});

export const contacts = pgTable('contacts', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  fullName: text('full_name').generatedAlwaysAs(sql`btrim(first_name || ' ' || last_name)`),
  title: text('title'),
  segments: segments(),
  ownerUserId: uuid('owner_user_id').notNull(),
  ...rich,
  mergedInto: uuid('merged_into'),
  ...audit,
  anonymizedAt: ts('anonymized_at'),
});

export const accountContactRoles = pgTable(
  'account_contact_roles',
  {
    tenantId: uuid('tenant_id').notNull(),
    accountId: uuid('account_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    role: text('role', { enum: ['decision_maker', 'influencer', 'user', 'approver', 'other'] }).notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.accountId, t.contactId] })],
);

export const leads = pgTable('leads', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  firstName: text('first_name').notNull().default(''),
  lastName: text('last_name').notNull().default(''),
  fullName: text('full_name').generatedAlwaysAs(sql`btrim(first_name || ' ' || last_name)`),
  company: text('company'),
  title: text('title'),
  segment: segmentEnum('segment').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  statusId: uuid('status_id').notNull(),
  source: text('source'),
  score: integer('score').notNull().default(0),
  ownerUserId: uuid('owner_user_id'),
  queueId: uuid('queue_id'),
  ...rich,
  convertedAt: ts('converted_at'),
  ...audit,
});

export const pipelines = pgTable('pipelines', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  key: text('key').notNull(),
  name: text('name').notNull(),
  segment: segmentEnum('segment'),
  workflowId: uuid('workflow_id').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    tenantId: uuid('tenant_id').notNull(),
    pipelineId: uuid('pipeline_id').notNull(),
    statusId: uuid('status_id').notNull(),
    probability: numeric('probability', { precision: 5, scale: 2 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.pipelineId, t.statusId] })],
);

export const opportunities = pgTable('opportunities', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  name: text('name').notNull(),
  accountId: uuid('account_id'),
  primaryContactId: uuid('primary_contact_id'),
  pipelineId: uuid('pipeline_id').notNull(),
  workflowId: uuid('workflow_id').notNull(),
  statusId: uuid('status_id').notNull(),
  segment: segmentEnum('segment').notNull(),
  amount: numeric('amount', { precision: 18, scale: 4 }),
  currency: char('currency', { length: 3 }).notNull(),
  probability: numeric('probability', { precision: 5, scale: 2 }).notNull().default('0'),
  probabilityManual: boolean('probability_manual').notNull().default(false),
  expectedClose: date('expected_close'),
  competitor: text('competitor'),
  wonLostReason: text('won_lost_reason'),
  ownerUserId: uuid('owner_user_id').notNull(),
  ...rich,
  closedAt: ts('closed_at'),
  ...audit,
});

export const cases = pgTable('cases', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  subject: text('subject').notNull(),
  accountId: uuid('account_id'),
  contactId: uuid('contact_id'),
  workflowId: uuid('workflow_id').notNull(),
  statusId: uuid('status_id').notNull(),
  priority: smallint('priority').notNull().default(2),
  channel: text('channel', { enum: ['email', 'phone', 'web', 'chat', 'social', 'other'] }).notNull().default('other'),
  category: text('category'),
  queueId: uuid('queue_id'),
  ownerUserId: uuid('owner_user_id'),
  segment: segmentEnum('segment'),
  ...rich,
  closedAt: ts('closed_at'),
  ...audit,
});

export const leadConversions = pgTable(
  'lead_conversions',
  {
    tenantId: uuid('tenant_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    accountId: uuid('account_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    opportunityId: uuid('opportunity_id'),
    convertedBy: uuid('converted_by').notNull(),
    convertedAt: ts('converted_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.leadId] })],
);

export const contactPoints = pgTable('contact_points', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  ownerType: text('owner_type', { enum: ['contact', 'account', 'lead'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  kind: text('kind', { enum: ['phone', 'email'] }).notNull(),
  label: text('label'),
  value: text('value').notNull(),
  e164: text('e164'),
  isPrimary: boolean('is_primary').notNull().default(false),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const notes = pgTable('notes', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  relatedType: text('related_type').notNull(),
  relatedId: uuid('related_id').notNull(),
  body: jsonb('body'),
  bodyText: text('body_text').notNull(),
  visibility: text('visibility', { enum: ['standard', 'private'] }).notNull().default('standard'),
  segment: segmentEnum('segment'),
  authorId: uuid('author_id').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
});

export const merges = pgTable('merges', {
  id: id(),
  tenantId: uuid('tenant_id').notNull(),
  recordType: text('record_type', { enum: ['account', 'contact'] }).notNull(),
  survivorId: uuid('survivor_id').notNull(),
  mergedIds: uuid('merged_ids').array().notNull(),
  fieldChoices: jsonb('field_choices').$type<Record<string, string>>().notNull().default({}),
  moved: jsonb('moved').$type<Record<string, number>>().notNull().default({}),
  mergedBy: uuid('merged_by').notNull(),
  mergedAt: ts('merged_at').notNull().defaultNow(),
});
