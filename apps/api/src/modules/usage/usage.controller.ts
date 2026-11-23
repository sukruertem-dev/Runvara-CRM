import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../../common/guards';
import { CurrentTenant, type TenantRequestContext } from '../../common/request-context';
import { UsageService } from './usage.service';

@Controller('v1')
@UseGuards(TenantGuard)
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  @Get('usage')
  summary(@CurrentTenant() t: TenantRequestContext) {
    return this.usage.summary(t);
  }
}
