import { moduleForPermission, type ModuleId } from '@flexa/modules';
import matrix from './generated/matrix.json';

// Central authorization (ADR-0004). This P1 slice decides tenant-level actions (no record scope yet):
//   moduleEnabled ∧ rolePermits(mode). Record predicates, segments and field policy arrive in P4
//   on the same entry points, so callers never write their own permission logic.

export type GrantMode = 'full' | 'read' | 'approve' | 'request';
export type Scope = 'own' | 'queue' | 'team' | 'segment' | 'all';
export type SystemRoleKey = 'admin' | 'manager' | 'sales_rep' | 'call_agent' | 'analyst';

export interface Grant {
  mode: GrantMode;
  scope: Scope | Scope[];
  policy?: string;
  constraints?: string[];
  permissions?: string[];
  resources?: string[];
}

interface Row {
  id: string;
  module: string;
  permissions: string[];
  grants: Partial<Record<string, Grant>>;
}

const ROWS = matrix.rows as Row[];
export const SYSTEM_ROLES: readonly SystemRoleKey[] = matrix.roles as SystemRoleKey[];
export const PROTECTED_PERMISSIONS: readonly string[] = matrix.protected;

export interface AuthzContext {
  tenantId: string;
  userId: string;
  roleKeys: readonly string[];
  enabledModules: ReadonlySet<string>;
  authzVersion: number;
  tenantAuthzEpoch: number;
  /** Tenant policies that are switched on (permission-matrix.yaml `policies`). */
  enabledPolicies?: ReadonlySet<string>;
}

export type DenyReason = 'module_disabled' | 'no_permission' | 'policy_disabled' | 'unknown_permission';

export type Decision =
  | { allow: true; grant: Grant; roleKey: string }
  | { allow: false; status: 403 | 404; reason: DenyReason };

const MODE_RANK: Record<GrantMode, number> = { request: 0, read: 1, approve: 2, full: 3 };

function satisfies(granted: GrantMode, wanted: GrantMode): boolean {
  if (wanted === 'request') return true; // anyone holding any grant may at least request
  if (wanted === 'approve') return granted === 'approve' || granted === 'full';
  return MODE_RANK[granted] >= MODE_RANK[wanted] && granted !== 'approve';
}

/** All grants a role holds for a permission key (a row may narrow its keys per role via grant.permissions). */
export function grantsFor(roleKey: string, permission: string): Grant[] {
  const out: Grant[] = [];
  for (const row of ROWS) {
    if (!row.permissions.includes(permission)) continue;
    const g = row.grants[roleKey];
    if (!g) continue;
    if (g.permissions && !g.permissions.includes(permission)) continue;
    out.push(g);
  }
  return out;
}

export function isKnownPermission(permission: string): boolean {
  return ROWS.some((r) => r.permissions.includes(permission));
}

/** can(ctx, permission, mode): module gate first (404 MODULE_DISABLED), then role grants (403). Default deny. */
export function can(ctx: AuthzContext, permission: string, mode: GrantMode = 'full'): Decision {
  const module: ModuleId | null = moduleForPermission(permission);
  if (!module || !isKnownPermission(permission)) return { allow: false, status: 403, reason: 'unknown_permission' };
  if (!ctx.enabledModules.has(module)) return { allow: false, status: 404, reason: 'module_disabled' };
  let policyBlocked = false;
  for (const roleKey of ctx.roleKeys) {
    for (const grant of grantsFor(roleKey, permission)) {
      if (!satisfies(grant.mode, mode)) continue;
      if (grant.policy && !(ctx.enabledPolicies?.has(grant.policy) ?? false)) {
        policyBlocked = true;
        continue;
      }
      return { allow: true, grant, roleKey };
    }
  }
  return { allow: false, status: 403, reason: policyBlocked ? 'policy_disabled' : 'no_permission' };
}

/** Widest scope among the allowed grant (for callers that must narrow by scope). */
export function scopesOf(grant: Grant): Scope[] {
  return Array.isArray(grant.scope) ? grant.scope : [grant.scope];
}

/** Policy defaults from the matrix (§10.2.4): returns the keys that are on by default. */
export function defaultEnabledPolicies(): Set<string> {
  const policies = matrix.policies as Record<string, { default: boolean | number }>;
  return new Set(Object.entries(policies).filter(([, v]) => v.default === true).map(([k]) => k));
}

export type RecordAction = 'read' | 'create' | 'update' | 'archive' | 'purge' | 'reassign' | 'bulk';
/** Record resources of the generic `*record*` permissions (permission-matrix.yaml `record_resources`). */
export type RecordResource = 'core.task' | 'crm.account' | 'crm.contact' | 'crm.lead' | 'crm.opportunity' | 'crm.case';
/** `all` = no record restriction beyond segment RLS (`segment` and `all` grants). `scoped` = union of the
 *  listed scopes (own / queue / team, ADR-0004 §2), turned into SQL by the API's record-access layer. */
export type RecordScope =
  | { kind: 'all' }
  | { kind: 'scoped'; own: boolean; queue: boolean; team: boolean }
  | { kind: 'none' };

const SCOPE_RANK: Record<Scope, number> = { own: 1, queue: 2, team: 2, segment: 3, all: 4 };

/** True when scope `held` covers `wanted` (own < {queue, team} < segment < all; queue and team are incomparable). */
export function scopeCovers(held: Scope, wanted: Scope): boolean {
  if (held === wanted) return true;
  if ((held === 'queue' && wanted === 'team') || (held === 'team' && wanted === 'queue')) return false;
  return SCOPE_RANK[held] > SCOPE_RANK[wanted];
}

/** Record-level scope for generic record permissions (Matrix A rows A08–A13, A24): the union of every
 *  allowed grant's scopes. Read-only grants (Analist) allow `read` only; resource-narrowed grants apply to
 *  their resources only; a disabled module yields `none`. */
export function recordScope(ctx: AuthzContext, action: RecordAction, resource: RecordResource): RecordScope {
  const permission = `*record*.${action}`;
  const mode: GrantMode = action === 'read' ? 'read' : 'full';
  if (!ctx.enabledModules.has(resource.slice(0, resource.indexOf('.')))) return { kind: 'none' };
  const held = new Set<Scope>();
  for (const roleKey of ctx.roleKeys) {
    for (const grant of grantsFor(roleKey, permission)) {
      if (!satisfies(grant.mode, mode)) continue;
      // A grant narrowed to listed resources (e.g. call_agent create: lead, contact, call note) applies to those only.
      if (grant.resources && !grant.resources.includes(resource)) continue;
      for (const s of scopesOf(grant)) held.add(s);
    }
  }
  if (held.size === 0) return { kind: 'none' };
  if (held.has('all') || held.has('segment')) return { kind: 'all' };
  return { kind: 'scoped', own: held.has('own'), queue: held.has('queue'), team: held.has('team') };
}

/** Matrix constraint `no_escalation` for role assignment (A04): every grant of the target role must be
 *  covered by a grant the granter holds on the same permission (mode and scope, ADR-0004 §7). Roles that
 *  carry a protected permission are never assignable by a non-Admin (`no_admin_assignment`). */
export function canAssignRole(granterRoleKeys: readonly string[], targetRoleKey: string): boolean {
  if (granterRoleKeys.includes('admin')) return true;
  if (targetRoleKey === 'admin') return false;
  for (const row of ROWS) {
    const target = row.grants[targetRoleKey];
    if (!target) continue;
    for (const permission of target.permissions ?? row.permissions) {
      // A read-only grant on a protected key (Manager: authz.matrix.read/edit as R) does not confer it.
      if (PROTECTED_PERMISSIONS.includes(permission) && (target.mode === 'full' || target.mode === 'approve')) return false;
      // Reading tenant reference data (catalog, campaigns: non-record permissions) is covered by holding the
      // permission at all; record permissions compare scopes strictly (assumptions.md B28).
      const referenceRead = target.mode === 'read' && !permission.startsWith('*record*');
      const covered = granterRoleKeys.some((rk) => grantsFor(rk, permission).some((g) =>
        (referenceRead && g.mode !== 'request') ||
        (satisfies(g.mode, target.mode) && scopesOf(target).every((ws) => scopesOf(g).some((hs) => scopeCovers(hs, ws))))));
      if (!covered) return false;
    }
  }
  return true;
}
