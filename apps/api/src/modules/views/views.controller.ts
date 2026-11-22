import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { DashboardLayout, SavedViewCreate, SavedViewPatch, type z } from '@flexa/contracts';
import { TenantGuard } from '../../common/guards';
import { requireIfMatch } from '../../common/http-helpers';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { ViewsService } from './views.service';

const Id = new ParseUUIDPipe();

@Controller('v1')
@UseGuards(TenantGuard)
export class ViewsController {
  constructor(private readonly views: ViewsService) {}

  @Get('views')
  list(@CurrentTenant() t: TenantRequestContext, @Query('resource') resource: string | undefined) {
    return this.views.list(t, resource);
  }

  @Post('views')
  create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(SavedViewCreate)) body: z.infer<typeof SavedViewCreate>) {
    return this.views.create(t, body);
  }

  @Patch('views/:id')
  update(
    @CurrentTenant() t: TenantRequestContext,
    @Param('id', Id) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(SavedViewPatch)) body: z.infer<typeof SavedViewPatch>,
  ) {
    return this.views.update(t, id, requireIfMatch(ifMatch), body);
  }

  @Delete('views/:id')
  @HttpCode(204)
  async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', Id) id: string): Promise<void> {
    await this.views.remove(t, id);
  }

  @Get('me/dashboard')
  dashboard(@CurrentTenant() t: TenantRequestContext) {
    return this.views.dashboard(t);
  }

  @Put('me/dashboard')
  saveDashboard(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(DashboardLayout)) body: z.infer<typeof DashboardLayout>) {
    return this.views.saveDashboard(t, body);
  }
}
