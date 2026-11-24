import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { and, eq, isNull, one, schema, sql, type DbHandle } from '@flexa/db';
import { createCsrfToken, randomToken, sha256, verifyCsrfToken, type TokenSigner } from '@flexa/security';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authEvent } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import type { ClientInfo } from '../../common/request-context';
import { DB, ENV, SIGNER } from '../../infra/tokens';
import { SecurityPolicyService } from './security-policy.service';

/** A rotated refresh token is accepted once more within this window if its successor was never used (B52). */
const REFRESH_REUSE_GRACE_MS = 30_000;

export interface TenantSummaryRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  roles: string[];
}

export interface UserSummaryRow {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  timezone: string;
  mfaEnabled: boolean;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  csrfToken: string;
  tenant: TenantSummaryRow | null;
}

const CSRF_COOKIE = 'fx_csrf';
/** Authentication method added while an operator works in a tenant under a support grant. */
export const SUPPORT_AMR = 'support';

@Injectable()
export class SessionService {
  readonly refreshCookie: string;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    @Inject(SIGNER) private readonly signer: TokenSigner,
    private readonly policy: SecurityPolicyService,
  ) {
    // __Host- prefix requires Secure; plain name is used only when COOKIE_SECURE=false (local http tests).
    this.refreshCookie = env.COOKIE_SECURE ? '__Host-fx_rt' : 'fx_rt';
  }

  listTenants(userId: string): Promise<TenantSummaryRow[]> {
    return this.db.withUser(userId, async (tx) => {
      const r = await tx.execute<{ tenant_id: string; slug: string; name: string; status: string; role_keys: string[] }>(sql`SELECT * FROM app.list_my_tenants()`);
      return r.rows.map((x) => ({ id: x.tenant_id, slug: x.slug, name: x.name, status: x.status, roles: x.role_keys }));
    });
  }

  userSummary(userId: string): Promise<UserSummaryRow> {
    return this.db.withUser(userId, async (tx) => {
      const [u] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
      if (!u) throw new ProblemError('UNAUTHENTICATED');
      const [mfa] = await tx.select({ on: schema.userMfa.totpEnabledAt }).from(schema.userMfa).where(eq(schema.userMfa.userId, userId));
      return { id: u.id, email: u.email, displayName: u.displayName, locale: u.locale, timezone: u.timezone, mfaEnabled: Boolean(mfa?.on) };
    });
  }

  private async authzVersion(tenantId: string, userId: string): Promise<number> {
    return this.db.withTenant({ tenantId, userId }, async (tx) => {
      const [m] = await tx.select({ v: schema.memberships.authzVersion }).from(schema.memberships).where(eq(schema.memberships.userId, userId));
      return m?.v ?? 0;
    });
  }

  private async accessFor(userId: string, sessionId: string, tenant: TenantSummaryRow | null, amr: string[], familyId: string): Promise<IssuedSession> {
    const av = tenant ? await this.authzVersion(tenant.id, userId) : 0;
    const ttl = this.env.ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await this.signer.signAccess({ sub: userId, sid: sessionId, tid: tenant?.id ?? null, av, amr }, ttl);
    return { accessToken, expiresIn: ttl, csrfToken: createCsrfToken(this.env.CSRF_SECRET, familyId), tenant };
  }

  /** New session + refresh token family after a completed primary (and, if enrolled, second) factor. The
   *  session opens the preferred (or only) tenant when that tenant's security policy lets it; otherwise it
   *  opens without a tenant and the person resolves the block from tenant selection (P7d). */
  async start(userId: string, amr: string[], client: ClientInfo, reply: FastifyReply, preferredTenant?: string, passwordProfile?: { length: number; mixed: boolean }): Promise<IssuedSession & { tenants: TenantSummaryRow[] }> {
    const tenants = await this.listTenants(userId);
    let tenant = (preferredTenant ? tenants.find((t) => t.id === preferredTenant) : undefined) ?? (tenants.length === 1 ? (tenants[0] ?? null) : null);
    const familyId = randomUUID();
    const refresh = randomToken();
    const sessionId = await this.db.withUser(userId, async (tx) => {
      const s = one(await tx.insert(schema.authSessions).values({ userId, tenantId: null, amr, ip: client.ip, userAgent: client.userAgent, passwordProfile: passwordProfile ?? null }).returning({ id: schema.authSessions.id }), 'session');
      await tx.insert(schema.refreshTokens).values({ sessionId: s.id, userId, familyId, tokenHash: sha256(refresh), expiresAt: this.refreshExpiry() });
      return s.id;
    });
    if (tenant && (await this.policy.check({ userId, sessionId, tenantId: tenant.id, roles: tenant.roles, amr }))) tenant = null;
    if (tenant) await this.bindTenant(userId, sessionId, tenant.id);
    this.setCookies(reply, refresh, familyId);
    await authEvent(this.db, { kind: 'auth.login', userId, tenantId: tenant?.id ?? null, ip: client.ip, userAgent: client.userAgent, details: { amr } });
    return { ...(await this.accessFor(userId, sessionId, tenant, amr, familyId)), tenants };
  }

  /** Switches the session's tenant (membership and the tenant's security policy checked) and issues a
   *  tenant-bound access token. The session's methods come from its row: a second factor added after sign-in
   *  (enrolment, step-up) counts without a new token. */
  async selectTenant(userId: string, sessionId: string, tenantId: string, req: FastifyRequest): Promise<IssuedSession> {
    const tenant = (await this.listTenants(userId)).find((t) => t.id === tenantId);
    if (!tenant) throw new ProblemError('NOT_FOUND');
    const amr = await this.sessionAmr(userId, sessionId);
    const block = await this.policy.check({ userId, sessionId, tenantId, roles: tenant.roles, amr });
    if (block) throw block;
    await this.bindTenant(userId, sessionId, tenantId);
    const familyId = await this.currentFamily(req);
    return this.accessFor(userId, sessionId, tenant, amr, familyId ?? sessionId);
  }

  /** A tenant-less access token for the session with its current methods (after a step-up). */
  async reissue(userId: string, sessionId: string, req: FastifyRequest): Promise<IssuedSession> {
    const amr = await this.sessionAmr(userId, sessionId);
    const familyId = await this.currentFamily(req);
    return this.accessFor(userId, sessionId, null, amr, familyId ?? sessionId);
  }

  /** Records a second factor proven during the session (TOTP enrolment, step-up). */
  async addAmr(userId: string, sessionId: string, method: 'otp' | 'recovery'): Promise<void> {
    await this.db.withUser(userId, (tx) => tx.execute(sql`
      UPDATE auth_sessions SET amr = array_append(amr, ${method}) WHERE id = ${sessionId} AND NOT (${method} = ANY (amr))`));
  }

  /** The measure of a password just set in this session (B77). */
  async setPasswordProfile(userId: string, sessionId: string, profile: { length: number; mixed: boolean }): Promise<void> {
    await this.db.withUser(userId, (tx) => tx.update(schema.authSessions).set({ passwordProfile: profile }).where(eq(schema.authSessions.id, sessionId)));
  }

  private async sessionAmr(userId: string, sessionId: string): Promise<string[]> {
    const [s] = await this.db.withUser(userId, (tx) => tx.select({ amr: schema.authSessions.amr }).from(schema.authSessions).where(eq(schema.authSessions.id, sessionId)));
    if (!s) throw new ProblemError('UNAUTHENTICATED');
    return s.amr;
  }

  private async bindTenant(userId: string, sessionId: string, tenantId: string | null): Promise<void> {
    await this.db.withUser(userId, (tx) => tx.update(schema.authSessions).set({ tenantId, lastUsedAt: new Date() }).where(eq(schema.authSessions.id, sessionId)));
  }

  /** Refresh rotation with reuse detection (ADR-0009). */
  async refresh(req: FastifyRequest, reply: FastifyReply, client: ClientInfo): Promise<IssuedSession> {
    const presented = req.cookies[this.refreshCookie];
    if (!presented) throw new ProblemError('REFRESH_INVALID');
    const row = await this.findToken(presented);
    if (!row) throw new ProblemError('REFRESH_INVALID');
    this.assertCsrf(req, row.family_id);
    if (row.used_at && !row.session_revoked && row.expires_at.getTime() > Date.now() && Date.now() - new Date(row.used_at).getTime() <= REFRESH_REUSE_GRACE_MS) {
      // The response carrying the successor may never have reached the browser (the page was left mid-request).
      // If the successor is still unused, rotate it instead: the session survives, and if this was a thief the
      // legitimate holder's next refresh presents the now-used successor and revokes the family (ADR-0009 note).
      const next = randomToken();
      const recovered = await this.db.withUser(row.user_id, async (tx) => {
        const succ = await tx.execute<{ id: string }>(sql`
          UPDATE refresh_tokens SET used_at = now(), consumed_by_grace = true
          WHERE id = (SELECT replaced_by FROM refresh_tokens WHERE id = ${row.token_id} AND NOT consumed_by_grace) AND used_at IS NULL
          RETURNING id`);
        const successor = succ.rows[0];
        if (!successor) return false;
        const n = one(await tx.insert(schema.refreshTokens).values({ sessionId: row.session_id, userId: row.user_id, familyId: row.family_id, tokenHash: sha256(next), expiresAt: this.refreshExpiry() }).returning({ id: schema.refreshTokens.id }), 'refresh token');
        await tx.update(schema.refreshTokens).set({ replacedBy: n.id }).where(eq(schema.refreshTokens.id, successor.id));
        return true;
      });
      if (recovered) {
        this.setCookies(reply, next, row.family_id);
        return this.accessFor(row.user_id, row.session_id, await this.gatedSessionTenant(row.user_id, row.session_id, row.session_tenant_id, row.session_amr), row.session_amr, row.family_id);
      }
    }
    if (row.used_at) {
      // A rotated token was presented again: the family is compromised → revoke the whole session.
      await this.revokeSession(row.user_id, row.session_id, 'refresh_reuse');
      await authEvent(this.db, { kind: 'auth.refresh_reuse', userId: row.user_id, ip: client.ip, userAgent: client.userAgent, details: { sessionId: row.session_id } });
      this.clearCookies(reply);
      throw new ProblemError('REFRESH_REUSED');
    }
    if (row.session_revoked || row.expires_at.getTime() <= Date.now()) {
      this.clearCookies(reply);
      throw new ProblemError('REFRESH_INVALID');
    }
    // Tenant session length (P7d): idle time since the last refresh and age since sign-in.
    if (row.session_tenant_id && !row.session_amr.includes(SUPPORT_AMR)) {
      const expired = await this.policy.lifetimeExceeded(row.session_tenant_id, new Date(row.session_created_at), new Date(row.session_last_used_at));
      if (expired) {
        await this.revokeSession(row.user_id, row.session_id, expired);
        this.clearCookies(reply);
        throw new ProblemError('REFRESH_INVALID', 'the workspace ended this session (session length policy)');
      }
    }
    const next = randomToken();
    const rotated = await this.db.withUser(row.user_id, async (tx) => {
      const used = await tx.update(schema.refreshTokens).set({ usedAt: new Date() })
        .where(and(eq(schema.refreshTokens.id, row.token_id), isNull(schema.refreshTokens.usedAt))).returning({ id: schema.refreshTokens.id });
      if (used.length === 0) return false; // lost a race with a concurrent refresh using the same token
      const n = one(await tx.insert(schema.refreshTokens).values({ sessionId: row.session_id, userId: row.user_id, familyId: row.family_id, tokenHash: sha256(next), expiresAt: this.refreshExpiry() }).returning({ id: schema.refreshTokens.id }), 'refresh token');
      await tx.update(schema.refreshTokens).set({ replacedBy: n.id }).where(eq(schema.refreshTokens.id, row.token_id));
      await tx.update(schema.authSessions).set({ lastUsedAt: new Date() }).where(eq(schema.authSessions.id, row.session_id));
      return true;
    });
    if (!rotated) throw new ProblemError('REFRESH_INVALID');
    this.setCookies(reply, next, row.family_id);
    return this.accessFor(row.user_id, row.session_id, await this.gatedSessionTenant(row.user_id, row.session_id, row.session_tenant_id, row.session_amr), row.session_amr, row.family_id);
  }

  /** The refreshed token's tenant, after the tenant's security policy: a session that no longer satisfies it
   *  (the policy was tightened) continues without a tenant and the person resolves the block (B76). */
  private async gatedSessionTenant(userId: string, sessionId: string, tenantId: string | null, amr: string[]): Promise<TenantSummaryRow | null> {
    const tenant = await this.sessionTenant(userId, sessionId, tenantId, amr);
    if (!tenant || amr.includes(SUPPORT_AMR)) return tenant;
    if (!(await this.policy.check({ userId, sessionId, tenantId: tenant.id, roles: tenant.roles, amr }))) return tenant;
    await this.bindTenant(userId, sessionId, null);
    return null;
  }

  /** The tenant a refreshed token is bound to: a membership, or for a support session the approved grant's
   *  tenant while the grant is active (P7c, TEN-08). */
  private async sessionTenant(userId: string, sessionId: string, tenantId: string | null, amr: readonly string[]): Promise<TenantSummaryRow | null> {
    if (!tenantId) return null;
    if (amr.includes(SUPPORT_AMR)) return this.supportTenant(userId, sessionId);
    return (await this.listTenants(userId)).find((t) => t.id === tenantId) ?? null;
  }

  private async supportTenant(userId: string, sessionId: string): Promise<TenantSummaryRow | null> {
    return this.db.withUser(userId, async (tx) => {
      const r = await tx.execute<{ tenant_id: string; active: boolean }>(sql`SELECT tenant_id, active FROM app.support_grant_for_session(${sessionId})`);
      const g = r.rows[0];
      if (!g?.active) return null;
      const t = (await tx.execute<{ slug: string; name: string; status: string }>(sql`SELECT slug::text AS slug, name, status FROM app.operator_tenants() WHERE id = ${g.tenant_id}`)).rows[0];
      return t ? { id: g.tenant_id, slug: t.slug, name: t.name, status: t.status, roles: ['support'] } : null;
    });
  }

  /** Binds the operator's own session to a tenant under an approved support grant (TEN-08). The grant is
   *  checked again on every request; the session falls back to no tenant when the operator leaves. */
  async enterSupport(userId: string, sessionId: string, amr: string[], grantId: string, req: FastifyRequest): Promise<IssuedSession> {
    const supportAmr = [...amr.filter((a) => a !== SUPPORT_AMR), SUPPORT_AMR];
    await this.db.withUser(userId, (tx) => tx.update(schema.authSessions)
      .set({ supportGrantId: grantId, amr: supportAmr, lastUsedAt: new Date() })
      .where(eq(schema.authSessions.id, sessionId)));
    const tenant = await this.supportTenant(userId, sessionId);
    if (!tenant) {
      await this.exitSupport(userId, sessionId, amr, req);
      throw new ProblemError('SUPPORT_ACCESS_ENDED');
    }
    await this.db.withUser(userId, (tx) => tx.update(schema.authSessions).set({ tenantId: tenant.id }).where(eq(schema.authSessions.id, sessionId)));
    const familyId = await this.currentFamily(req);
    return this.accessFor(userId, sessionId, tenant, supportAmr, familyId ?? sessionId);
  }

  async exitSupport(userId: string, sessionId: string, amr: string[], req: FastifyRequest): Promise<IssuedSession> {
    const plain = amr.filter((a) => a !== SUPPORT_AMR);
    await this.db.withUser(userId, (tx) => tx.update(schema.authSessions)
      .set({ supportGrantId: null, tenantId: null, amr: plain, lastUsedAt: new Date() })
      .where(eq(schema.authSessions.id, sessionId)));
    const familyId = await this.currentFamily(req);
    return this.accessFor(userId, sessionId, null, plain, familyId ?? sessionId);
  }

  async logout(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const presented = req.cookies[this.refreshCookie];
    const row = presented ? await this.findToken(presented) : null;
    if (row) {
      this.assertCsrf(req, row.family_id);
      await this.revokeSession(row.user_id, row.session_id, 'logout');
    }
    this.clearCookies(reply);
  }

  async revokeSession(userId: string, sessionId: string, reason: string): Promise<void> {
    await this.db.withUser(userId, (tx) =>
      tx.update(schema.authSessions).set({ revokedAt: new Date(), revokeReason: reason })
        .where(and(eq(schema.authSessions.id, sessionId), isNull(schema.authSessions.revokedAt))));
  }

  async revokeAllSessions(userId: string, reason: string, exceptSessionId?: string): Promise<void> {
    await this.db.withUser(userId, (tx) =>
      tx.execute(sql`UPDATE auth_sessions SET revoked_at = now(), revoke_reason = ${reason}
                     WHERE user_id = ${userId} AND revoked_at IS NULL AND id IS DISTINCT FROM ${exceptSessionId ?? null}::uuid`));
  }

  private async findToken(token: string) {
    return this.db.withAnonymous(async (tx) => {
      const r = await tx.execute<{
        token_id: string; session_id: string; user_id: string; family_id: string; expires_at: Date;
        used_at: Date | null; session_revoked: boolean; session_tenant_id: string | null; session_amr: string[];
        session_created_at: Date | string; session_last_used_at: Date | string;
      }>(sql`SELECT * FROM app.find_refresh_token(${sha256(token)})`);
      const row = r.rows[0];
      return row ? { ...row, expires_at: new Date(row.expires_at) } : null;
    });
  }

  private async currentFamily(req: FastifyRequest): Promise<string | null> {
    const presented = req.cookies[this.refreshCookie];
    return presented ? ((await this.findToken(presented))?.family_id ?? null) : null;
  }

  private assertCsrf(req: FastifyRequest, familyId: string): void {
    const header = req.headers['x-csrf-token'];
    if (!verifyCsrfToken(this.env.CSRF_SECRET, familyId, typeof header === 'string' ? header : undefined)) {
      throw new ProblemError('CSRF_INVALID');
    }
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  }

  private setCookies(reply: FastifyReply, refresh: string, familyId: string): void {
    const maxAge = this.env.REFRESH_TOKEN_TTL_DAYS * 86_400;
    const secure = this.env.COOKIE_SECURE;
    void reply.setCookie(this.refreshCookie, refresh, { httpOnly: true, secure, sameSite: 'strict', path: '/', maxAge });
    // Readable by the web app (same origin through its /api proxy) for the double-submit header.
    void reply.setCookie(CSRF_COOKIE, createCsrfToken(this.env.CSRF_SECRET, familyId), { httpOnly: false, secure, sameSite: 'strict', path: '/', maxAge });
  }

  private clearCookies(reply: FastifyReply): void {
    void reply.clearCookie(this.refreshCookie, { path: '/' });
    void reply.clearCookie(CSRF_COOKIE, { path: '/' });
  }
}
