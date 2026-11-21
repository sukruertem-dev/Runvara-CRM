import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import { AssignmentPolicyCreate, AutomationRuleCreate, AutomationRulePatch, InboundHookRequest, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { AutomationService } from './automation.service';

const Id = new ParseUUIDPipe();

@Controller('v1/automations')
export class AutomationController {
  constructor(private readonly svc: AutomationService) {}

  @Get('rules')
  @UseGuards(TenantGuard)
  list(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.list(t);
  }

  @Post('rules')
  @UseGuards(TenantGuard)
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(AutomationRuleCreate)) body: z.infer<typeof AutomationRuleCreate>, @Client() c: ClientInfo) {
    return this.svc.create(t, body, c.ip);
  }

  @Get('rules/:id')
  @UseGuards(TenantGuard)
  get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.get(t, id);
  }

  @Patch('rules/:id')
  @UseGuards(TenantGuard)
  patch(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(AutomationRulePatch)) body: z.infer<typeof AutomationRulePatch>, @Client() c: ClientInfo) {
    return this.svc.patch(t, id, body, c.ip);
  }

  @Delete('rules/:id')
  @HttpCode(204)
  @UseGuards(TenantGuard)
  async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo): Promise<void> {
    await this.svc.remove(t, id, c.ip);
  }

  @Post('rules/:id/rotate-hook-token')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  rotate(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo) {
    return this.svc.rotateHookToken(t, id, c.ip);
  }

  @Get('runs')
  @UseGuards(TenantGuard)
  runs(@CurrentTenant() t: TenantRequestContext, @Query() q: { ruleId?: string; status?: string; limit?: string }) {
    return this.svc.runs(t, q);
  }

  @Get('dead-letters')
  @UseGuards(TenantGuard)
  deadLetters(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.deadLetters(t);
  }

  @Post('dead-letters/:id/replay')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  replay(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo) {
    return this.svc.replay(t, id, c.ip);
  }

  @Get('assignment-policies')
  @UseGuards(TenantGuard)
  policies(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.policies(t);
  }

  @Post('assignment-policies')
  @UseGuards(TenantGuard)
  createPolicy(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(AssignmentPolicyCreate)) body: z.infer<typeof AssignmentPolicyCreate>, @Client() c: ClientInfo) {
    return this.svc.createPolicy(t, body, c.ip);
  }

  /** Token-authenticated (no session); rate-limited like the auth endpoints. */
  @Post('hooks/:ruleId')
  @HttpCode(202)
  @RouteConfig({ authRateLimit: true })
  hook(@Param('ruleId', Id) ruleId: string, @Headers('x-flexa-hook-token') token: string | undefined, @Body(new ZodPipe(InboundHookRequest)) body: z.infer<typeof InboundHookRequest>) {
    return this.svc.inboundHook(ruleId, token, body);
  }
}
