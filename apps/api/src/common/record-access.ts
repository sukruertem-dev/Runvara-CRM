import { recordScope, type RecordAction, type RecordResource } from '@flexa/authz';
import { sql, type Db, type SQL } from '@flexa/db';
import { compileQuery, type FieldRegistry } from '@flexa/query-lang';
import { ProblemError } from './problem';
import type { TenantRequestContext } from './request-context';

// The record-level half of the authorization engine (ADR-0004, docs/p4-plan.md §3–§5): one place that turns
// a role's scope plus the widening terms (role hierarchy, organisation-wide defaults, record shares, sharing
// rules) into a SQL predicate on alias `t`. Lists, counts, single reads and write checks all use it, so the
// answer is the same on every surface and pagination/counts are exact (no filtering after the query).

export type ShareType = 'task' | 'account' | 'contact' | 'lead' | 'opportunity' | 'case';
export type OwdAccess = 'private' | 'read' | 'read_write';
export type FieldAccess = 'hidden' | 'read';

export interface SharingRuleInfo {
  id: string;
  resourceType: ShareType;
  criteria: string;
  access: 'read' | 'edit';
}

/** Loaded once per request by TenantGuard from the database (no cache: a change applies on the next request). */
export interface AccessInfo {
  roleIds: string[];
  /** Teams the user belongs to (any role). */
  teamIds: string[];
  /** Teams the user manages, including all their sub-teams. */
  managedTeamIds: string[];
  /** Members of the user's teams and of every managed team (the `team` scope). */
  teamMemberIds: string[];
  /** Members of managed teams only (targets a Manager may administer, `managed_teams_only`). */
  managedMemberIds: string[];
  queueIds: string[];
  /** Holders of roles below the user's roles in the role hierarchy. */
  subordinateUserIds: string[];
  owd: Partial<Record<ShareType, OwdAccess>>;
  /** Enabled sharing rules whose grantee team the user belongs to. */
  rules: SharingRuleInfo[];
  /** Effective field policy per resource (widest over the user's roles); absent field = writable. */
  fields: Partial<Record<ShareType, Record<string, FieldAccess>>>;
}

export const EMPTY_ACCESS: AccessInfo = {
  roleIds: [], teamIds: [], managedTeamIds: [], teamMemberIds: [], managedMemberIds: [], queueIds: [], subordinateUserIds: [],
  owd: {}, rules: [], fields: {},
};

/** What the engine needs to know about a record table. */
export interface RecordShape {
  type: ShareType;
  resource: RecordResource;
  /** FROM clause with the record table aliased `t` (plus joins the RQL registry relies on). */
  from: SQL;
  /** Has `queue_id` (queue scope applies; for tasks queue ownership also counts as own). */
  queueColumn: boolean;
  /** Has `assignee_user_id` (counts as own). */
  assigneeColumn: boolean;
  /** RQL registry used to compile sharing-rule criteria. */
  registry(tx: Db): Promise<FieldRegistry>;
}

/** Literal uuid[] (drizzle would expand a JS array into a parameter list). Values are ids read from the database. */
export const uuidArray = (ids: readonly string[]): SQL => sql`${`{${ids.join(',')}}`}::uuid[]`;

const or = (terms: SQL[]): SQL => (terms.length ? sql`(${sql.join(terms, sql` OR `)})` : sql`FALSE`);

const WIDENED_BY_SHARING: ReadonlySet<RecordAction> = new Set(['read', 'update']);
const WIDENED_BY_HIERARCHY: ReadonlySet<RecordAction> = new Set(['read', 'update', 'archive']);

/** Compiled sharing-rule predicates, per request (rules are few; criteria compile in microseconds). */
const ruleCache = new WeakMap<TenantRequestContext, Map<string, SQL | null>>();

async function rulePredicate(tx: Db, t: TenantRequestContext, shape: RecordShape, rule: SharingRuleInfo): Promise<SQL | null> {
  let cache = ruleCache.get(t);
  if (!cache) {
    cache = new Map();
    ruleCache.set(t, cache);
  }
  if (cache.has(rule.id)) return cache.get(rule.id) ?? null;
  let compiled: SQL | null;
  try {
    compiled = compileQuery(rule.criteria, await shape.registry(tx), { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() }).where;
  } catch {
    // A rule whose criteria no longer compile (e.g. an archived custom field) grants nothing: fail closed.
    compiled = null;
  }
  cache.set(rule.id, compiled);
  return compiled;
}

/** SQL predicate on alias `t`: may the caller perform `action` on the row? (segment and tenant are RLS's job). */
export async function recordPredicate(tx: Db, t: TenantRequestContext, shape: RecordShape, action: RecordAction): Promise<SQL> {
  const scope = recordScope(t.authz, action, shape.resource);
  if (scope.kind === 'none') return sql`FALSE`;
  if (scope.kind === 'all') return sql`TRUE`;
  const a = t.access;
  const me = t.principal.userId;
  const terms: SQL[] = [];
  if (scope.own) { // also set for `team` and `queue` grants, which include own records
    terms.push(sql`t.owner_user_id = ${me}`, sql`t.created_by = ${me}`);
    if (shape.assigneeColumn) terms.push(sql`t.assignee_user_id = ${me}`);
    // A task owned by a work queue the user belongs to is the user's own work (ADR-0004 §2).
    if (shape.type === 'task' && a.queueIds.length) terms.push(sql`t.queue_id = ANY(${uuidArray(a.queueIds)})`);
  }
  if (scope.queue && shape.queueColumn && a.queueIds.length) terms.push(sql`t.queue_id = ANY(${uuidArray(a.queueIds)})`);
  if (scope.team && a.teamMemberIds.length) terms.push(sql`t.owner_user_id = ANY(${uuidArray(a.teamMemberIds)})`);
  if (WIDENED_BY_HIERARCHY.has(action) && a.subordinateUserIds.length) terms.push(sql`t.owner_user_id = ANY(${uuidArray(a.subordinateUserIds)})`);
  if (WIDENED_BY_SHARING.has(action)) {
    const owd = a.owd[shape.type] ?? 'private';
    if (owd === 'read_write' || (owd === 'read' && action === 'read')) return sql`TRUE`;
    const edit = action === 'update' ? sql` AND rs.access = 'edit'` : sql``;
    const grantee = a.teamIds.length
      ? sql`((rs.grantee_type = 'user' AND rs.grantee_id = ${me}) OR (rs.grantee_type = 'team' AND rs.grantee_id = ANY(${uuidArray(a.teamIds)})))`
      : sql`(rs.grantee_type = 'user' AND rs.grantee_id = ${me})`;
    terms.push(sql`EXISTS (SELECT 1 FROM record_shares rs WHERE rs.record_type = ${shape.type} AND rs.record_id = t.id AND ${grantee}${edit})`);
    for (const rule of a.rules) {
      if (rule.resourceType !== shape.type || (action === 'update' && rule.access !== 'edit')) continue;
      const p = await rulePredicate(tx, t, shape, rule);
      if (p) terms.push(sql`(${p})`);
    }
  }
  return or(terms);
}

/** Throws 403 unless the (already visible) record `id` allows `action`. */
export async function assertCan(tx: Db, t: TenantRequestContext, shape: RecordShape, id: string, action: RecordAction): Promise<void> {
  const r = await tx.execute(sql`SELECT 1 FROM ${shape.from} WHERE t.id = ${id} AND ${await recordPredicate(tx, t, shape, action)}`);
  if ((r.rowCount ?? 0) === 0) throw new ProblemError('FORBIDDEN');
}

/** May the caller give a record of `resource` to `target` (Matrix A A13 reassign)? `all` → any member;
 *  team scope → members of the caller's teams; queue scope → the caller's queues. The own records a team or queue
 *  scope includes widen which records may be given away, never who may receive them; giving a record to oneself
 *  is not checked here (callers let it through). */
export function canAssignTo(t: TenantRequestContext, resource: RecordResource, target: { userId: string } | { queueId: string }): boolean {
  const scope = recordScope(t.authz, 'reassign', resource);
  if (scope.kind === 'all') return true;
  if (scope.kind === 'none') return false;
  if ('userId' in target) return scope.team && t.access.teamMemberIds.includes(target.userId);
  return scope.queue && t.access.queueIds.includes(target.queueId);
}

// ---------------------------------------------------------------------------------------------- FLS

export function fieldAccess(t: TenantRequestContext, type: ShareType, field: string): FieldAccess | 'write' {
  return t.access.fields[type]?.[field] ?? 'write';
}

export function hiddenFields(t: TenantRequestContext, type: ShareType): Set<string> {
  return new Set(Object.entries(t.access.fields[type] ?? {}).filter(([, v]) => v === 'hidden').map(([k]) => k));
}

/** Drops registry entries whose view field is hidden, so filtering or sorting on them answers UNKNOWN_FIELD
 *  exactly like a field that does not exist. `viewFieldOf` maps registry names to view field names. */
export function maskRegistry(t: TenantRequestContext, type: ShareType, registry: FieldRegistry, viewFieldOf: Readonly<Record<string, string>>): FieldRegistry {
  const hidden = hiddenFields(t, type);
  if (hidden.size === 0) return registry;
  const out: Record<string, FieldRegistry[string]> = {};
  for (const [name, def] of Object.entries(registry)) if (!hidden.has(viewFieldOf[name] ?? name)) out[name] = def;
  return out;
}

/** Removes hidden fields (and hidden custom fields) from a view. */
export function maskView(t: TenantRequestContext, type: ShareType, view: Record<string, unknown>): Record<string, unknown> {
  const hidden = hiddenFields(t, type);
  if (hidden.size === 0) return view;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(view)) if (!hidden.has(k)) out[k] = v;
  if (out.custom && typeof out.custom === 'object') {
    const custom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out.custom as Record<string, unknown>)) if (!hidden.has(`custom.${k}`)) custom[k] = v;
    out.custom = custom;
  }
  return out;
}

/** Writing a hidden or read-only field (incl. `custom.cf_x`) → 403 FIELD_READ_ONLY. */
export function assertWritable(t: TenantRequestContext, type: ShareType, body: Record<string, unknown>): void {
  const policies = t.access.fields[type];
  if (!policies) return;
  const keys = Object.keys(body).filter((k) => k !== 'custom');
  const custom = body.custom && typeof body.custom === 'object' ? Object.keys(body.custom).map((k) => `custom.${k}`) : [];
  const blocked = [...keys, ...custom].find((k) => policies[k] !== undefined);
  if (blocked === undefined) return;
  // A hidden field is not named (its existence stays hidden); a read-only one is.
  if (policies[blocked] === 'hidden') throw new ProblemError('FIELD_READ_ONLY', 'a field in the request cannot be changed');
  throw new ProblemError('FIELD_READ_ONLY', `field "${blocked}" is read-only`, { field: blocked });
}
