import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { defaultEnabledPolicies } from '@flexa/authz';
import { and, eq, isNull, schema, sql, type DbHandle } from '@flexa/db';
import { moduleForPath } from '@flexa/modules';
import { sha256, type TokenSigner } from '@flexa/security';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from './problem';
import { loadAccess } from './access-loader';
import { segmentsForSalesMode, type Principal, type Segment, type TenantInfo, type TenantRequestContext } from './request-context';
import { DB, REDIS, SIGNER, type Redis } from '../infra/tokens';

export const API_KEY_PREFIX = 'fx_';

/** API keys (`Bearer fx_…`): resolved by hash before any tenant context exists; expired or revoked → 401. */
async function authenticateApiKey(key: string, db: DbHandle): Promise<Principal> {
  const row = await db.withAnonymous(async (tx) => (await tx.execute<{ key_id: string; tenant_id: string; user_id: string; scopes: ('read' | 'write')[]; rate_limit_per_minute: number }>(
    sql`SELECT key_id, tenant_id, user_id, scopes, rate_limit_per_minute FROM app.resolve_api_key(${sha256(key)})`)).rows[0]);
  if (!row) throw new ProblemError('UNAUTHENTICATED', 'invalid API key');
  await db.withTenant({ tenantId: row.tenant_id, userId: null }, (tx) => tx.execute(sql`UPDATE api_keys SET last_used_at = now()
    WHERE id = ${row.key_id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`));
  return {
    userId: row.user_id, sessionId: `apikey:${row.key_id}`, tenantId: row.tenant_id, amr: ['api_key'],
    apiKey: { id: row.key_id, scopes: row.scopes, rateLimitPerMinute: row.rate_limit_per_minute },
  };
}

/** Per-key request budget per minute (fixed window in Redis). */
export async function enforceApiKeyRate(redis: Redis, principal: Principal): Promise<void> {
  if (!principal.apiKey) return;
  const window = Math.floor(Date.now() / 60_000);
  const k = `rl:apikey:${principal.apiKey.id}:${window}`;
  const n = await redis.incr(k);
  if (n === 1) await redis.expire(k, 120);
  if (n > principal.apiKey.rateLimitPerMinute) throw new ProblemError('RATE_LIMITED', 'API key rate limit exceeded');
}

export async function authenticate(req: FastifyRequest, signer: TokenSigner, db: DbHandle): Promise<Principal> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ProblemError('UNAUTHENTICATED');
  const token = header.slice(7).trim();
  if (token.startsWith(API_KEY_PREFIX)) return authenticateApiKey(token, db);
  const result = await signer.verifyAccess(token);
  if (!result.ok) throw new ProblemError(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
  const { sub, sid, tid, amr } = result.claims;
  // Revoked sessions (logout, password reset, refresh reuse) stop working on the next request.
  const live = await db.withUser(sub, (tx) =>
    tx.select({ id: schema.authSessions.id }).from(schema.authSessions)
      .where(and(eq(schema.authSessions.id, sid), isNull(schema.authSessions.revokedAt))));
  if (live.length === 0) throw new ProblemError('UNAUTHENTICATED', 'session revoked');
  return { userId: sub, sessionId: sid, tenantId: tid, amr };
}

/** The full authorization context of a member in a tenant, loaded from the database on every call (no cache:
 *  changes apply on the next request, G2). Used by TenantGuard and by background work that acts as a member
 *  (automation rules run as their owner). */
export async function buildTenantContext(db: DbHandle, principal: Principal & { tenantId: string }, segmentHeader?: string | string[]): Promise<TenantRequestContext> {
  const { tenantId } = principal;
  const loaded = await db.withTenant({ tenantId, userId: principal.userId }, async (tx) => {
    const [membership] = await tx.select().from(schema.memberships).where(eq(schema.memberships.userId, principal.userId));
    const [tenant] = await tx.select().from(schema.tenants);
    const roles = await tx.execute<{ key: string }>(sql`
      SELECT r.key FROM user_roles ur JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE ur.user_id = ${principal.userId} AND (ur.valid_until IS NULL OR ur.valid_until > now())`);
    const modules = await tx.select({ id: schema.tenantModules.moduleId }).from(schema.tenantModules).where(eq(schema.tenantModules.enabled, true));
    const access = await loadAccess(tx, principal.userId);
    return { membership, tenant, roleKeys: roles.rows.map((r) => r.key), modules: modules.map((m) => m.id), ...access };
  });
  if (!loaded.membership || loaded.membership.status !== 'active' || !loaded.tenant) throw new ProblemError('UNAUTHENTICATED', 'no active membership');
  if (loaded.tenant.status !== 'trial' && loaded.tenant.status !== 'active') throw new ProblemError('FORBIDDEN', 'tenant is not active');
  const t = loaded.tenant;
  const tenant: TenantInfo = { id: t.id, slug: t.slug, name: t.name, status: t.status, salesMode: t.salesMode, locale: t.locale, timezone: t.timezone, currency: t.currency };
  return {
    principal,
    tenant,
    authz: {
      tenantId,
      userId: principal.userId,
      roleKeys: loaded.roleKeys,
      enabledModules: new Set(['core', ...loaded.modules]),
      authzVersion: loaded.membership.authzVersion,
      tenantAuthzEpoch: t.authzEpoch,
      enabledPolicies: defaultEnabledPolicies(),
      overrides: loaded.overrides,
    },
    segments: effectiveSegments(loaded.grantedSegments, tenant.salesMode, segmentHeader),
    access: loaded.access,
  };
}

/** ADR-0010 §6: active grants ∩ sales mode, narrowed (never widened) by the segment switcher header. */
export function effectiveSegments(granted: readonly Segment[], salesMode: TenantInfo['salesMode'], header: string | string[] | undefined): Segment[] {
  const mode = segmentsForSalesMode(salesMode);
  const base = granted.filter((s) => mode.includes(s));
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw === '' || raw === 'all') return base;
  if (raw !== 'b2b' && raw !== 'b2c') throw new ProblemError('VALIDATION_FAILED', 'X-Segment must be b2b, b2c or all');
  return base.filter((s) => s === raw);
}

/** Valid access token + live session. Tenant optional (e.g. tenant selection, /v1/me, MFA settings). */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(SIGNER) private readonly signer: TokenSigner, @Inject(DB) private readonly db: DbHandle, @Inject(REDIS) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    req.principal = await authenticate(req, this.signer, this.db);
    // Session-level endpoints (profile, MFA) are for people, not integrations.
    if (req.principal.apiKey) throw new ProblemError('API_KEY_SCOPE', 'this endpoint is not available to API keys');
    return true;
  }
}

/** Access token bound to a tenant; loads the authorization context from the database for every request
 *  (so role/module changes apply on the next request, G2) and applies the module gate (ADR-0014 §2). */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(SIGNER) private readonly signer: TokenSigner, @Inject(DB) private readonly db: DbHandle, @Inject(REDIS) private readonly redis: Redis) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = req.principal ?? (await authenticate(req, this.signer, this.db));
    req.principal = principal;
    const tenantId = principal.tenantId;
    if (!tenantId) throw new ProblemError('TENANT_REQUIRED');

    if (principal.apiKey) {
      await enforceApiKeyRate(this.redis, principal);
      const path = req.routeOptions.url ?? '';
      // A key never manages keys or the authorization model (no self-escalation through an integration).
      if (path.startsWith('/v1/api-keys') || path.startsWith('/v1/authz') || /^\/v1\/users\/:id\/(roles|segments)$/.test(path)) {
        throw new ProblemError('API_KEY_SCOPE', 'this endpoint is not available to API keys');
      }
      const write = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (write && !principal.apiKey.scopes.includes('write')) throw new ProblemError('API_KEY_SCOPE', 'the API key is read-only');
    }
    const ctx = await buildTenantContext(this.db, { ...principal, tenantId }, req.headers['x-segment']);
    const routeModule = moduleForPath(req.routeOptions.url ?? req.url.split('?')[0] ?? '');
    if (routeModule && !ctx.authz.enabledModules.has(routeModule)) throw new ProblemError('MODULE_DISABLED');
    req.tenantCtx = ctx;
    return true;
  }
}

