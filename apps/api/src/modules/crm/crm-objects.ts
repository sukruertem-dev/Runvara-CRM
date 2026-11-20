import { recordScope, type RecordAction, type RecordResource, type RecordScope } from '@flexa/authz';
import { sql, type Db, type SQL } from '@flexa/db';
import type { Formula } from '@flexa/formula';
import type { FieldRegistry } from '@flexa/query-lang';
import { ProblemError } from '../../common/problem';
import type { TenantRequestContext } from '../../common/request-context';
import { compileFormulas, customFieldRegistry, loadFieldDefs, withFormulas, type FieldDefRow } from '../tasks/task-fields';

// Declarative definitions of the P3 CRM objects (docs/p3-plan.md): table, view query, RQL registry and
// API view. One generic service (crm.service.ts) implements the shared behaviour on top of these.

export type CrmType = 'account' | 'contact' | 'lead' | 'opportunity' | 'case';
export const CRM_TYPES: readonly CrmType[] = ['account', 'contact', 'lead', 'opportunity', 'case'];

/** A row of a definition's `select`: snake_case columns as PostgreSQL returns them from raw queries. */
export type CrmRow = Record<string, unknown> & {
  id: string;
  owner_user_id: string | null;
  created_by: string | null;
  version: number;
  deleted_at: string | null;
  custom: Record<string, unknown>;
};

export interface CrmViewContext {
  defs: FieldDefRow[];
  formulas: Map<string, Formula>;
}

export interface CrmDef {
  type: CrmType;
  resource: RecordResource;
  table: 'accounts' | 'contacts' | 'leads' | 'opportunities' | 'cases';
  /** Records move through a configured workflow (statuses + transitions). */
  workflow: boolean;
  /** Identity records carry `segments[]`; transactional ones a single `segment`. */
  identity: boolean;
  /** Table (alias t) plus the status join for workflow objects. */
  from: SQL;
  select: SQL;
  baseRegistry: FieldRegistry;
  view(row: CrmRow, vc: CrmViewContext): Record<string, unknown>;
  /** Display name used by duplicate detection and merge results. */
  displayName(row: CrmRow): string;
}

/** Scalar column value as text ('' for null/objects); raw rows are untyped. */
export const asText = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : '');
export const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(asText(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : asText(v));
const num = (v: unknown): number => Number(v);
/** Money: numeric(18,4) arrives as text; trailing zeros are trimmed to two decimals ("1500.00"). */
const money = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const [i, f = ''] = asText(v).split('.');
  const frac = f.replace(/0+$/, '');
  return `${i ?? '0'}.${frac.padEnd(2, '0')}`;
};

const contactPointsAgg = (ownerType: 'account' | 'contact' | 'lead') => sql`
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id', cp.id, 'kind', cp.kind, 'value', cp.value, 'e164', cp.e164, 'label', cp.label,
                                                'isPrimary', cp.is_primary) ORDER BY cp.is_primary DESC, cp.created_at, cp.id), '[]'::jsonb)
   FROM contact_points cp WHERE cp.tenant_id = t.tenant_id AND cp.owner_type = ${ownerType} AND cp.owner_id = t.id) AS contact_points`;

const statusCols = sql`s.key AS s_key, s.category AS s_category, s.label_i18n AS s_label, s.color_token AS s_color`;
const statusJoin = sql`JOIN statuses s ON s.tenant_id = t.tenant_id AND s.id = t.status_id`;
const statusView = (r: CrmRow) => ({ id: r.status_id, key: r.s_key, category: r.s_category, label: r.s_label, colorToken: r.s_color });

const metaView = (r: CrmRow) => ({
  version: r.version,
  createdBy: r.created_by,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  deletedAt: iso(r.deleted_at),
});

const reg = {
  text: (col: string, sortable = true, nullable = true) => ({ sql: sql.raw(`t.${col}`), type: 'text' as const, sortable, nullable }),
  number: (col: string, sortable = true, nullable = true) => ({ sql: sql.raw(`t.${col}`), type: 'number' as const, sortable, nullable }),
  user: (col: string) => ({ sql: sql.raw(`t.${col}`), type: 'user' as const, sortable: false }),
  uuid: (col: string) => ({ sql: sql.raw(`t.${col}`), type: 'uuid' as const, sortable: false }),
  datetime: (col: string, nullable = true) => ({ sql: sql.raw(`t.${col}`), type: 'datetime' as const, sortable: true, nullable }),
  date: (col: string) => ({ sql: sql.raw(`t.${col}`), type: 'date' as const, sortable: true }),
};
const commonRegistry: FieldRegistry = {
  owner: reg.user('owner_user_id'),
  createdBy: reg.user('created_by'),
  created: reg.datetime('created_at', false),
  updated: reg.datetime('updated_at', false),
};
const statusRegistry: FieldRegistry = {
  status: { sql: sql`s.key`, type: 'text', sortable: false, nullable: false },
  statusCategory: { sql: sql`s.category`, type: 'enum', enumValues: ['open', 'in_progress', 'closed'], sortable: true, nullable: false },
};
const segmentEnum = { type: 'enum' as const, enumValues: ['b2b', 'b2c'] };

function custom(r: CrmRow, vc: CrmViewContext, scalars: Record<string, unknown>): Record<string, unknown> {
  return withFormulas(vc.defs, vc.formulas, scalars, r.custom);
}

export const CRM: Readonly<Record<CrmType, CrmDef>> = {
  account: {
    type: 'account',
    resource: 'crm.account',
    table: 'accounts',
    workflow: false,
    identity: true,
    from: sql`accounts t`,
    select: sql`SELECT t.*, to_jsonb(t.segments) AS segs, ${contactPointsAgg('account')} FROM accounts t`,
    baseRegistry: {
      ...commonRegistry,
      name: reg.text('name', true, false),
      domain: reg.text('domain'),
      industry: reg.text('industry'),
      parent: reg.uuid('parent_account_id'),
    },
    view: (r, vc) => ({
      id: r.id, name: r.name, domain: str(r.domain), website: str(r.website), industry: str(r.industry), parentAccountId: str(r.parent_account_id),
      segments: r.segs, ownerUserId: r.owner_user_id, description: r.description ?? null, descriptionText: str(r.description_text),
      custom: custom(r, vc, { name: r.name, created_at: iso(r.created_at) }), mergedInto: str(r.merged_into), contactPoints: r.contact_points, ...metaView(r),
    }),
    displayName: (r) => asText(r.name),
  },
  contact: {
    type: 'contact',
    resource: 'crm.contact',
    table: 'contacts',
    workflow: false,
    identity: true,
    from: sql`contacts t`,
    select: sql`SELECT t.*, to_jsonb(t.segments) AS segs, ${contactPointsAgg('contact')},
      (SELECT coalesce(jsonb_agg(jsonb_build_object('accountId', acr.account_id, 'role', acr.role, 'isPrimary', acr.is_primary)
                                 ORDER BY acr.is_primary DESC, acr.created_at), '[]'::jsonb)
       FROM account_contact_roles acr WHERE acr.tenant_id = t.tenant_id AND acr.contact_id = t.id) AS account_roles
      FROM contacts t`,
    baseRegistry: {
      ...commonRegistry,
      name: reg.text('full_name', true, false),
      firstName: reg.text('first_name', true, false),
      lastName: reg.text('last_name', true, false),
      title: reg.text('title'),
      account: { sql: sql`(SELECT acr.account_id FROM account_contact_roles acr WHERE acr.tenant_id = t.tenant_id AND acr.contact_id = t.id ORDER BY acr.is_primary DESC, acr.created_at LIMIT 1)`, type: 'uuid', sortable: false },
    },
    view: (r, vc) => ({
      id: r.id, firstName: r.first_name, lastName: r.last_name, fullName: r.full_name, title: str(r.title), segments: r.segs,
      ownerUserId: r.owner_user_id, description: r.description ?? null, descriptionText: str(r.description_text),
      custom: custom(r, vc, { first_name: r.first_name, last_name: r.last_name, created_at: iso(r.created_at) }), mergedInto: str(r.merged_into),
      accounts: r.account_roles, contactPoints: r.contact_points, ...metaView(r),
    }),
    displayName: (r) => asText(r.full_name),
  },
  lead: {
    type: 'lead',
    resource: 'crm.lead',
    table: 'leads',
    workflow: true,
    identity: false,
    from: sql`leads t ${statusJoin}`,
    select: sql`SELECT t.*, ${statusCols}, ${contactPointsAgg('lead')} FROM leads t ${statusJoin}`,
    baseRegistry: {
      ...commonRegistry,
      ...statusRegistry,
      name: reg.text('full_name', true, false),
      company: reg.text('company'),
      source: reg.text('source'),
      score: reg.number('score', true, false),
      queue: reg.uuid('queue_id'),
      segment: { sql: sql`t.segment::text`, ...segmentEnum, sortable: true, nullable: false },
      converted: reg.datetime('converted_at'),
    },
    view: (r, vc) => ({
      id: r.id, firstName: r.first_name, lastName: r.last_name, fullName: r.full_name, company: str(r.company), title: str(r.title),
      segment: r.segment, workflowId: r.workflow_id, status: statusView(r), source: str(r.source), score: r.score, ownerUserId: str(r.owner_user_id),
      queueId: str(r.queue_id), description: r.description ?? null, descriptionText: str(r.description_text),
      custom: custom(r, vc, { score: r.score, created_at: iso(r.created_at) }), convertedAt: iso(r.converted_at), contactPoints: r.contact_points, ...metaView(r),
    }),
    displayName: (r) => asText(r.full_name) || asText(r.company),
  },
  opportunity: {
    type: 'opportunity',
    resource: 'crm.opportunity',
    table: 'opportunities',
    workflow: true,
    identity: false,
    from: sql`opportunities t ${statusJoin}`,
    select: sql`SELECT t.*, ${statusCols} FROM opportunities t ${statusJoin}`,
    baseRegistry: {
      ...commonRegistry,
      ...statusRegistry,
      name: reg.text('name', true, false),
      account: reg.uuid('account_id'),
      contact: reg.uuid('primary_contact_id'),
      pipeline: reg.uuid('pipeline_id'),
      amount: reg.number('amount'),
      currency: reg.text('currency', false, false),
      probability: reg.number('probability', true, false),
      expectedClose: reg.date('expected_close'),
      closed: reg.datetime('closed_at'),
      segment: { sql: sql`t.segment::text`, ...segmentEnum, sortable: true, nullable: false },
    },
    view: (r, vc) => ({
      id: r.id, name: r.name, accountId: str(r.account_id), primaryContactId: str(r.primary_contact_id), pipelineId: r.pipeline_id, workflowId: r.workflow_id,
      status: statusView(r), segment: r.segment, amount: money(r.amount), currency: r.currency, probability: num(r.probability),
      probabilityManual: r.probability_manual, expectedClose: str(r.expected_close), competitor: str(r.competitor), wonLostReason: str(r.won_lost_reason),
      ownerUserId: r.owner_user_id, description: r.description ?? null, descriptionText: str(r.description_text),
      custom: custom(r, vc, { amount: r.amount === null ? null : num(r.amount), probability: num(r.probability), expected_close: str(r.expected_close), created_at: iso(r.created_at), closed_at: iso(r.closed_at) }),
      closedAt: iso(r.closed_at), ...metaView(r),
    }),
    displayName: (r) => asText(r.name),
  },
  case: {
    type: 'case',
    resource: 'crm.case',
    table: 'cases',
    workflow: true,
    identity: false,
    from: sql`cases t ${statusJoin}`,
    select: sql`SELECT t.*, ${statusCols} FROM cases t ${statusJoin}`,
    baseRegistry: {
      ...commonRegistry,
      ...statusRegistry,
      subject: reg.text('subject', true, false),
      account: reg.uuid('account_id'),
      contact: reg.uuid('contact_id'),
      priority: reg.number('priority', true, false),
      channel: { sql: sql`t.channel`, type: 'enum', enumValues: ['email', 'phone', 'web', 'chat', 'social', 'other'], sortable: true, nullable: false },
      category: reg.text('category'),
      queue: reg.uuid('queue_id'),
      closed: reg.datetime('closed_at'),
      segment: { sql: sql`t.segment::text`, ...segmentEnum, sortable: true },
    },
    view: (r, vc) => ({
      id: r.id, subject: r.subject, accountId: str(r.account_id), contactId: str(r.contact_id), workflowId: r.workflow_id, status: statusView(r),
      priority: r.priority, channel: r.channel, category: str(r.category), ownerUserId: str(r.owner_user_id), queueId: str(r.queue_id),
      segment: r.segment ?? null, description: r.description ?? null, descriptionText: str(r.description_text),
      custom: custom(r, vc, { priority: r.priority, created_at: iso(r.created_at), closed_at: iso(r.closed_at) }), closedAt: iso(r.closed_at), ...metaView(r),
    }),
    displayName: (r) => asText(r.subject),
  },
};

export function isCrmType(v: string): v is CrmType {
  return (CRM_TYPES as readonly string[]).includes(v);
}

export function crmRegistry(def: CrmDef, defs: readonly FieldDefRow[]): FieldRegistry {
  return { ...def.baseRegistry, ...customFieldRegistry(defs, 't') };
}

export async function crmViewContext(tx: Db, type: CrmType): Promise<CrmViewContext> {
  const defs = await loadFieldDefs(tx, type);
  return { defs, formulas: compileFormulas(defs) };
}

export function crmScope(t: TenantRequestContext, def: CrmDef, action: RecordAction): RecordScope {
  return recordScope(t.authz, action, def.resource);
}

/** Record scope as SQL on alias t (ADR-0004): `own` = owner or creator. Team/queue scopes arrive in P4. */
export function crmScopeSql(scope: RecordScope, userId: string): SQL {
  if (scope.kind === 'all') return sql`TRUE`;
  if (scope.kind === 'none') return sql`FALSE`;
  return sql`(t.owner_user_id = ${userId} OR t.created_by = ${userId})`;
}

export function isOwnRecord(row: Pick<CrmRow, 'owner_user_id' | 'created_by'>, userId: string): boolean {
  return row.owner_user_id === userId || row.created_by === userId;
}

/** Visible-but-forbidden → 403 (the caller already turned invisible into 404). */
export function assertRecordAllowed(scope: RecordScope, row: Pick<CrmRow, 'owner_user_id' | 'created_by'>, userId: string): void {
  if (scope.kind === 'all') return;
  if (scope.kind === 'own' && isOwnRecord(row, userId)) return;
  throw new ProblemError('FORBIDDEN');
}

/** Reads one CRM record through RLS (tenant + segment) and the caller's read scope; invisible → 404. */
export async function readCrmRow(
  tx: Db,
  t: TenantRequestContext,
  def: CrmDef,
  id: string,
  opts: { includeDeleted?: boolean; forUpdate?: boolean } = {},
): Promise<CrmRow> {
  const scope = crmScope(t, def, 'read');
  if (scope.kind === 'none') throw new ProblemError('NOT_FOUND');
  const r = await tx.execute<CrmRow>(sql`${def.select}
      WHERE t.id = ${id} AND ${crmScopeSql(scope, t.principal.userId)} ${opts.includeDeleted ? sql`` : sql`AND t.deleted_at IS NULL`}
      ${opts.forUpdate ? sql`FOR UPDATE OF t` : sql``}`);
  const row = r.rows[0];
  if (!row) throw new ProblemError('NOT_FOUND');
  return row;
}

/** Segment a record contributes to things attached to it (tasks, notes): its own single segment, or the
 *  only segment of an identity record; null when it spans both. */
export async function attachedSegment(tx: Db, type: string, id: string): Promise<'b2b' | 'b2c' | null> {
  const r = await tx.execute<{ segment: 'b2b' | 'b2c' | null; segments: string | null }>(sql`
    SELECT segment, segments::text AS segments FROM record_registry WHERE record_type = ${type} AND record_id = ${id}`);
  const row = r.rows[0];
  if (!row) return null;
  if (row.segment) return row.segment;
  const segs = (row.segments ?? '').replace(/[{}]/g, '').split(',').filter(Boolean);
  return segs.length === 1 ? (segs[0] as 'b2b' | 'b2c') : null;
}
