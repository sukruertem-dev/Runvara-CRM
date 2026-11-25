import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApprovalBulkDecision, ApprovalCreate, ApprovalDecision, ApprovalLimitSet, ApprovalListQuery, TargetCreate, TargetListQuery, TargetPatch, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { ApprovalsService } from './approvals.service';
import { TargetsService } from './targets.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService, private readonly targets: TargetsService) {}

  @Get('approvals')
  list(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(ApprovalListQuery)) q: z.infer<typeof ApprovalListQuery>) {
    return this.approvals.list(t, q);
  }

  @Post('approvals')
  request(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ApprovalCreate)) body: z.infer<typeof ApprovalCreate>, @Client() c: ClientInfo) {
    return this.approvals.request(t, body, c.ip);
  }

  @Post('approvals/decisions')
  @HttpCode(200)
  decideMany(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ApprovalBulkDecision)) body: z.infer<typeof ApprovalBulkDecision>, @Client() c: ClientInfo) {
    return this.approvals.decideMany(t, body.ids, body.decision, body.note, c.ip);
  }

  @Get('approvals/limits')
  limits(@CurrentTenant() t: TenantRequestContext) {
    return this.approvals.limits(t);
  }

  @Put('approvals/limits/:userId')
  @HttpCode(204)
  async setLimit(@CurrentTenant() t: TenantRequestContext, @Param('userId', Id) userId: string, @Body(new ZodPipe(ApprovalLimitSet)) body: z.infer<typeof ApprovalLimitSet>, @Client() c: ClientInfo): Promise<void> {
    await this.approvals.setLimit(t, userId, body.maxPercent, c.ip);
  }

  @Get('approvals/:id')
  get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.approvals.get(t, id);
  }

  @Post('approvals/:id/decision')
  @HttpCode(200)
  decide(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ApprovalDecision)) body: z.infer<typeof ApprovalDecision>, @Client() c: ClientInfo) {
    return this.approvals.decide(t, id, body.decision, body.note, c.ip);
  }

  @Post('approvals/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo) {
    return this.approvals.cancel(t, id, c.ip);
  }

  @Get('targets')
  listTargets(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(TargetListQuery)) q: z.infer<typeof TargetListQuery>) {
    return this.targets.list(t, q.on);
  }

  @Post('targets')
  createTarget(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TargetCreate)) body: z.infer<typeof TargetCreate>, @Client() c: ClientInfo) {
    return this.targets.create(t, body, c.ip);
  }

  @Patch('targets/:id')
  patchTarget(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(TargetPatch)) body: z.infer<typeof TargetPatch>, @Client() c: ClientInfo) {
    return this.targets.patch(t, id, requireIfMatch(im), body.targetValue, c.ip);
  }

  @Delete('targets/:id')
  @HttpCode(204)
  async removeTarget(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo): Promise<void> {
    await this.targets.remove(t, id, c.ip);
  }
}
