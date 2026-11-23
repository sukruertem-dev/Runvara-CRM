import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { BlueprintApplyRequest, ConfigImportPreviewRequest, ConfigImportRequest, OnboardingChoice, type z } from '@flexa/contracts';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { blueprint } from './blueprints';
import { BundleService } from './bundle.service';

/** Configuration export/import, blueprints and onboarding (CFG-04/05, docs/p7-plan.md §7–8). */
@Controller('v1')
@UseGuards(TenantGuard)
export class BundleController {
  constructor(private readonly bundles: BundleService) {}

  @Get('config/export')
  export(@CurrentTenant() t: TenantRequestContext) {
    return this.bundles.export(t);
  }

  @Post('config/import/preview')
  @HttpCode(200)
  preview(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ConfigImportPreviewRequest)) body: z.infer<typeof ConfigImportPreviewRequest>) {
    return this.bundles.preview(t, body.bundle);
  }

  @Post('config/import')
  @HttpCode(200)
  import(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(ConfigImportRequest)) body: z.infer<typeof ConfigImportRequest>, @Client() c: ClientInfo) {
    return this.bundles.import(t, body.bundle, body.onConflict, body.note, c.ip, { kind: 'import' });
  }

  @Get('blueprints')
  blueprints(@CurrentTenant() t: TenantRequestContext) {
    return this.bundles.blueprints(t);
  }

  @Post('blueprints/:id/preview')
  @HttpCode(200)
  previewBlueprint(@CurrentTenant() t: TenantRequestContext, @Param('id') id: string) {
    authorize(t, 'tenant.config.manage');
    return this.bundles.preview(t, blueprint(id).bundle);
  }

  @Post('blueprints/:id/apply')
  @HttpCode(200)
  applyBlueprint(@CurrentTenant() t: TenantRequestContext, @Param('id') id: string, @Body(new ZodPipe(BlueprintApplyRequest)) body: z.infer<typeof BlueprintApplyRequest>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    return this.bundles.import(t, blueprint(id).bundle, body.onConflict, undefined, c.ip, { kind: 'blueprint', id });
  }

  @Get('onboarding')
  onboarding(@CurrentTenant() t: TenantRequestContext) {
    return this.bundles.onboardingState(t);
  }

  @Post('onboarding/preview')
  @HttpCode(200)
  previewOnboarding(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(OnboardingChoice)) body: z.infer<typeof OnboardingChoice>) {
    authorize(t, 'tenant.config.manage');
    return this.bundles.preview(t, this.bundles.onboardingBundle(body));
  }

  @Post('onboarding/complete')
  @HttpCode(200)
  completeOnboarding(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(OnboardingChoice)) body: z.infer<typeof OnboardingChoice>, @Client() c: ClientInfo) {
    return this.bundles.completeOnboarding(t, body, c.ip);
  }

  @Post('onboarding/skip')
  @HttpCode(200)
  skipOnboarding(@CurrentTenant() t: TenantRequestContext, @Client() c: ClientInfo) {
    return this.bundles.skipOnboarding(t, c.ip);
  }
}
