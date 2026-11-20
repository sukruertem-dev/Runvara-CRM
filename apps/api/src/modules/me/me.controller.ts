import { Body, Controller, Delete, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { can } from '@runvara/authz';
import { TotpConfirmRequest, type z } from '@runvara/contracts';
import { eq, schema, type DbHandle } from '@runvara/db';
import { MODULES } from '@runvara/modules';
import { decrypt, encrypt, generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp, type KeyRing } from '@runvara/security';
import { authEvent } from '../../common/audit';
import { AccessGuard, TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentPrincipal, CurrentTenant, type ClientInfo, type Principal, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB, KEYRING } from '../../infra/tokens';
import { SessionService } from '../auth/session.service';

@Controller('v1/me')
export class MeController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(KEYRING) private readonly keys: KeyRing,
    private readonly sessions: SessionService,
  ) {}

  @Get()
  @UseGuards(AccessGuard)
  async me(@CurrentPrincipal() p: Principal) {
    const [user, tenants] = await Promise.all([this.sessions.userSummary(p.userId), this.sessions.listTenants(p.userId)]);
    return { user, tenant: tenants.find((t) => t.id === p.tenantId) ?? null, tenants };
  }

  /** Only enabled modules, and only menu items the user holds a permission for (AUTH-11, 10.5.1 §7). */
  @Get('navigation')
  @UseGuards(TenantGuard)
  navigation(@CurrentTenant() t: TenantRequestContext) {
    const enabled = MODULES.filter((m) => t.authz.enabledModules.has(m.id));
    const menu = enabled.flatMap((m) =>
      m.menu
        .filter((item) => !item.salesModes || item.salesModes.includes(t.tenant.salesMode))
        .filter((item) => item.requires.some((perm) => can(t.authz, perm, 'read').allow))
        .map((item) => ({ id: item.id, module: m.id, labelKey: item.labelKey, path: item.path, icon: item.icon })),
    );
    return { modules: enabled.map((m) => ({ id: m.id, displayNameKey: m.displayNameKey })), menu };
  }

  @Post('mfa/totp/setup')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  async totpSetup(@CurrentPrincipal() p: Principal) {
    const user = await this.sessions.userSummary(p.userId);
    if (user.mfaEnabled) throw new ProblemError('MFA_ALREADY_ENABLED');
    const secret = generateTotpSecret();
    const enc = encrypt(this.keys.platformKey('mfa'), secret, `mfa:${p.userId}`);
    await this.db.withUser(p.userId, (tx) =>
      tx.insert(schema.userMfa).values({ userId: p.userId, totpSecretEnc: enc, totpEnabledAt: null, recoveryCodeHashes: [] })
        .onConflictDoUpdate({ target: schema.userMfa.userId, set: { totpSecretEnc: enc, totpEnabledAt: null, totpLastUsedStep: null, recoveryCodeHashes: [] } }));
    return { secret, otpauthUri: totpUri(secret, user.email) };
  }

  @Post('mfa/totp/confirm')
  @HttpCode(200)
  @UseGuards(AccessGuard)
  async totpConfirm(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(TotpConfirmRequest)) body: z.infer<typeof TotpConfirmRequest>, @Client() client: ClientInfo) {
    const { codes, hashes } = generateRecoveryCodes();
    const ok = await this.db.withUser(p.userId, async (tx) => {
      const [m] = await tx.select().from(schema.userMfa).where(eq(schema.userMfa.userId, p.userId));
      if (!m) return 'missing' as const;
      if (m.totpEnabledAt) return 'enabled' as const;
      const secret = decrypt(this.keys.platformKey('mfa'), m.totpSecretEnc, `mfa:${p.userId}`).toString();
      const step = verifyTotp(secret, body.code, null);
      if (step === null) return 'bad' as const;
      await tx.update(schema.userMfa).set({ totpEnabledAt: new Date(), totpLastUsedStep: step, recoveryCodeHashes: hashes }).where(eq(schema.userMfa.userId, p.userId));
      return 'ok' as const;
    });
    if (ok === 'enabled') throw new ProblemError('MFA_ALREADY_ENABLED');
    if (ok !== 'ok') throw new ProblemError('MFA_INVALID');
    await authEvent(this.db, { kind: 'auth.mfa_enabled', userId: p.userId, ip: client.ip, userAgent: client.userAgent });
    return { recoveryCodes: codes };
  }

  @Delete('mfa')
  @HttpCode(204)
  @UseGuards(AccessGuard)
  async totpDisable(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(TotpConfirmRequest)) body: z.infer<typeof TotpConfirmRequest>, @Client() client: ClientInfo): Promise<void> {
    const ok = await this.db.withUser(p.userId, async (tx) => {
      const [m] = await tx.select().from(schema.userMfa).where(eq(schema.userMfa.userId, p.userId));
      if (!m?.totpEnabledAt) return false;
      const secret = decrypt(this.keys.platformKey('mfa'), m.totpSecretEnc, `mfa:${p.userId}`).toString();
      if (verifyTotp(secret, body.code, m.totpLastUsedStep ?? null) === null) return false;
      await tx.delete(schema.userMfa).where(eq(schema.userMfa.userId, p.userId));
      return true;
    });
    if (!ok) throw new ProblemError('MFA_INVALID');
    await this.sessions.revokeAllSessions(p.userId, 'mfa_disabled', p.sessionId);
    await authEvent(this.db, { kind: 'auth.mfa_disabled', userId: p.userId, ip: client.ip, userAgent: client.userAgent });
  }
}
