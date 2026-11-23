import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { TenantDeletionRequest, type z } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { deletionGraceDays, transitionTx } from '../tenancy/lifecycle';
import { exportView, ExportsService } from './exports.service';

/** Data export and workspace deletion for the tenant's Admin (TEN-05, docs/p7-plan.md §15). Both stay
 *  available while a deletion is pending (TenantGuard allows these routes). */
@Controller('v1/tenant')
@UseGuards(TenantGuard)
export class PrivacyController {
  constructor(@Inject(DB) private readonly db: DbHandle, private readonly exports: ExportsService) {}

  @Get('exports')
  list(@CurrentTenant() t: TenantRequestContext) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), (tx) => this.exports.list(tx));
  }

  @Post('exports')
  @HttpCode(202)
  async request(@CurrentTenant() t: TenantRequestContext, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    const row = await this.db.withTenant(dbCtx(t), (tx) => this.exports.requestTx(tx, t.tenant.id, t.principal.userId, 'admin', c.ip));
    await this.exports.enqueue(t.tenant.id, row.id);
    return exportView(row);
  }

  @Get('exports/:id/download')
  download(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string) {
    authorize(t, 'tenant.config.manage');
    return this.db.withTenant(dbCtx(t), (tx) => this.exports.downloadUrl(tx, id));
  }

  @Get('deletion')
  deletion(@CurrentTenant() t: TenantRequestContext) {
    authorize(t, 'tenant.config.read', 'read');
    return this.db.withTenant(dbCtx(t), (tx) => this.state(tx, t));
  }

  /** Schedules the deletion; the Admin types the workspace address to confirm. */
  @Post('deletion')
  @HttpCode(200)
  async schedule(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TenantDeletionRequest)) body: z.infer<typeof TenantDeletionRequest>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.modules.manage');
    if (body.confirmSlug.toLowerCase() !== t.tenant.slug.toLowerCase()) throw new ProblemError('VALIDATION_FAILED', 'the confirmation does not match the workspace address');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await transitionTx(tx, t.tenant.id, 'pending_deletion', { actorId: t.principal.userId, actorType: 'user', ip: c.ip }, body.reason ?? 'requested by the workspace Admin');
      return this.state(tx, t);
    });
  }

  @Post('deletion/cancel')
  @HttpCode(200)
  async cancel(@CurrentTenant() t: TenantRequestContext, @Client() c: ClientInfo) {
    authorize(t, 'tenant.modules.manage');
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await transitionTx(tx, t.tenant.id, 'active', { actorId: t.principal.userId, actorType: 'user', ip: c.ip }, 'deletion cancelled by the workspace Admin');
      return this.state(tx, t);
    });
  }

  private async state(tx: Parameters<Parameters<DbHandle['withTenant']>[1]>[0], t: TenantRequestContext) {
    const row = (await tx.execute<{ status: 'trial' | 'active' | 'suspended' | 'pending_deletion' | 'deleted'; deletion_scheduled_at: Date | string | null }>(sql`
      SELECT status, deletion_scheduled_at FROM tenants WHERE id = ${t.tenant.id}`)).rows[0];
    if (!row) throw new ProblemError('NOT_FOUND');
    return {
      status: row.status,
      deletionScheduledAt: row.deletion_scheduled_at === null ? null : new Date(row.deletion_scheduled_at).toISOString(),
      graceDays: await deletionGraceDays(tx, t.tenant.id),
    };
  }
}
