import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CampaignCreate, CampaignListQuery, CampaignPatch, CouponCheckQuery, CouponCreate, CouponPatch, RfmQuery, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { CampaignsService } from './campaigns.service';
import { RfmService } from './rfm.service';

const Id = new ParseUUIDPipe();

@Controller('v1/sales/b2c')
@UseGuards(TenantGuard)
export class CampaignsController {
  constructor(private readonly svc: CampaignsService, private readonly rfm: RfmService) {}

  @Get('campaigns')
  list(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(CampaignListQuery)) q: z.infer<typeof CampaignListQuery>) {
    return this.svc.list(t, q.status);
  }

  @Post('campaigns')
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(CampaignCreate)) body: z.infer<typeof CampaignCreate>) {
    return this.svc.create(t, body);
  }

  @Get('campaigns/:id')
  get(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.get(t, id);
  }

  @Patch('campaigns/:id')
  patch(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Headers('if-match') im: string | undefined, @Body(new ZodPipe(CampaignPatch)) body: z.infer<typeof CampaignPatch>) {
    return this.svc.patch(t, id, requireIfMatch(im), body);
  }

  @Post('campaigns/:id/submit')
  @HttpCode(200)
  submit(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.submit(t, id);
  }

  @Post('campaigns/:id/approve')
  @HttpCode(200)
  approve(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.approve(t, id);
  }

  @Post('campaigns/:id/reject')
  @HttpCode(200)
  reject(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.reject(t, id);
  }

  @Post('campaigns/:id/cancel')
  @HttpCode(200)
  cancel(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.cancel(t, id);
  }

  @Get('campaigns/:id/audience')
  audience(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.audience(t, id);
  }

  @Post('campaigns/:id/send')
  @HttpCode(200)
  send(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.send(t, id);
  }

  @Post('campaigns/:id/coupons')
  addCoupon(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(CouponCreate)) body: z.infer<typeof CouponCreate>) {
    return this.svc.addCoupon(t, id, body);
  }

  @Get('coupons/check')
  check(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(CouponCheckQuery)) q: z.infer<typeof CouponCheckQuery>) {
    return this.svc.check(t, q.code, q.customerId);
  }

  @Patch('coupons/:id')
  patchCoupon(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string, @Body(new ZodPipe(CouponPatch)) body: z.infer<typeof CouponPatch>) {
    return this.svc.patchCoupon(t, id, body.active);
  }

  @Get('rfm')
  rfmSummary(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(RfmQuery)) q: z.infer<typeof RfmQuery>) {
    return this.rfm.summary(t, q.segment, q.limit);
  }

  @Post('rfm/recompute')
  @HttpCode(200)
  recompute(@CurrentTenant() t: TenantRequestContext) {
    return this.rfm.recomputeNow(t);
  }
}
