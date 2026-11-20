import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { can } from '@runvara/authz';
import { eq, inArray, schema, sql, type DbHandle } from '@runvara/db';
import { MODULES, planToggle } from '@runvara/modules';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { DB } from '../../infra/tokens';

@Controller('v1')
@UseGuards(TenantGuard)
export class TenancyController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get('tenant')
  tenant(@CurrentTenant() t: TenantRequestContext) {
    return t.tenant;
  }

  @Get('modules')
  modules(@CurrentTenant() t: TenantRequestContext) {
    if (!can(t.authz, 'tenant.modules.manage').allow) authorize(t, 'tenant.config.read', 'read');
    return { data: this.states(t.authz.enabledModules) };
  }

  @Post('modules/:moduleId/enable')
  @HttpCode(200)
  enable(@CurrentTenant() t: TenantRequestContext, @Param('moduleId') moduleId: string, @Client() c: ClientInfo) {
    return this.toggle(t, moduleId, true, false, c);
  }

  @Post('modules/:moduleId/disable')
  @HttpCode(200)
  disable(@CurrentTenant() t: TenantRequestContext, @Param('moduleId') moduleId: string, @Query('cascade') cascade: string | undefined, @Client() c: ClientInfo) {
    return this.toggle(t, moduleId, false, cascade === 'true', c);
  }

  private async toggle(t: TenantRequestContext, moduleId: string, enable: boolean, cascade: boolean, client: ClientInfo) {
    authorize(t, 'tenant.modules.manage');
    const userId = t.principal.userId;
    const result = await this.db.withTenant({ tenantId: t.tenant.id, userId }, async (tx) => {
      // Serialise concurrent toggles of the same tenant so the dependency check sees a consistent set.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`modules:${t.tenant.id}`}, 0))`);
      const rows = await tx.select({ id: schema.tenantModules.moduleId }).from(schema.tenantModules).where(eq(schema.tenantModules.enabled, true));
      const current = new Set(['core', ...rows.map((r) => r.id)]);
      const plan = planToggle(current, moduleId, enable, { cascade });
      if (!plan.ok) {
        const { code, ...rest } = plan.error;
        throw new ProblemError(code, undefined, rest);
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
        await audit(tx, t.tenant.id, { action: 'module.toggled', actorId: userId, targetType: 'module', ip: client.ip, details: { enabled: plan.enable, disabled: plan.disable, cascade } });
      }
      for (const id of plan.enable) current.add(id);
      for (const id of plan.disable) current.delete(id);
      return { enabled: plan.enable, disabled: plan.disable, modules: this.states(current) };
    });
    return result;
  }

  private states(enabled: ReadonlySet<string>) {
    return MODULES.map((m) => ({ id: m.id, displayNameKey: m.displayNameKey, enabled: enabled.has(m.id), alwaysOn: m.alwaysOn === true, dependsOn: m.dependsOn }));
  }
}
