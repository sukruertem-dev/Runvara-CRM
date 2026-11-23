import { eq, inArray, schema, sql, type Db } from '@flexa/db';
import { entitled, entitlement, MODULES, planToggle } from '@flexa/modules';
import { audit } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import type { TenantRequestContext } from '../../common/request-context';

// Module switching (MOD-02…04) inside the caller's transaction: the settings screen and the configuration
// import share it. Dependencies come from the catalogue, entitlement from the tenant's plan.

export function moduleStates(t: Pick<TenantRequestContext, 'plan'>, enabled: ReadonlySet<string>) {
  return MODULES.map((m) => ({
    id: m.id, displayNameKey: m.displayNameKey, enabled: enabled.has(m.id), alwaysOn: m.alwaysOn === true, dependsOn: m.dependsOn,
    entitlement: entitlement(t.plan.id, t.plan.addOns, m.id),
  }));
}

export async function enabledModules(tx: Db): Promise<Set<string>> {
  const rows = await tx.select({ id: schema.tenantModules.moduleId }).from(schema.tenantModules).where(eq(schema.tenantModules.enabled, true));
  return new Set(['core', ...rows.map((r) => r.id)]);
}

/** Enables or disables one module. Raises the dependency errors of planToggle and 402 MODULE_NOT_IN_PLAN
 *  when an enable is outside the plan. Returns the modules switched and the resulting enabled set. */
export async function toggleModuleTx(tx: Db, t: TenantRequestContext, moduleId: string, enable: boolean, cascade: boolean, ip: string | null, source = 'settings') {
  const userId = t.principal.userId;
  // Serialise concurrent toggles of the same tenant so the dependency check sees a consistent set.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`modules:${t.tenant.id}`}, 0))`);
  const current = await enabledModules(tx);
  const plan = planToggle(current, moduleId, enable, { cascade });
  if (!plan.ok) {
    const { code, ...rest } = plan.error;
    throw new ProblemError(code, undefined, rest);
  }
  for (const id of plan.enable) {
    if (!entitled(t.plan.id, t.plan.addOns, id)) {
      throw new ProblemError('MODULE_NOT_IN_PLAN', `module ${id} is not part of the ${t.plan.id} plan`, { moduleId: id, plan: t.plan.id, entitlement: entitlement(t.plan.id, t.plan.addOns, id) });
    }
  }
  const now = new Date();
  for (const id of plan.enable) {
    await tx.insert(schema.tenantModules).values({ tenantId: t.tenant.id, moduleId: id, enabled: true, enabledBy: userId, enabledAt: now, config: {} })
      .onConflictDoUpdate({ target: [schema.tenantModules.tenantId, schema.tenantModules.moduleId], set: { enabled: true, enabledBy: userId, enabledAt: now } });
  }
  if (plan.disable.length > 0) {
    // MOD-03: disabling hides the module; its data and configuration rows are kept.
    await tx.update(schema.tenantModules).set({ enabled: false }).where(inArray(schema.tenantModules.moduleId, plan.disable));
  }
  if (plan.enable.length + plan.disable.length > 0) {
    await tx.update(schema.tenants).set({ authzEpoch: sql`${schema.tenants.authzEpoch} + 1` });
    await audit(tx, t.tenant.id, { action: 'module.toggled', actorId: userId, targetType: 'module', ip, details: { enabled: plan.enable, disabled: plan.disable, cascade, source } });
  }
  for (const id of plan.enable) current.add(id);
  for (const id of plan.disable) current.delete(id);
  return { enabled: plan.enable, disabled: plan.disable, current };
}
