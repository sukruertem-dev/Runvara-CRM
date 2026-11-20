import { moduleForPermission, type ModuleId } from '@runvara/modules';
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
