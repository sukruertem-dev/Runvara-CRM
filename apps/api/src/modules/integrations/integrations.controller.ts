import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiKeyCreate, BusinessCalendarInput, SlaPolicyCreate, SlaPolicyPatch, WebhookCreate, WebhookPatch, type z } from '@flexa/contracts';
import type { FastifyReply } from 'fastify';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { StreamService } from '../records/stream.service';
import { ApiKeysService } from './api-keys.service';
import { SlaService } from './sla.service';
import { WebhooksService } from './webhooks.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class IntegrationsController {
  constructor(private readonly sla: SlaService, private readonly webhooks: WebhooksService, private readonly keys: ApiKeysService, private readonly stream: StreamService) {}

  // SLA
  @Get('calendars')
  calendars(@CurrentTenant() t: TenantRequestContext) {
    return this.sla.calendars(t);
  }

  @Post('calendars')
  createCalendar(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(BusinessCalendarInput)) body: z.infer<typeof BusinessCalendarInput>, @Client() c: ClientInfo) {
    return this.sla.saveCalendar(t, null, body, c.ip);
  }

  @Put('calendars/:id')
  updateCalendar(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(BusinessCalendarInput)) body: z.infer<typeof BusinessCalendarInput>, @Client() c: ClientInfo) {
    return this.sla.saveCalendar(t, id, body, c.ip);
  }

  @Get('sla/policies')
  policies(@CurrentTenant() t: TenantRequestContext) {
    return this.sla.policies(t);
  }

  @Post('sla/policies')
  createPolicy(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(SlaPolicyCreate)) body: z.infer<typeof SlaPolicyCreate>, @Client() c: ClientInfo) {
    return this.sla.createPolicy(t, body, c.ip);
  }

  @Patch('sla/policies/:id')
  patchPolicy(
    @CurrentTenant() t: TenantRequestContext,
    @Param('id', Id) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(SlaPolicyPatch)) body: z.infer<typeof SlaPolicyPatch>,
    @Client() c: ClientInfo,
  ) {
    return this.sla.patchPolicy(t, id, requireIfMatch(ifMatch), body, c.ip);
  }

  @Delete('sla/policies/:id')
  @HttpCode(204)
  async disablePolicy(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo): Promise<void> {
    await this.sla.disablePolicy(t, id, c.ip);
  }

  @Get('sla/summary')
  slaSummary(@CurrentTenant() t: TenantRequestContext, @Query('recordType') recordType: string | undefined) {
    return this.sla.summary(t, recordType);
  }

  @Get('sla/timers')
  timers(@CurrentTenant() t: TenantRequestContext, @Query('recordType') recordType: string | undefined, @Query('recordId') recordId: string | undefined) {
    return this.sla.timers(t, recordType, recordId);
  }

  // Webhooks
  @Get('webhooks')
  listWebhooks(@CurrentTenant() t: TenantRequestContext) {
    return this.webhooks.list(t);
  }

  @Post('webhooks')
  createWebhook(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(WebhookCreate)) body: z.infer<typeof WebhookCreate>, @Client() c: ClientInfo) {
    return this.webhooks.create(t, body, c.ip);
  }

  @Patch('webhooks/:id')
  patchWebhook(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(WebhookPatch)) body: z.infer<typeof WebhookPatch>, @Client() c: ClientInfo) {
    return this.webhooks.patch(t, id, body, c.ip);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  async deleteWebhook(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo): Promise<void> {
    await this.webhooks.remove(t, id, c.ip);
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  rotate(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo) {
    return this.webhooks.rotate(t, id, c.ip);
  }

  @Get('webhooks/:id/deliveries')
  deliveries(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.webhooks.deliveries(t, id);
  }

  @Post('webhooks/deliveries/:deliveryId/redeliver')
  @HttpCode(200)
  redeliver(@CurrentTenant() t: TenantRequestContext, @Param('deliveryId', Id) deliveryId: string) {
    return this.webhooks.redeliver(t, deliveryId);
  }

  // API keys
  @Get('api-keys')
  listKeys(@CurrentTenant() t: TenantRequestContext) {
    return this.keys.list(t);
  }

  @Post('api-keys')
  createKey(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ApiKeyCreate)) body: z.infer<typeof ApiKeyCreate>, @Client() c: ClientInfo) {
    return this.keys.create(t, body, c.ip);
  }

  @Post('api-keys/:id/revoke')
  @HttpCode(200)
  revokeKey(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Client() c: ClientInfo) {
    return this.keys.revoke(t, id, c.ip);
  }

  // Server-sent events
  @Get('stream')
  async streamEvents(@CurrentTenant() t: TenantRequestContext, @Headers('last-event-id') lastEventId: string | undefined, @Res() reply: FastifyReply): Promise<void> {
    reply.hijack();
    await this.stream.open(t, reply.raw, lastEventId && /^[0-9a-f-]{36}$/i.test(lastEventId) ? lastEventId : undefined);
  }
}
