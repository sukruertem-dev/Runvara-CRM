import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { can } from '@flexa/authz';
import { SalesModeUpdate, type z } from '@flexa/contracts';
import { schema, sql, type DbHandle } from '@flexa/db';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { moduleStates, toggleModuleTx } from './modules';

@Controller('v1')
@UseGuards(TenantGuard)
export class TenancyController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Get('tenant')
  tenant(@CurrentTenant() t: TenantRequestContext) {
    return t.tenant;
  }

  /** Sales mode (Matrix A A01, `tenant.sales_mode.manage`). Segment visibility follows on the next request. */
  @Put('tenant/sales-mode')
  async salesMode(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(SalesModeUpdate)) body: z.infer<typeof SalesModeUpdate>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.sales_mode.manage');
    await this.db.withTenant(dbCtx(t), async (tx) => setSalesModeTx(tx, t, body.salesMode, c.ip));
    return { ...t.tenant, salesMode: body.salesMode };
  }

  @Get('modules')
  modules(@CurrentTenant() t: TenantRequestContext) {
    if (!can(t.authz, 'tenant.modules.manage').allow) authorize(t, 'tenant.config.read', 'read');
    return { data: moduleStates(t, t.authz.enabledModules) };
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
    return this.db.withTenant(dbCtx(t), async (tx) => {
      const r = await toggleModuleTx(tx, t, moduleId, enable, cascade, client.ip);
      return { enabled: r.enabled, disabled: r.disabled, modules: moduleStates(t, r.current) };
    });
  }
}

/** Changes the sales mode inside the caller's transaction (settings and configuration import). */
export async function setSalesModeTx(tx: Parameters<Parameters<DbHandle['withTenant']>[1]>[0], t: TenantRequestContext, salesMode: 'b2b_only' | 'b2c_only' | 'both', ip: string | null): Promise<boolean> {
  if (t.tenant.salesMode === salesMode) {
    const cur = (await tx.execute<{ sales_mode: string }>(sql`SELECT sales_mode FROM tenants`)).rows[0];
    if (cur?.sales_mode === salesMode) return false;
  }
  await tx.update(schema.tenants).set({ salesMode, authzEpoch: sql`${schema.tenants.authzEpoch} + 1` });
  await audit(tx, t.tenant.id, { action: 'tenant.sales_mode_changed', actorId: t.principal.userId, targetType: 'tenant', targetId: t.tenant.id, ip, details: { from: t.tenant.salesMode, to: salesMode } });
  return true;
}
