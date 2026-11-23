import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { BrandLogoUpload, ConfigRevert, ConfigWrite, ConfigWriteScope, LOGO_MAX_BYTES, type z } from '@flexa/contracts';
import type { JsonObject } from '@flexa/config';
import { sql, type DbHandle } from '@flexa/db';
import type { FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { audit } from '../../common/audit';
import { authorize } from '../../common/authorize';
import { etag, requireIfMatch } from '../../common/http-helpers';
import { TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentTenant, dbCtx, type ClientInfo, type TenantRequestContext } from '../../common/request-context';
import { sanitizeSvg } from '../../common/svg';
import { ZodPipe } from '../../common/zod.pipe';
import { DB } from '../../infra/tokens';
import { ConfigService, type WriteScope } from './config.service';
import { QuotaService } from '../usage/quota.service';

function scopeOf(raw: string | undefined): WriteScope {
  const r = ConfigWriteScope.safeParse(raw ?? 'tenant');
  if (!r.success) throw new ProblemError('VALIDATION_FAILED', 'scope must be tenant or user');
  return r.data;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (b: Buffer): boolean => b.subarray(0, 8).equals(PNG);
const isWebp = (b: Buffer): boolean => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';

@Controller('v1')
@UseGuards(TenantGuard)
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    @Inject(DB) private readonly db: DbHandle,
    private readonly quota: QuotaService,
  ) {}

  @Get('config')
  effective(@CurrentTenant() t: TenantRequestContext) {
    return this.config.effective(t);
  }

  @Get('config/keys')
  keys(@CurrentTenant() t: TenantRequestContext) {
    return this.config.keys(t);
  }

  @Get('config/:key')
  async layer(@CurrentTenant() t: TenantRequestContext, @Param('key') key: string, @Query('scope') scope: string | undefined, @Res({ passthrough: true }) reply: FastifyReply) {
    const view = await this.config.layer(t, key, scopeOf(scope));
    void reply.header('etag', etag(view.version));
    return view;
  }

  @Put('config/:key')
  async write(
    @CurrentTenant() t: TenantRequestContext,
    @Param('key') key: string,
    @Query('scope') scope: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(ConfigWrite)) body: z.infer<typeof ConfigWrite>,
    @Client() c: ClientInfo,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = await this.config.write(t, key, scopeOf(scope), body.value as JsonObject, requireIfMatch(ifMatch), body.note, c);
    void reply.header('etag', etag(view.version));
    return view;
  }

  @Delete('config/:key')
  @HttpCode(200)
  async removeOverride(
    @CurrentTenant() t: TenantRequestContext,
    @Param('key') key: string,
    @Query('scope') scope: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Client() c: ClientInfo,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Only a user's own override can be removed; the tenant layer is changed or reverted, never emptied.
    if (scopeOf(scope) !== 'user') throw new ProblemError('VALIDATION_FAILED', 'only scope=user overrides can be removed');
    const view = await this.config.write(t, key, 'user', {}, requireIfMatch(ifMatch), undefined, c);
    void reply.header('etag', etag(view.version));
    return view;
  }

  @Post('config/:key/preview')
  @HttpCode(200)
  preview(@CurrentTenant() t: TenantRequestContext, @Param('key') key: string, @Query('scope') scope: string | undefined, @Body(new ZodPipe(ConfigWrite)) body: z.infer<typeof ConfigWrite>) {
    return this.config.preview(t, key, scopeOf(scope), body.value as JsonObject);
  }

  @Get('config/:key/history')
  history(@CurrentTenant() t: TenantRequestContext, @Param('key') key: string, @Query('scope') scope: string | undefined) {
    return this.config.history(t, key, scopeOf(scope));
  }

  @Post('config/:key/revert')
  @HttpCode(200)
  async revert(
    @CurrentTenant() t: TenantRequestContext,
    @Param('key') key: string,
    @Query('scope') scope: string | undefined,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodPipe(ConfigRevert)) body: z.infer<typeof ConfigRevert>,
    @Client() c: ClientInfo,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const view = await this.config.revert(t, key, scopeOf(scope), body.version, requireIfMatch(ifMatch), body.note, c);
    void reply.header('etag', etag(view.version));
    return view;
  }

  @Post('brand/logo')
  async uploadLogo(@CurrentTenant() t: TenantRequestContext, @Body(new ZodPipe(BrandLogoUpload)) body: z.infer<typeof BrandLogoUpload>, @Client() c: ClientInfo) {
    authorize(t, 'tenant.config.manage');
    let bytes = Buffer.from(body.dataBase64, 'base64');
    if (bytes.length === 0 || bytes.length > LOGO_MAX_BYTES) throw new ProblemError('ASSET_INVALID', `logo must be 1 byte to ${String(LOGO_MAX_BYTES / 1024)} KB`);
    let removed: string[] = [];
    if (body.mime === 'image/svg+xml') {
      const r = sanitizeSvg(bytes.toString('utf8'));
      bytes = Buffer.from(r.svg, 'utf8');
      removed = r.removed;
    } else if ((body.mime === 'image/png' && !isPng(bytes)) || (body.mime === 'image/webp' && !isWebp(bytes))) {
      throw new ProblemError('ASSET_INVALID', `file content is not ${body.mime}`);
    }
    const sha = createHash('sha256').update(bytes).digest();
    return this.db.withTenant(dbCtx(t), async (tx) => {
      await this.quota.assert(tx, t, 'storage_bytes', bytes.length, 'soft');
      const row = (await tx.execute<{ id: string }>(sql`
        INSERT INTO tenant_assets (tenant_id, kind, mime, bytes, sha256, created_by)
        VALUES (${t.tenant.id}, 'logo', ${body.mime}, ${bytes}, ${sha}, ${t.principal.userId}) RETURNING id`)).rows[0];
      if (!row) throw new Error('asset insert returned no row');
      await audit(tx, t.tenant.id, { action: 'brand.logo_uploaded', actorId: t.principal.userId, targetType: 'asset', targetId: row.id, ip: c.ip, details: { mime: body.mime, sizeBytes: bytes.length, removed } });
      return { assetId: row.id, mime: body.mime, sizeBytes: bytes.length, sanitized: removed.length > 0 };
    });
  }

  @Get('brand/logo')
  async logo(@CurrentTenant() t: TenantRequestContext, @Res() reply: FastifyReply): Promise<void> {
    const eff = await this.config.effective(t);
    const id = eff.brand.logo?.assetId;
    if (!id) throw new ProblemError('NOT_FOUND');
    const row = await this.db.withTenant(dbCtx(t), async (tx) =>
      (await tx.execute<{ mime: string; bytes: Buffer; sha256: Buffer }>(sql`SELECT mime, bytes, sha256 FROM tenant_assets WHERE id = ${id}`)).rows[0]);
    if (!row) throw new ProblemError('NOT_FOUND');
    await reply
      .header('content-type', row.mime)
      .header('etag', `"${row.sha256.toString('hex')}"`)
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      // An SVG opened directly must not run anything, even after sanitizing.
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(row.bytes);
  }
}
