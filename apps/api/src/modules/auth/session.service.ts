import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@runvara/config';
import { and, eq, isNull, one, schema, sql, type DbHandle } from '@runvara/db';
import { createCsrfToken, randomToken, sha256, verifyCsrfToken, type TokenSigner } from '@runvara/security';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { authEvent } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import type { ClientInfo } from '../../common/request-context';
import { DB, ENV, SIGNER } from '../../infra/tokens';

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

const CSRF_COOKIE = 'rv_csrf';

@Injectable()
export class SessionService {
  readonly refreshCookie: string;

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    @Inject(SIGNER) private readonly signer: TokenSigner,
  ) {
    // __Host- prefix requires Secure; plain name is used only when COOKIE_SECURE=false (local http tests).
    this.refreshCookie = env.COOKIE_SECURE ? '__Host-rv_rt' : 'rv_rt';
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

  /** New session + refresh token family after a completed primary (and, if enrolled, second) factor. */
  async start(userId: string, amr: string[], client: ClientInfo, reply: FastifyReply, preferredTenant?: string): Promise<IssuedSession & { tenants: TenantSummaryRow[] }> {
    const tenants = await this.listTenants(userId);
    const tenant = (preferredTenant ? tenants.find((t) => t.id === preferredTenant) : undefined) ?? (tenants.length === 1 ? (tenants[0] ?? null) : null);
    const familyId = randomUUID();
    const refresh = randomToken();
    const sessionId = await this.db.withUser(userId, async (tx) => {
      const s = one(await tx.insert(schema.authSessions).values({ userId, tenantId: tenant?.id ?? null, amr, ip: client.ip, userAgent: client.userAgent }).returning({ id: schema.authSessions.id }), 'session');
      await tx.insert(schema.refreshTokens).values({ sessionId: s.id, userId, familyId, tokenHash: sha256(refresh), expiresAt: this.refreshExpiry() });
      return s.id;
    });
    this.setCookies(reply, refresh, familyId);
    await authEvent(this.db, { kind: 'auth.login', userId, tenantId: tenant?.id ?? null, ip: client.ip, userAgent: client.userAgent, details: { amr } });
    return { ...(await this.accessFor(userId, sessionId, tenant, amr, familyId)), tenants };
  }

  /** Switches the session's tenant (membership re-checked) and issues a tenant-bound access token. */
  async selectTenant(userId: string, sessionId: string, amr: string[], tenantId: string, req: FastifyRequest): Promise<IssuedSession> {
    const tenant = (await this.listTenants(userId)).find((t) => t.id === tenantId);
    if (!tenant) throw new ProblemError('NOT_FOUND');
    await this.db.withUser(userId, (tx) => tx.update(schema.authSessions).set({ tenantId, lastUsedAt: new Date() }).where(eq(schema.authSessions.id, sessionId)));
    const familyId = await this.currentFamily(req);
    return this.accessFor(userId, sessionId, tenant, amr, familyId ?? sessionId);
  }

  /** Refresh rotation with reuse detection (ADR-0009). */
  async refresh(req: FastifyRequest, reply: FastifyReply, client: ClientInfo): Promise<IssuedSession> {
    const presented = req.cookies[this.refreshCookie];
    if (!presented) throw new ProblemError('REFRESH_INVALID');
    const row = await this.findToken(presented);
    if (!row) throw new ProblemError('REFRESH_INVALID');
    this.assertCsrf(req, row.family_id);
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
    const tenants = row.session_tenant_id ? await this.listTenants(row.user_id) : [];
    const tenant = tenants.find((t) => t.id === row.session_tenant_id) ?? null;
    return this.accessFor(row.user_id, row.session_id, tenant, row.session_amr, row.family_id);
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
