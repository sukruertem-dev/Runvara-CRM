import { describe, expect, it } from 'vitest';
import { can, canAssignRole, defaultEnabledPolicies, scopeCovers, grantsFor, PROTECTED_PERMISSIONS, recordScope, SYSTEM_ROLES, type AuthzContext } from './index';

const ctx = (roleKeys: string[], modules: string[] = ['core'], policies: string[] = []): AuthzContext => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  roleKeys,
  enabledModules: new Set(modules),
  authzVersion: 0,
  tenantAuthzEpoch: 0,
  enabledPolicies: new Set(policies),
});

describe('can() — tenant-level actions from permission-matrix.yaml', () => {
  it('knows the five system roles and Admin holds every protected permission', () => {
    expect(SYSTEM_ROLES).toEqual(['admin', 'manager', 'sales_rep', 'call_agent', 'analyst']);
    for (const p of PROTECTED_PERMISSIONS) expect(can(ctx(['admin']), p).allow, p).toBe(true);
  });

  it('matrix A row A01: only Admin manages modules', () => {
    expect(can(ctx(['admin']), 'tenant.modules.manage')).toMatchObject({ allow: true });
    for (const r of ['manager', 'sales_rep', 'call_agent', 'analyst']) {
      expect(can(ctx([r]), 'tenant.modules.manage')).toEqual({ allow: false, status: 403, reason: 'no_permission' });
    }
  });

  it('A04: Manager may invite only with team scope and constraints; others may not', () => {
    const d = can(ctx(['manager']), 'users.invite');
    expect(d).toMatchObject({ allow: true, grant: { scope: 'team', constraints: ['managed_teams_only', 'no_escalation', 'no_admin_assignment'] } });
    expect(can(ctx(['manager']), 'users.manage').allow).toBe(false);
    expect(can(ctx(['sales_rep']), 'users.invite').allow).toBe(false);
  });

  it('A02: Manager reads tenant configuration but cannot change it', () => {
    expect(grantsFor('manager', 'tenant.config.read')).toEqual([{ mode: 'read', scope: 'all' }]);
    expect(can(ctx(['manager']), 'tenant.config.manage', 'full').allow).toBe(false);
    expect(can(ctx(['manager']), 'tenant.config.read', 'read').allow).toBe(true);
  });

  it('module gate comes first: disabled module → 404 module_disabled even for Admin', () => {
    expect(can(ctx(['admin'], ['core']), 'call_center.telephony.configure')).toEqual({ allow: false, status: 404, reason: 'module_disabled' });
    expect(can(ctx(['admin'], ['core', 'crm', 'call_center']), 'call_center.telephony.configure').allow).toBe(true);
  });

  it('policy-bound grants require the tenant policy (A21 export off by default)', () => {
    expect(defaultEnabledPolicies().has('report_export_enabled')).toBe(false);
    expect(can(ctx(['manager']), 'reports.export')).toEqual({ allow: false, status: 403, reason: 'policy_disabled' });
    expect(can(ctx(['manager'], ['core'], ['report_export_enabled']), 'reports.export').allow).toBe(true);
  });

  it('read and request modes are honoured (A07 T, A23 R)', () => {
    expect(can(ctx(['sales_rep']), 'authz.delegation.create', 'full').allow).toBe(false);
    expect(can(ctx(['sales_rep']), 'authz.delegation.create', 'request').allow).toBe(true);
    expect(can(ctx(['manager']), 'audit.read', 'read').allow).toBe(true);
    expect(can(ctx(['manager']), 'audit.read', 'full').allow).toBe(false);
  });

  it('default deny: no roles, unknown roles and unknown permissions', () => {
    expect(can(ctx([]), 'users.invite').allow).toBe(false);
    expect(can(ctx(['root']), 'users.invite').allow).toBe(false);
    expect(can(ctx(['admin']), 'everything.do')).toEqual({ allow: false, status: 403, reason: 'unknown_permission' });
  });
});

describe('recordScope (ADR-0004 §2)', () => {
  it('maps Matrix A A08–A13 to the union of granted scopes', () => {
    expect(recordScope(ctx(['admin']), 'read', 'core.task')).toEqual({ kind: 'all' });
    expect(recordScope(ctx(['analyst']), 'read', 'core.task')).toEqual({ kind: 'all' });
    expect(recordScope(ctx(['analyst']), 'update', 'core.task')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['manager']), 'read', 'core.task')).toEqual({ kind: 'scoped', own: false, queue: false, team: true });
    expect(recordScope(ctx(['sales_rep']), 'update', 'core.task')).toEqual({ kind: 'scoped', own: true, queue: false, team: false });
    expect(recordScope(ctx(['call_agent']), 'read', 'core.task')).toEqual({ kind: 'scoped', own: true, queue: true, team: false });
    expect(recordScope(ctx(['sales_rep']), 'archive', 'core.task')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['manager']), 'archive', 'core.task')).toEqual({ kind: 'scoped', own: false, queue: false, team: true });
    expect(recordScope(ctx(['sales_rep', 'manager']), 'update', 'core.task')).toEqual({ kind: 'scoped', own: true, queue: false, team: true });
    expect(recordScope(ctx(['admin']), 'purge', 'core.task')).toEqual({ kind: 'all' });
    expect(recordScope(ctx([]), 'read', 'core.task')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['sales_rep', 'admin']), 'read', 'core.task')).toEqual({ kind: 'all' });
  });

  it('honours resource-narrowed grants and the module gate', () => {
    // A09: call_agent may create leads and contacts only.
    expect(recordScope(ctx(['call_agent'], ['core', 'crm']), 'create', 'crm.lead')).toEqual({ kind: 'scoped', own: true, queue: false, team: false });
    expect(recordScope(ctx(['call_agent'], ['core', 'crm']), 'create', 'crm.contact')).toEqual({ kind: 'scoped', own: true, queue: false, team: false });
    expect(recordScope(ctx(['call_agent'], ['core', 'crm']), 'create', 'crm.opportunity')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['call_agent']), 'create', 'core.task')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['sales_rep'], ['core', 'crm']), 'create', 'crm.opportunity')).toEqual({ kind: 'scoped', own: true, queue: false, team: false });
    expect(recordScope({ ...ctx(['admin']), enabledModules: new Set(['core']) }, 'read', 'crm.account')).toEqual({ kind: 'none' });
  });
});

describe('role assignment limits (A04 no_escalation / no_admin_assignment)', () => {
  it('orders scopes with queue and team incomparable', () => {
    expect(scopeCovers('team', 'own')).toBe(true);
    expect(scopeCovers('team', 'queue')).toBe(false);
    expect(scopeCovers('own', 'team')).toBe(false);
    expect(scopeCovers('all', 'segment')).toBe(true);
  });
  it('a manager may assign the sales rep role only; Admin may assign anything', () => {
    expect(canAssignRole(['manager'], 'sales_rep')).toBe(true);
    expect(canAssignRole(['manager'], 'call_agent')).toBe(false); // queue scope is not covered by team
    expect(canAssignRole(['manager'], 'analyst')).toBe(false); // read-all exceeds team scope
    expect(canAssignRole(['manager'], 'manager')).toBe(true);
    expect(canAssignRole(['manager'], 'admin')).toBe(false);
    expect(canAssignRole(['admin'], 'admin')).toBe(true);
    expect(canAssignRole(['sales_rep'], 'sales_rep')).toBe(true);
  });
});
