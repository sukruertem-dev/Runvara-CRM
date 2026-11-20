import { describe, expect, it } from 'vitest';
import { can, defaultEnabledPolicies, grantsFor, PROTECTED_PERMISSIONS, recordScope, SYSTEM_ROLES, type AuthzContext } from './index';

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

describe('recordScope (P2 slice of ADR-0004)', () => {
  it('maps Matrix A A08/A10 to scopes, fail-closed for team/queue until P4', () => {
    expect(recordScope(ctx(['admin']), 'read')).toEqual({ kind: 'all' });
    expect(recordScope(ctx(['analyst']), 'read')).toEqual({ kind: 'all' });
    expect(recordScope(ctx(['analyst']), 'update')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['manager']), 'read')).toEqual({ kind: 'own' });
    expect(recordScope(ctx(['sales_rep']), 'update')).toEqual({ kind: 'own' });
    expect(recordScope(ctx(['call_agent']), 'read')).toEqual({ kind: 'own' });
    expect(recordScope(ctx(['sales_rep']), 'archive')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['manager']), 'archive')).toEqual({ kind: 'own' });
    expect(recordScope(ctx(['admin']), 'purge')).toEqual({ kind: 'all' });
    expect(recordScope(ctx([]), 'read')).toEqual({ kind: 'none' });
    expect(recordScope(ctx(['sales_rep', 'admin']), 'read')).toEqual({ kind: 'all' });
  });
});
