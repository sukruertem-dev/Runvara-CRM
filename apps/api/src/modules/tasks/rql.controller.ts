import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common';
import { RqlValidateRequest, type z } from '@flexa/contracts';
import type { DbHandle } from '@flexa/db';
import { compileQuery, RqlError } from '@flexa/query-lang';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { loadFieldDefs, taskRegistry } from './task-fields';

/** Filter-bar support: validation with error position and the list of queryable fields (ADR-0008). */
@Controller('v1/rql')
@UseGuards(TenantGuard)
export class RqlController {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  @Post('validate')
  @HttpCode(200)
  async validate(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(RqlValidateRequest)) body: z.infer<typeof RqlValidateRequest>) {
    const registry = taskRegistry(await this.db.withTenant({ tenantId: t.tenant.id, userId: t.principal.userId }, (tx) => loadFieldDefs(tx, 'task')));
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
    if (resource !== 'task') throw new ProblemError('VALIDATION_FAILED', 'resource must be "task"');
    const registry = taskRegistry(await this.db.withTenant({ tenantId: t.tenant.id, userId: t.principal.userId }, (tx) => loadFieldDefs(tx, 'task')));
    return {
      data: Object.entries(registry).map(([name, d]) => ({ name, type: d.type, sortable: d.sortable, ...(d.enumValues ? { enumValues: [...d.enumValues] } : {}) })),
    };
  }
}
