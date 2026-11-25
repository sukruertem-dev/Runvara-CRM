import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { DeliveryStatsQuery, OperatorPlanUpdate, OperatorTenantCreate, SupportRequestCreate, TenantTransition, type z } from '@flexa/contracts';
import type { FastifyRequest } from 'fastify';
import { Client, type ClientInfo } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { CurrentOperator, OperatorExitGuard, OperatorGuard, type OperatorPrincipal } from './operator.guard';
import { DeliveryService } from '../records/delivery.service';
import { OperatorService } from './operator.service';

/** Platform operator console API (TEN-01/02/08/09, docs/p7-plan.md §13–14). */
@Controller('v1/operator')
export class OperatorController {
  constructor(private readonly operator: OperatorService, private readonly delivery: DeliveryService) {}

  @Get('delivery')
  @UseGuards(OperatorGuard)
  async deliveryStats(@Query(new ZodPipe(DeliveryStatsQuery)) q: z.infer<typeof DeliveryStatsQuery>) {
    return { minutes: q.minutes, data: await this.delivery.stats(q.minutes) };
  }

  @Get('tenants')
  @UseGuards(OperatorGuard)
  tenants(@CurrentOperator() op: OperatorPrincipal) {
    return this.operator.list(op);
  }

  @Post('tenants')
  @UseGuards(OperatorGuard)
  create(@CurrentOperator() op: OperatorPrincipal, @Body(new ZodPipe(OperatorTenantCreate)) body: z.infer<typeof OperatorTenantCreate>, @Client() c: ClientInfo) {
    return this.operator.create(op, body, c.ip);
  }

  @Get('tenants/:id')
  @UseGuards(OperatorGuard)
  tenant(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.operator.detail(op, id);
  }

  @Put('tenants/:id/plan')
  @UseGuards(OperatorGuard)
  plan(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(OperatorPlanUpdate)) body: z.infer<typeof OperatorPlanUpdate>, @Client() c: ClientInfo) {
    return this.operator.setPlan(op, id, body, c.ip);
  }

  @Post('tenants/:id/status')
  @HttpCode(200)
  @UseGuards(OperatorGuard)
  status(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(TenantTransition)) body: z.infer<typeof TenantTransition>, @Client() c: ClientInfo) {
    return this.operator.transition(op, id, body, c.ip);
  }

  @Post('tenants/:id/support')
  @UseGuards(OperatorGuard)
  support(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(SupportRequestCreate)) body: z.infer<typeof SupportRequestCreate>, @Client() c: ClientInfo) {
    return this.operator.requestSupport(op, id, body, c.ip);
  }

  @Post('tenants/:id/exports')
  @HttpCode(202)
  @UseGuards(OperatorGuard)
  exportTenant(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo) {
    return this.operator.requestExport(op, id, c.ip);
  }

  @Get('support')
  @UseGuards(OperatorGuard)
  grants(@CurrentOperator() op: OperatorPrincipal) {
    return this.operator.grants(op);
  }

  @Post('support/exit')
  @HttpCode(200)
  @UseGuards(OperatorExitGuard)
  exit(@CurrentOperator() op: OperatorPrincipal, @Req() req: FastifyRequest) {
    return this.operator.exit(op, req);
  }

  @Post('support/:id/cancel')
  @HttpCode(200)
  @UseGuards(OperatorGuard)
  cancel(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo) {
    return this.operator.cancel(op, id, c.ip);
  }

  @Post('support/:id/enter')
  @HttpCode(200)
  @UseGuards(OperatorGuard)
  enter(@CurrentOperator() op: OperatorPrincipal, @Param('id', new ParseUUIDPipe()) id: string, @Req() req: FastifyRequest) {
    return this.operator.enter(op, id, req);
  }
}
