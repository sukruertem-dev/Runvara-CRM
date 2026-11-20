import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { RqlValidateRequest, type z } from '@flexa/contracts';
import type { DbHandle } from '@flexa/db';
import { compileQuery, RqlError, type FieldRegistry } from '@flexa/query-lang';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { CurrentTenant, dbCtx, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { CRM, crmRegistry, isCrmType } from '../crm/crm-objects';
import { loadFieldDefs, RESOURCE_TYPES, taskRegistry, type ResourceType } from './task-fields';

/** Filter-bar support: validation with error position and the list of queryable fields (ADR-0008). */
@Controller('v1/rql')
@UseGuards(TenantGuard)
export class RqlController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  private async registry(t: TenantRequestContext, resource: ResourceType): Promise<FieldRegistry> {
    const defs = await this.db.withTenant(dbCtx(t), (tx) => loadFieldDefs(tx, resource));
    return isCrmType(resource) ? crmRegistry(CRM[resource], defs) : taskRegistry(defs);
  }

  @Post('validate')
  @HttpCode(200)
  async validate(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(RqlValidateRequest)) body: z.infer<typeof RqlValidateRequest>) {
    const registry = await this.registry(t, body.resource);
    try {
      compileQuery(body.q, registry, { userId: t.principal.userId, timezone: t.tenant.timezone, now: new Date() });
      return { ok: true };
    } catch (e) {
      if (e instanceof RqlError) return { ok: false, error: { code: e.code, message: e.message, position: e.position } };
      throw e;
    }
  }

  @Get('fields')
  async fields(@CurrentTenant() t: TenantRequestContext, @Query('resource') resource: string | undefined) {
    if (!(RESOURCE_TYPES as readonly string[]).includes(resource ?? '')) throw new ProblemError('VALIDATION_FAILED', `resource must be one of ${RESOURCE_TYPES.join(', ')}`);
    const registry = await this.registry(t, resource as ResourceType);
    return {
      data: Object.entries(registry).map(([name, d]) => ({ name, type: d.type, sortable: d.sortable, ...(d.enumValues ? { enumValues: [...d.enumValues] } : {}) })),
    };
  }
}
