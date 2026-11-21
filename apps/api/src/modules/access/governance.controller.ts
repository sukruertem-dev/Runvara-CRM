import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AccessRequestCreate, AccessRequestDecision, DelegationCreate, MatrixChange, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { GovernanceService } from './governance.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class GovernanceController {
  constructor(private readonly svc: GovernanceService) {}

  @Get('audit')
  audit(@CurrentTenant() t: TenantRequestContext, @Query() q: { action?: string; actorId?: string; targetType?: string; targetId?: string; from?: string; to?: string; before?: string; limit?: string }) {
    return this.svc.auditLog(t, q);
  }

  @Get('delegations')
  delegations(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listDelegations(t);
  }

  @Post('delegations')
  delegate(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(DelegationCreate)) body: z.infer<typeof DelegationCreate>, @Client() c: ClientInfo) {
    return this.svc.delegate(t, body, c.ip);
  }

  @Post('delegations/:id/revoke')
  @HttpCode(200)
  revoke(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo) {
    return this.svc.revokeDelegation(t, id, c.ip);
  }

  @Get('access-requests')
  requests(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listRequests(t);
  }

  @Post('access-requests')
  request(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(AccessRequestCreate)) body: z.infer<typeof AccessRequestCreate>, @Client() c: ClientInfo) {
    return this.svc.request(t, body, c.ip);
  }

  @Post('access-requests/:id/decision')
  @HttpCode(200)
  decide(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(AccessRequestDecision)) body: z.infer<typeof AccessRequestDecision>, @Client() c: ClientInfo) {
    return this.svc.decide(t, id, body, c.ip);
  }

  @Post('access-requests/:id/withdraw')
  @HttpCode(200)
  withdraw(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.withdraw(t, id);
  }

  @Get('authz/matrix')
  matrix(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.matrix(t);
  }

  @Post('authz/matrix/preview')
  @HttpCode(200)
  preview(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(MatrixChange)) body: z.infer<typeof MatrixChange>) {
    return this.svc.preview(t, body);
  }

  @Put('authz/matrix')
  apply(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(MatrixChange)) body: z.infer<typeof MatrixChange>, @Client() c: ClientInfo) {
    return this.svc.applyMatrix(t, body, c.ip);
  }

  @Get('authz/matrix/versions')
  versions(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.versions(t);
  }

  @Post('authz/matrix/versions/:version/restore')
  @HttpCode(200)
  restore(@CurrentTenant() t: TenantRequestContext, @Param('version', ParseIntPipe) version: number, @Client() c: ClientInfo) {
    return this.svc.restore(t, version, c.ip);
  }
}
