import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { ApiEnv } from '@runvara/config';
import { CreateSsoProviderRequest, type z } from '@runvara/contracts';
import { schema, type DbHandle } from '@runvara/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB, ENV } from '../../infra/tokens';
import { SessionService } from '../auth/session.service';
import { OidcService } from './oidc.service';

type ProviderRow = typeof schema.tenantSsoProviders.$inferSelect;
const view = (p: ProviderRow) => ({ id: p.id, name: p.name, issuer: p.issuer, clientId: p.clientId, emailDomains: p.emailDomains, jitEnabled: p.jitEnabled, enabled: p.enabled });

@Controller('v1')
export class SsoController {
  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    private readonly oidc: OidcService,
    private readonly sessions: SessionService,
  ) {}

  @Get('sso-providers')
  @UseGuards(TenantGuard)
  async list(@CurrentTenant() t: TenantRequestContext) {
    authorize(t, 'tenant.config.manage');
    const rows = await this.db.withTenant({ tenantId: t.tenant.id, userId: t.principal.userId }, (tx) => tx.select().from(schema.tenantSsoProviders));
    return rows.map(view);
  }

  @Post('sso-providers')
  @UseGuards(TenantGuard)
  async create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(CreateSsoProviderRequest)) body: z.infer<typeof CreateSsoProviderRequest>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    return view(await this.oidc.createProvider(t.tenant.id, t.principal.userId, body, c.ip));
  }

  @Get('auth/oidc/:providerId/start')
  async start(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Res() reply: FastifyReply): Promise<void> {
    await reply.redirect(await this.oidc.start(providerId), 302);
  }

  @Get('auth/oidc/:providerId/callback')
  async callback(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply, @Client() c: ClientInfo): Promise<void> {
    const url = new URL(req.url, this.oidc.redirectUri(providerId));
    if (url.searchParams.has('error')) throw new ProblemError('VALIDATION_FAILED', `identity provider error: ${url.searchParams.get('error')}`);
    const { userId, tenantId } = await this.oidc.callback(providerId, url);
    // The browser gets only the refresh cookie; the web app exchanges it for an access token (/v1/auth/refresh).
    await this.sessions.start(userId, ['oidc'], c, reply, tenantId);
    await reply.redirect(new URL('/auth/callback', this.env.WEB_BASE_URL).toString(), 302);
  }
}
