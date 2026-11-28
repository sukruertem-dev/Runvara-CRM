import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { B2cOrderBulkStep, B2cOrderCreate, B2cOrderListQuery, B2cOrderPayment, B2cOrderStepRequest, ReturnCreate, ReturnDecision, ReturnListQuery, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { OrdersService } from './orders.service';

const Id = new ParseUUIDPipe();

@Controller('v1/sales/b2c')
@UseGuards(TenantGuard)
export class OrdersController {
  constructor(private readonly svc: OrdersService) {}

  @Get('orders')
  list(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(B2cOrderListQuery)) q: z.infer<typeof B2cOrderListQuery>) {
    return this.svc.listOrders(t, q);
  }

  @Post('orders')
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(B2cOrderCreate)) body: z.infer<typeof B2cOrderCreate>) {
    return this.svc.createOrder(t, body);
  }

  @Post('orders/steps')
  @HttpCode(200)
  bulk(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(B2cOrderBulkStep)) body: z.infer<typeof B2cOrderBulkStep>) {
    return this.svc.bulkStep(t, body);
  }

  @Get('orders/:id')
  get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.getOrder(t, id);
  }

  @Post('orders/:id/step')
  @HttpCode(200)
  step(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(B2cOrderStepRequest)) body: z.infer<typeof B2cOrderStepRequest>) {
    return this.svc.step(t, id, body);
  }

  @Post('orders/:id/payment')
  @HttpCode(200)
  payment(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(B2cOrderPayment)) body: z.infer<typeof B2cOrderPayment>) {
    return this.svc.payment(t, id, body);
  }

  @Get('returns')
  returns(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(ReturnListQuery)) q: z.infer<typeof ReturnListQuery>) {
    return this.svc.listReturns(t, q);
  }

  @Post('returns')
  createReturn(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ReturnCreate)) body: z.infer<typeof ReturnCreate>) {
    return this.svc.createReturn(t, body);
  }

  @Get('returns/:id')
  getReturn(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.getReturn(t, id);
  }

  @Post('returns/:id/decision')
  @HttpCode(200)
  decide(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ReturnDecision)) body: z.infer<typeof ReturnDecision>) {
    return this.svc.decide(t, id, body);
  }

  @Post('returns/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.cancelReturn(t, id);
  }
}
