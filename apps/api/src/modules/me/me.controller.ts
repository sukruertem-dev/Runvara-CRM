import { Body, Controller, Delete, Get, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { can, recordScope, type RecordAction, type RecordResource } from '@flexa/authz';
import { ChangePasswordRequest, TotpConfirmRequest, UI_CAPABILITIES, type z } from '@flexa/contracts';
import { eq, schema, sql, type DbHandle } from '@flexa/db';
import { MODULES } from '@flexa/modules';
import { decrypt, encrypt, generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp, type KeyRing } from '@flexa/security';
import { authEvent } from '../../common/audit';
import { AccessGuard, TenantGuard } from '../../common/guards';
import { ProblemError } from '../../common/problem';
import { Client, CurrentPrincipal, CurrentTenant, dbCtx, type ClientInfo, type Principal, type TenantRequestContext } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { DB, KEYRING } from '../../infra/tokens';
import { AuthService } from '../auth/auth.service';
import { SessionService } from '../auth/session.service';

/** Task capabilities map onto the generic record permissions (`*record*.<action>` on core.task). */
const TASK_CAPABILITY: Partial<Record<(typeof UI_CAPABILITIES)[number], RecordAction>> = {
  'task.create': 'create',
  'task.update': 'update',
  'task.delete': 'archive',
  'task.bulk': 'bulk',
};

/** Capabilities whose holders act by approving (a Manager's grant is `approve`, not `full`). */
const APPROVE_CAPABILITIES: ReadonlySet<string> = new Set(['sales_b2b.forecast.adjust', 'sales_b2c.return.approve']);
/** Capabilities whose holders may at least ask (a request grant is enough). */
const REQUEST_CAPABILITIES: ReadonlySet<string> = new Set(['sales_b2c.return.create']);

const RECORD_PERMISSION = /^(core\.task|crm\.(?:account|contact|lead|opportunity|case))\.(read|create|update|archive|purge|reassign|bulk)$/;

/** A menu entry's permission: record permissions (`core.task.read`) resolve through the record scope of the
 *  generic `*record*` grants (any scope counts); everything else through `can()` in read mode. */
function menuPermissionHeld(t: TenantRequestContext, perm: string): boolean {
  const m = RECORD_PERMISSION.exec(perm);
  if (m?.[1] && m[2]) return recordScope(t.authz, m[2] as RecordAction, m[1] as RecordResource).kind !== 'none';
  return can(t.authz, perm, 'read').allow;
}

@Controller('v1/me')
export class MeController {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    @Inject(KEYRING) private readonly keys: KeyRing,
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @UseGuards(AccessGuard)
  async me(@CurrentPrincipal() p: Principal) {
    const [user, tenants, operator] = await Promise.all([
      this.sessions.userSummary(p.userId),
      this.sessions.listTenants(p.userId),
      this.db.withUser(p.userId, async (tx) => (await tx.execute<{ ok: boolean }>(sql`SELECT app.is_operator() AS ok`)).rows[0]?.ok === true),
    ]);
    // A support session's tenant is not a membership; it is shown as the current tenant all the same.
    const supportTenant = p.support && p.tenantId ? { id: p.tenantId, slug: '', name: '', status: 'active', roles: ['support'] } : null;
    return { user, tenant: tenants.find((t) => t.id === p.tenantId) ?? supportTenant, tenants, operator };
  }

  /** Only enabled modules, and only menu items the user holds a permission for (AUTH-11, 10.5.1 §7). */
  @Get('navigation')
  @UseGuards(TenantGuard)
  async navigation(@CurrentTenant() t: TenantRequestContext) {
    const enabled = MODULES.filter((m) => t.authz.enabledModules.has(m.id));
    const menu = enabled.flatMap((m) =>
      m.menu
        .filter((item) => !item.salesModes || item.salesModes.includes(t.tenant.salesMode))
        .filter((item) => item.requires.some((perm) => menuPermissionHeld(t, perm)))
        .map((item) => ({ id: item.id, module: m.id, labelKey: item.labelKey, path: item.path, icon: item.icon })),
    );
    return {
      modules: enabled.map((m) => ({ id: m.id, displayNameKey: m.displayNameKey })),
      menu,
      roles: [...t.authz.roleKeys],
      segments: [...t.availableSegments],
      salesMode: t.tenant.salesMode,
      capabilities: UI_CAPABILITIES.filter((cap) => {
        const taskAction = TASK_CAPABILITY[cap];
        if (taskAction) return recordScope(t.authz, taskAction, 'core.task').kind !== 'none';
        return can(t.authz, cap, cap.endsWith('.read') ? 'read' : APPROVE_CAPABILITIES.has(cap) ? 'approve' : REQUEST_CAPABILITIES.has(cap) ? 'request' : 'full').allow;
      }),
      support: await this.supportState(t),
      tenantStatus: t.tenant.status as 'trial' | 'active' | 'suspended' | 'pending_deletion' | 'deleted',
    };
  }

  /** TEN-08: the operator sees their own support session; Admins see that support access is active. */
  private async supportState(t: TenantRequestContext) {
    const grantId = t.principal.support?.grantId ?? null;
    if (!grantId && !can(t.authz, 'tenant.config.manage').allow) return null;
    const row = await this.db.withTenant(dbCtx(t), async (tx) => (await tx.execute<{ id: string; operator_name: string; valid_until: Date | string }>(sql`
      SELECT id, operator_name, valid_until FROM support_access_grants
      WHERE status = 'approved' AND valid_until > now() ${grantId ? sql`AND id = ${grantId}` : sql``}
      ORDER BY valid_until DESC LIMIT 1`)).rows[0]);
    if (!row) return null;
    return { role: grantId ? ('operator' as const) : ('observed' as const), grantId: row.id, operatorName: row.operator_name, validUntil: new Date(row.valid_until).toISOString() };
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
    // The code just proved the second factor: the session counts as two-step verified (tenant policy, P7d).
    await this.sessions.addAmr(p.userId, p.sessionId, 'otp');
    await authEvent(this.db, { kind: 'auth.mfa_enabled', userId: p.userId, ip: client.ip, userAgent: client.userAgent });
    return { recoveryCodes: codes };
  }

  @Post('password')
  @HttpCode(204)
  @UseGuards(AccessGuard)
  async changePassword(@CurrentPrincipal() p: Principal, @Body(new ZodPipe(ChangePasswordRequest)) body: z.infer<typeof ChangePasswordRequest>, @Client() client: ClientInfo): Promise<void> {
    await this.auth.changePassword(p.userId, p.sessionId, body, client);
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
