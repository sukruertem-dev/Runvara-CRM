import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ConsentHistoryQuery, ConsentSet, CustomerAddressInput, CustomerAnonymize, CustomerListQuery, CustomerProfilePut, ReachabilityQuery, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { CustomersService } from './customers.service';

const Id = new ParseUUIDPipe();

@Controller('v1/sales/b2c/customers')
@UseGuards(TenantGuard)
export class CustomersController {
  constructor(private readonly svc: CustomersService) {}

  @Get()
  list(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(CustomerListQuery)) q: z.infer<typeof CustomerListQuery>) {
    return this.svc.list(t, q);
  }

  @Get(':id')
  get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.get(t, id);
  }

  @Put(':id/profile')
  profile(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(CustomerProfilePut)) body: z.infer<typeof CustomerProfilePut>) {
    return this.svc.putProfile(t, id, requireIfMatch(im), body);
  }

  @Post(':id/addresses')
  addAddress(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(CustomerAddressInput)) body: z.infer<typeof CustomerAddressInput>) {
    return this.svc.addAddress(t, id, body);
  }

  @Put(':id/addresses/:addressId')
  putAddress(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('addressId', Id) addressId: string, @Body(new ZodPipe(CustomerAddressInput)) body: z.infer<typeof CustomerAddressInput>) {
    return this.svc.putAddress(t, id, addressId, body);
  }

  @Delete(':id/addresses/:addressId')
  @HttpCode(200)
  deleteAddress(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Param('addressId', Id) addressId: string) {
    return this.svc.deleteAddress(t, id, addressId);
  }

  @Post(':id/consents')
  @HttpCode(200)
  consent(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(ConsentSet)) body: z.infer<typeof ConsentSet>) {
    return this.svc.setConsent(t, id, body);
  }

  @Get(':id/consents/history')
  history(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Query(new ZodPipe(ConsentHistoryQuery)) q: z.infer<typeof ConsentHistoryQuery>) {
    return this.svc.history(t, id, q.cursor, q.limit);
  }

  @Get(':id/export')
  export(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.export(t, id);
  }

  @Post(':id/anonymize')
  @HttpCode(200)
  anonymize(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(CustomerAnonymize)) body: z.infer<typeof CustomerAnonymize>) {
    return this.svc.anonymize(t, id, body);
  }

  @Get(':id/reachability')
  reachability(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Query(new ZodPipe(ReachabilityQuery)) q: z.infer<typeof ReachabilityQuery>) {
    return this.svc.reachable(t, id, q.channel);
  }
}
