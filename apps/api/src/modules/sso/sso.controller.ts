import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { RouteConfig } from '@nestjs/platform-fastify';
import type { ApiEnv } from '@flexa/config';
import { CreateSsoProviderRequest, EmailOnlyRequest, UpdateSsoProviderRequest, type z } from '@flexa/contracts';
import { sql, type DbHandle } from '@flexa/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authorize } from '../../common/authorize';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB, ENV } from '../../infra/tokens';
import { ssoStartUrl } from '../auth/security-policy.service';
import { SessionService } from '../auth/session.service';
import { OidcService } from './oidc.service';
import { SamlService } from './saml.service';
import { SsoProvidersService } from './sso-providers.service';

/** Marks unauthenticated auth endpoints; app.ts applies AUTH_RATE_LIMIT_PER_MINUTE per IP to them. */
const AUTH_RATE = { authRateLimit: true };

@Controller('v1')
export class SsoController {
  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    private readonly providers: SsoProvidersService,
    private readonly oidc: OidcService,
    private readonly saml: SamlService,
    private readonly sessions: SessionService,
  ) {}

  // ------------------------------------------------------------------ provider management (Admin)
  @Get('sso-providers')
  @UseGuards(TenantGuard)
  async list(@CurrentTenant() t: TenantRequestContext) {
    authorize(t, 'tenant.config.manage');
    const rows = await this.db.withTenant(dbCtx(t), (tx) => this.providers.list(tx));
    return rows.map((p) => this.providers.view(p));
  }

  @Post('sso-providers')
  @UseGuards(TenantGuard)
  async create(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(CreateSsoProviderRequest)) body: z.infer<typeof CreateSsoProviderRequest>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    return this.providers.view(await this.providers.create(t.tenant.id, t.principal.userId, body, c.ip));
  }

  @Patch('sso-providers/:id')
  @UseGuards(TenantGuard)
  async update(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(UpdateSsoProviderRequest)) body: z.infer<typeof UpdateSsoProviderRequest>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    const row = await this.providers.update(t.tenant.id, t.principal.userId, id, body, c.ip);
    this.oidc.forget(id);
    return this.providers.view(row);
  }

  @Delete('sso-providers/:id')
  @HttpCode(204)
  @UseGuards(TenantGuard)
  async remove(@CurrentTenant() t: TenantRequestContext, @Param('id', new ParseUUIDPipe()) id: string, @Client() c: ClientInfo): Promise<void> {
    authorize(t, 'tenant.config.manage');
    await this.providers.remove(t.tenant.id, t.principal.userId, id, c.ip);
    this.oidc.forget(id);
  }

  // ------------------------------------------------------------------ login
  /** Providers for an e-mail's domain: names and start links only, never which workspace they belong to. */
  @Post('auth/sso/discover')
  @HttpCode(200)
  @RouteConfig(AUTH_RATE)
  async discover(@Body(new ZodPipe(EmailOnlyRequest)) body: z.infer<typeof EmailOnlyRequest>) {
    const domain = body.email.split('@')[1] ?? '';
    const rows = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ id: string; name: string; kind: 'oidc' | 'saml' }>(sql`SELECT id, name, kind FROM app.sso_providers_for_domain(${domain})`)).rows);
    return { providers: rows.map((p) => ({ ...p, startUrl: ssoStartUrl(this.env.API_PUBLIC_URL, p.kind, p.id) })) };
  }

  @Get('auth/oidc/:providerId/start')
  async oidcStart(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Res() reply: FastifyReply): Promise<void> {
    await reply.redirect(await this.oidc.start(providerId), 302);
  }

  @Get('auth/oidc/:providerId/callback')
  async oidcCallback(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply, @Client() c: ClientInfo): Promise<void> {
    const url = new URL(req.url, this.oidc.redirectUri(providerId));
    if (url.searchParams.has('error')) throw new ProblemError('VALIDATION_FAILED', `identity provider error: ${url.searchParams.get('error')}`);
    const { userId, tenantId } = await this.oidc.callback(providerId, url);
    await this.finish(userId, tenantId, 'oidc', c, reply);
  }

  @Get('auth/saml/:providerId/metadata')
  async samlMetadata(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Res() reply: FastifyReply): Promise<void> {
    const xml = await this.saml.metadata(providerId);
    await reply.header('content-type', 'application/samlmetadata+xml; charset=utf-8').send(xml);
  }

  @Get('auth/saml/:providerId/start')
  async samlStart(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Res() reply: FastifyReply): Promise<void> {
    await reply.redirect(await this.saml.start(providerId), 302);
  }

  /** HTTP-POST binding: the IdP's page posts the form here (application/x-www-form-urlencoded). */
  @Post('auth/saml/:providerId/acs')
  @RouteConfig(AUTH_RATE)
  async samlAcs(@Param('providerId', new ParseUUIDPipe()) providerId: string, @Req() req: FastifyRequest, @Res() reply: FastifyReply, @Client() c: ClientInfo): Promise<void> {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, string>;
    const { userId, tenantId } = await this.saml.acs(providerId, body);
    await this.finish(userId, tenantId, 'saml', c, reply);
  }

  /** The browser gets only the refresh cookie; the web app exchanges it for an access token (/v1/auth/refresh). */
  private async finish(userId: string, tenantId: string, method: 'oidc' | 'saml', c: ClientInfo, reply: FastifyReply): Promise<void> {
    await this.sessions.start(userId, [method], c, reply, tenantId);
    await reply.redirect(new URL('/auth/callback', this.env.WEB_BASE_URL).toString(), 302);
  }
}
