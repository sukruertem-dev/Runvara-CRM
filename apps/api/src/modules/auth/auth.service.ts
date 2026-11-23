import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { and, eq, isNull, schema, sql, type DbHandle } from '@flexa/db';
import {
  checkPasswordPolicy,
  decrypt,
  dummyPasswordHash,
  hashPassword,
  hashRecoveryCode,
  passwordProfile,
  randomToken,
  sha256,
  verifyPassword,
  verifyTotp,
  type KeyRing,
  type TokenSigner,
} from '@flexa/security';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authEvent } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import type { ClientInfo } from '../../common/request-context';
import { FailureThrottle } from '../../common/throttle';
import { DB, ENV, KEYRING, MAILER, REDIS, SIGNER, type Mailer, type Redis } from '../../infra/tokens';
import { ProvisioningService } from '../tenancy/provisioning.service';
import { SecurityPolicyService } from './security-policy.service';
import { SessionService } from './session.service';

const EMAIL_TOKEN_TTL_MS = 30 * 60_000;
const MFA_TOKEN_TTL_S = 300;
type Locale = 'tr-TR' | 'en-US';
const asLocale = (l: string): Locale => (l === 'en-US' ? 'en-US' : 'tr-TR');

export function assertPassword(password: string, email?: string): void {
  const policy = checkPasswordPolicy(password, email);
  if (!policy.ok) throw new ProblemError('PASSWORD_POLICY', undefined, { reasons: policy.reasons });
}

@Injectable()
export class AuthService {
  private readonly loginThrottle: FailureThrottle;
  private readonly ipThrottle: FailureThrottle;
  private readonly mfaThrottle: FailureThrottle;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) redis: Redis,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(SIGNER) private readonly signer: TokenSigner,
    @Inject(KEYRING) private readonly keys: KeyRing,
    private readonly sessions: SessionService,
    private readonly provisioning: ProvisioningService,
    private readonly policy: SecurityPolicyService,
  ) {
    this.loginThrottle = new FailureThrottle(redis, 'login-account', 10, 15 * 60);
    this.ipThrottle = new FailureThrottle(redis, 'login-ip', 50, 15 * 60);
    this.mfaThrottle = new FailureThrottle(redis, 'mfa', 5, 15 * 60);
  }

  // ------------------------------------------------------------------ sign-up & e-mail verification
  async signup(input: { email: string; password: string; displayName: string; tenantName: string; tenantSlug: string; locale: Locale }, client: ClientInfo): Promise<void> {
    assertPassword(input.password, input.email);
    if (await this.emailRegistered(input.email)) {
      // Same response as success (no account enumeration); the owner is told by e-mail.
      await this.mailer.send({ template: 'signup_exists', to: input.email, locale: input.locale, vars: { loginUrl: this.web('/login'), resetUrl: this.web('/forgot-password') } });
      return;
    }
    if (!(await this.provisioning.slugAvailable(input.tenantSlug))) throw new ProblemError('SLUG_TAKEN');
    const passwordHash = await hashPassword(input.password);
    const { userId } = await this.provisioning.createTenantWithAdmin({
      slug: input.tenantSlug, name: input.tenantName, locale: input.locale, ip: client.ip,
      admin: { email: input.email, displayName: input.displayName, passwordHash, locale: input.locale },
    });
    await this.sendVerification(userId, input.email, input.displayName, input.locale);
  }

  async verifyEmail(token: string): Promise<void> {
    const userId = await this.consume(token, 'verify_email');
    await this.db.withUser(userId, (tx) => tx.update(schema.users).set({ emailVerifiedAt: new Date() }).where(and(eq(schema.users.id, userId), isNull(schema.users.emailVerifiedAt))));
  }

  async resendVerification(email: string): Promise<void> {
    const found = await this.findForLogin(email);
    if (!found || found.email_verified) return;
    const user = await this.sessions.userSummary(found.user_id);
    await this.sendVerification(user.id, user.email, user.displayName, asLocale(user.locale));
  }

  // ------------------------------------------------------------------ login
  async login(email: string, password: string, client: ClientInfo, reply: FastifyReply) {
    await this.ipThrottle.assertAllowed(client.ip);
    await this.loginThrottle.assertAllowed(email);
    const found = await this.findForLogin(email);
    const ok = await verifyPassword(found?.password_hash ?? (await dummyPasswordHash()), password);
    if (!found || !found.password_hash || !ok) {
      await this.loginThrottle.fail(email);
      await this.ipThrottle.fail(client.ip);
      await authEvent(this.db, { kind: 'auth.login_failed', userId: found?.user_id ?? null, ip: client.ip, userAgent: client.userAgent, details: { reason: 'credentials' } });
      throw new ProblemError('INVALID_CREDENTIALS');
    }
    await this.loginThrottle.reset(email);
    if (found.status !== 'active') throw new ProblemError('ACCOUNT_DISABLED');
    if (!found.email_verified) throw new ProblemError('EMAIL_NOT_VERIFIED');
    // The measure of the password (never the password) travels to the session for tenant rules (B77).
    const pwd = passwordProfile(password);
    if (found.mfa_enabled) {
      const mfaToken = await this.signer.signPurpose({ sub: found.user_id, purpose: 'mfa', amr: ['pwd'], pwd }, MFA_TOKEN_TTL_S);
      return { next: 'mfa' as const, mfaToken, expiresIn: MFA_TOKEN_TTL_S };
    }
    return this.completeLogin(found.user_id, ['pwd'], client, reply, pwd);
  }

  async verifyMfa(input: { mfaToken: string; code?: string | undefined; recoveryCode?: string | undefined }, client: ClientInfo, reply: FastifyReply) {
    const t = await this.signer.verifyPurpose(input.mfaToken, 'mfa');
    if (!t.ok) throw new ProblemError('MFA_INVALID', 'MFA challenge expired or invalid');
    const userId = t.claims.sub;
    await this.secondFactor(userId, input, client);
    return this.completeLogin(userId, input.code ? ['pwd', 'otp'] : ['pwd', 'recovery'], client, reply, t.claims.pwd);
  }

  /** Adds a second factor to a session that was opened without one, for a tenant whose policy requires it. */
  async stepUp(userId: string, sessionId: string, input: { code?: string | undefined; recoveryCode?: string | undefined }, client: ClientInfo, req: FastifyRequest) {
    await this.secondFactor(userId, input, client);
    await this.sessions.addAmr(userId, sessionId, input.code ? 'otp' : 'recovery');
    await authEvent(this.db, { kind: 'auth.step_up', userId, ip: client.ip, userAgent: client.userAgent, details: { sessionId } });
    return this.sessions.reissue(userId, sessionId, req);
  }

  /** Verifies a TOTP or a recovery code (single use, throttled). Throws MFA_INVALID. */
  private async secondFactor(userId: string, input: { code?: string | undefined; recoveryCode?: string | undefined }, client: ClientInfo): Promise<void> {
    await this.mfaThrottle.assertAllowed(userId);
    const ok = await this.db.withUser(userId, async (tx) => {
      const [m] = await tx.select().from(schema.userMfa).where(eq(schema.userMfa.userId, userId));
      if (!m?.totpEnabledAt) return false;
      if (input.code) {
        const secret = decrypt(this.keys.platformKey('mfa'), m.totpSecretEnc, `mfa:${userId}`).toString();
        const step = verifyTotp(secret, input.code, m.totpLastUsedStep ?? null);
        if (step === null) return false;
        // Conditional update makes replay impossible even for two concurrent requests with the same code.
        const r = await tx.execute(sql`UPDATE user_mfa SET totp_last_used_step = ${step}
                                       WHERE user_id = ${userId} AND (totp_last_used_step IS NULL OR totp_last_used_step < ${step})`);
        return (r.rowCount ?? 0) === 1;
      }
      const hash = hashRecoveryCode(input.recoveryCode ?? '');
      if (!m.recoveryCodeHashes.includes(hash)) return false;
      await tx.update(schema.userMfa).set({ recoveryCodeHashes: m.recoveryCodeHashes.filter((h) => h !== hash) }).where(eq(schema.userMfa.userId, userId));
      return true;
    });
    if (!ok) {
      await this.mfaThrottle.fail(userId);
      await authEvent(this.db, { kind: 'auth.mfa_failed', userId, ip: client.ip, userAgent: client.userAgent });
      throw new ProblemError('MFA_INVALID');
    }
    await this.mfaThrottle.reset(userId);
  }

  async completeLogin(userId: string, amr: string[], client: ClientInfo, reply: FastifyReply, pwd?: { length: number; mixed: boolean }) {
    const s = await this.sessions.start(userId, amr, client, reply, undefined, pwd);
    const user = await this.sessions.userSummary(userId);
    return { next: s.tenant ? ('done' as const) : ('select_tenant' as const), accessToken: s.accessToken, expiresIn: s.expiresIn, csrfToken: s.csrfToken, tenant: s.tenant, tenants: s.tenants, user };
  }

  // ------------------------------------------------------------------ password reset
  async forgotPassword(email: string): Promise<void> {
    const found = await this.findForLogin(email);
    if (!found) return; // same 202 either way
    const user = await this.sessions.userSummary(found.user_id);
    const token = await this.issueEmailToken(user.id, 'reset_password');
    await this.mailer.send({ template: 'reset_password', to: user.email, locale: asLocale(user.locale), vars: { displayName: user.displayName, url: this.web(`/reset-password?token=${token}`) } });
  }

  async resetPassword(token: string, password: string, client: ClientInfo): Promise<void> {
    const owner = await this.peekEmailTokenOwner(token, 'reset_password');
    if (!owner) throw new ProblemError('TOKEN_INVALID');
    const user = await this.sessions.userSummary(owner);
    assertPassword(password, user.email);
    const consumed = await this.consume(token, 'reset_password');
    const passwordHash = await hashPassword(password);
    await this.db.withUser(consumed, async (tx) => {
      await tx.update(schema.userCredentials).set({ passwordHash }).where(eq(schema.userCredentials.userId, consumed));
      // A reset link proves mailbox control: mark the address verified.
      await tx.update(schema.users).set({ emailVerifiedAt: new Date() }).where(and(eq(schema.users.id, consumed), isNull(schema.users.emailVerifiedAt)));
    });
    await this.sessions.revokeAllSessions(consumed, 'password_reset');
    await authEvent(this.db, { kind: 'auth.password_reset', userId: consumed, ip: client.ip, userAgent: client.userAgent });
  }

  /** Password change by the signed-in person (current password required). With `tenantId` the new password
   *  must also satisfy that tenant's rules (the "password change required" screen). Other sessions end. */
  async changePassword(userId: string, sessionId: string, input: { currentPassword: string; newPassword: string; tenantId?: string | undefined }, client: ClientInfo): Promise<void> {
    const user = await this.sessions.userSummary(userId);
    await this.loginThrottle.assertAllowed(user.email);
    const stored = await this.db.withUser(userId, async (tx) =>
      (await tx.select({ hash: schema.userCredentials.passwordHash }).from(schema.userCredentials).where(eq(schema.userCredentials.userId, userId)))[0]?.hash ?? null);
    if (!stored || !(await verifyPassword(stored, input.currentPassword))) {
      await this.loginThrottle.fail(user.email);
      await authEvent(this.db, { kind: 'auth.password_change_failed', userId, ip: client.ip, userAgent: client.userAgent });
      throw new ProblemError('INVALID_CREDENTIALS');
    }
    await this.loginThrottle.reset(user.email);
    assertPassword(input.newPassword, user.email);
    const profile = passwordProfile(input.newPassword);
    const reasons: string[] = [];
    let rules: { minLength: number; requireMixed: boolean } | undefined;
    if (input.newPassword === input.currentPassword) reasons.push('same_as_current');
    if (input.tenantId) {
      if (!(await this.sessions.listTenants(userId)).some((t) => t.id === input.tenantId)) throw new ProblemError('NOT_FOUND');
      const policy = await this.policy.policy(input.tenantId);
      rules = SecurityPolicyService.passwordRules(policy);
      reasons.push(...SecurityPolicyService.passwordRuleReasons(policy, profile));
    }
    if (reasons.length > 0) throw new ProblemError('PASSWORD_POLICY', undefined, { reasons, ...(rules ? { rules } : {}) });
    const passwordHash = await hashPassword(input.newPassword);
    await this.db.withUser(userId, (tx) => tx.update(schema.userCredentials).set({ passwordHash }).where(eq(schema.userCredentials.userId, userId)));
    await this.sessions.setPasswordProfile(userId, sessionId, profile);
    await this.sessions.revokeAllSessions(userId, 'password_changed', sessionId);
    await authEvent(this.db, { kind: 'auth.password_changed', userId, ip: client.ip, userAgent: client.userAgent });
  }

  // ------------------------------------------------------------------ helpers
  private async findForLogin(email: string) {
    return this.db.withAnonymous(async (tx) => {
      const r = await tx.execute<{ user_id: string; password_hash: string | null; status: string; email_verified: boolean; mfa_enabled: boolean }>(
        sql`SELECT * FROM app.find_user_for_login(${email})`);
      return r.rows[0] ?? null;
    });
  }

  private async emailRegistered(email: string): Promise<boolean> {
    return this.db.withAnonymous(async (tx) => (await tx.execute<{ ok: boolean }>(sql`SELECT app.email_registered(${email}) AS ok`)).rows[0]?.ok === true);
  }

  async issueEmailToken(userId: string, purpose: 'verify_email' | 'reset_password'): Promise<string> {
    const token = randomToken();
    await this.db.withUser(userId, (tx) =>
      tx.insert(schema.emailTokens).values({ userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS) }));
    return token;
  }

  private async sendVerification(userId: string, email: string, displayName: string, locale: Locale): Promise<void> {
    const token = await this.issueEmailToken(userId, 'verify_email');
    await this.mailer.send({ template: 'verify_email', to: email, locale, vars: { displayName, url: this.web(`/verify-email?token=${token}`) } });
  }

  private async consume(token: string, purpose: 'verify_email' | 'reset_password'): Promise<string> {
    const userId = await this.db.withAnonymous(async (tx) => {
      const r = await tx.execute<{ u: string | null }>(sql`SELECT app.consume_email_token(${sha256(token)}, ${purpose}) AS u`);
      return r.rows[0]?.u ?? null;
    });
    if (!userId) throw new ProblemError('TOKEN_INVALID');
    return userId;
  }

  /** Owner of a still-valid token without consuming it (so a password-policy failure does not burn the link). */
  private async peekEmailTokenOwner(token: string, purpose: 'verify_email' | 'reset_password'): Promise<string | null> {
    return this.db.withAnonymous(async (tx) => {
      const r = await tx.execute<{ u: string | null }>(sql`SELECT app.peek_email_token(${sha256(token)}, ${purpose}) AS u`);
      return r.rows[0]?.u ?? null;
    });
  }

  private web(path: string): string {
    return new URL(path, this.env.WEB_BASE_URL).toString();
  }
}
