import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ForecastAdjust, ForecastQuery, ForecastSnapshotCreate, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { ForecastService } from './forecast.service';

const Id = new ParseUUIDPipe();

@Controller('v1/sales/b2b')
@UseGuards(TenantGuard)
export class ForecastController {
  constructor(private readonly svc: ForecastService) {}

  @Get('forecast')
  get(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(ForecastQuery)) q: z.infer<typeof ForecastQuery>) {
    return this.svc.get(t, q.period);
  }

  @Put('forecast/adjustments')
  adjust(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ForecastAdjust)) body: z.infer<typeof ForecastAdjust>) {
    return this.svc.adjust(t, body);
  }

  @Get('forecast/snapshots')
  snapshots(@CurrentTenant() t: TenantRequestContext, @Query(new ZodPipe(ForecastQuery)) q: z.infer<typeof ForecastQuery>) {
    return this.svc.listSnapshots(t, q.period);
  }

  @Post('forecast/snapshots')
  snapshot(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ForecastSnapshotCreate)) body: z.infer<typeof ForecastSnapshotCreate>) {
    return this.svc.takeSnapshot(t, body.period);
  }

  @Get('opportunities/stale')
  stale(@CurrentTenant() t: TenantRequestContext) {
    return this.svc.stale(t);
  }

  @Get('opportunities/:id/pulse')
  pulse(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string) {
    return this.svc.pulse(t, id);
  }
}
