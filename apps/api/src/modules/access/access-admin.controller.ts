import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards, type Type } from '@nestjs/common';
import {
  DirectoryUsersQuery, FieldPolicySet, QueueCreate, RoleParentSet, ShareCreate, SharingDefaultsSet, SharingRuleCreate, TeamCreate, TeamMemberSet, TeamPatch,
  UserRolesSet, UserSegmentsSet, type z,
} from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import type { ShareType } from '../../common/record-access';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { AccessAdminService } from './access-admin.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class AccessAdminController {
  constructor(private readonly svc: AccessAdminService) {}

  // teams
  @Get('teams')
  teams(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listTeams(t);
  }

  @Post('teams')
  createTeam(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(TeamCreate)) body: z.infer<typeof TeamCreate>, @Client() c: ClientInfo) {
    return this.svc.createTeam(t, body, c.ip);
  }

  @Patch('teams/:id')
  patchTeam(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(TeamPatch)) body: z.infer<typeof TeamPatch>, @Client() c: ClientInfo) {
    return this.svc.patchTeam(t, id, body, c.ip);
  }

  @Put('teams/:id/members/:userId')
  setMember(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('userId', Id) userId: string, @Body(new ZodPipe(TeamMemberSet)) body: z.infer<typeof TeamMemberSet>, @Client() c: ClientInfo) {
    return this.svc.setTeamMember(t, id, userId, body.role, c.ip);
  }

  @Delete('teams/:id/members/:userId')
  @HttpCode(204)
  async removeMember(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('userId', Id) userId: string, @Client() c: ClientInfo): Promise<void> {
    await this.svc.removeTeamMember(t, id, userId, c.ip);
  }

  // queues
  @Get('queues')
  queues(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listQueues(t);
  }

  @Post('queues')
  createQueue(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(QueueCreate)) body: z.infer<typeof QueueCreate>, @Client() c: ClientInfo) {
    return this.svc.createQueue(t, body, c.ip);
  }

  @Put('queues/:id/members/:userId')
  addQueueMember(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('userId', Id) userId: string, @Client() c: ClientInfo) {
    return this.svc.setQueueMember(t, id, userId, true, c.ip);
  }

  @Delete('queues/:id/members/:userId')
  @HttpCode(204)
  async removeQueueMember(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('userId', Id) userId: string, @Client() c: ClientInfo): Promise<void> {
    await this.svc.setQueueMember(t, id, userId, false, c.ip);
  }

  // users
  @Get('directory/users')
  directory(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(DirectoryUsersQuery)) q: z.infer<typeof DirectoryUsersQuery>) {
    return this.svc.directory(t, q);
  }

  @Get('users')
  users(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listUsers(t);
  }

  @Get('users/:id/access')
  userAccess(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.userAccess(t, id);
  }

  @Put('users/:id/segments')
  setSegments(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(UserSegmentsSet)) body: z.infer<typeof UserSegmentsSet>, @Client() c: ClientInfo) {
    return this.svc.setSegments(t, id, body, c.ip);
  }

  @Put('users/:id/roles')
  setRoles(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(UserRolesSet)) body: z.infer<typeof UserRolesSet>, @Client() c: ClientInfo) {
    return this.svc.setRoles(t, id, body, c.ip);
  }

  // roles
  @Get('roles')
  roles(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listRoles(t);
  }

  @Put('roles/:id/parent')
  setParent(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(RoleParentSet)) body: z.infer<typeof RoleParentSet>, @Client() c: ClientInfo) {
    return this.svc.setRoleParent(t, id, body.parentRoleId, c.ip);
  }

  // sharing
  @Get('sharing/defaults')
  defaults(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.sharingDefaults(t);
  }

  @Put('sharing/defaults')
  setDefaults(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(SharingDefaultsSet)) body: z.infer<typeof SharingDefaultsSet>, @Client() c: ClientInfo) {
    return this.svc.setSharingDefaults(t, body, c.ip);
  }

  @Get('sharing/rules')
  rules(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.listRules(t);
  }

  @Post('sharing/rules')
  createRule(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(SharingRuleCreate)) body: z.infer<typeof SharingRuleCreate>, @Client() c: ClientInfo) {
    return this.svc.createRule(t, body, c.ip);
  }

  @Delete('sharing/rules/:id')
  @HttpCode(204)
  async deleteRule(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo): Promise<void> {
    await this.svc.deleteRule(t, id, c.ip);
  }

  // field-level security
  @Get('field-policies')
  fieldPolicies(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.fieldPolicies(t);
  }

  @Put('field-policies')
  setFieldPolicy(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(FieldPolicySet)) body: z.infer<typeof FieldPolicySet>, @Client() c: ClientInfo) {
    return this.svc.setFieldPolicy(t, body, c.ip);
  }
}

/** `/v1/{collection}/{id}/shares` for every shareable object (manual record sharing). */
function sharesController(path: string, type: ShareType): Type {
  @Controller(`v1/${path}/:id/shares`)
  @UseGuards(TenantGuard)
  class SharesController {
    constructor(readonly svc: AccessAdminService) {}

    @Get()
    list(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
      return this.svc.listShares(t, type, id);
    }

    @Post()
    create(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ShareCreate)) body: z.infer<typeof ShareCreate>, @Client() c: ClientInfo) {
      return this.svc.share(t, type, id, body, c.ip);
    }

    @Delete(':shareId')
    @HttpCode(204)
    async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('shareId', Id) shareId: string, @Client() c: ClientInfo): Promise<void> {
      await this.svc.unshare(t, type, id, shareId, c.ip);
    }
  }
  Object.defineProperty(SharesController, 'name', { value: `${path}SharesController` });
  return SharesController;
}

export const SHARES_CONTROLLERS: Type[] = [
  sharesController('tasks', 'task'),
  sharesController('accounts', 'account'),
  sharesController('contacts', 'contact'),
  sharesController('leads', 'lead'),
  sharesController('opportunities', 'opportunity'),
  sharesController('cases', 'case'),
];
