import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ContractCreate, ContractListQuery, ContractPatch, ContractRenew, ContractTerminate, OrderCreate, OrderListQuery, OrderStatusSet, PipelineCreate, PipelinePatch, type z,
} from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { B2bService } from './b2b.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class B2bController {
  constructor(private readonly svc: B2bService) {}

  @Post('pipelines')
  createPipeline(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(PipelineCreate)) body: z.infer<typeof PipelineCreate>, @Client() c: ClientInfo) {
    return this.svc.createPipeline(t, body, c.ip);
  }

  @Patch('pipelines/:id')
  @HttpCode(204)
  async patchPipeline(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(PipelinePatch)) body: z.infer<typeof PipelinePatch>, @Client() c: ClientInfo): Promise<void> {
    await this.svc.patchPipeline(t, id, body, c.ip);
  }

  @Get('sales/b2b/contracts')
  listContracts(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(ContractListQuery)) q: z.infer<typeof ContractListQuery>) {
    return this.svc.listContracts(t, q);
  }

  @Post('sales/b2b/contracts')
  createContract(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ContractCreate)) body: z.infer<typeof ContractCreate>) {
    return this.svc.createContract(t, body);
  }

  @Get('sales/b2b/contracts/:id')
  getContract(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.getContract(t, id);
  }

  @Patch('sales/b2b/contracts/:id')
  patchContract(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(ContractPatch)) body: z.infer<typeof ContractPatch>) {
    return this.svc.patchContract(t, id, requireIfMatch(im), body);
  }

  @Post('sales/b2b/contracts/:id/terminate')
  @HttpCode(200)
  terminate(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ContractTerminate)) body: z.infer<typeof ContractTerminate>) {
    return this.svc.terminateContract(t, id, body);
  }

  @Post('sales/b2b/contracts/:id/renew')
  renew(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ContractRenew)) body: z.infer<typeof ContractRenew>) {
    return this.svc.renewContract(t, id, body);
  }

  @Get('sales/b2b/orders')
  listOrders(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(OrderListQuery)) q: z.infer<typeof OrderListQuery>) {
    return this.svc.listOrders(t, q);
  }

  @Post('sales/b2b/orders')
  createOrder(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(OrderCreate)) body: z.infer<typeof OrderCreate>) {
    return this.svc.createOrder(t, body);
  }

  @Get('sales/b2b/orders/:id')
  getOrder(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.getOrder(t, id);
  }

  @Post('sales/b2b/orders/:id/status')
  @HttpCode(200)
  setOrderStatus(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(OrderStatusSet)) body: z.infer<typeof OrderStatusSet>) {
    return this.svc.setOrderStatus(t, id, body);
  }
}
