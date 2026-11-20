import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { defaultEnabledPolicies } from '@flexa/authz';
import { and, eq, isNull, schema, sql, type DbHandle } from '@flexa/db';
import { moduleForPath } from '@flexa/modules';
import type { TokenSigner } from '@flexa/security';
import type { FastifyRequest } from 'fastify';
import { ProblemError } from './problem';
import type { Principal, TenantInfo } from './request-context';
import { DB, SIGNER } from '../infra/tokens';

export async function authenticate(req: FastifyRequest, signer: TokenSigner, db: DbHandle): Promise<Principal> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new ProblemError('UNAUTHENTICATED');
  const result = await signer.verifyAccess(header.slice(7).trim());
  if (!result.ok) throw new ProblemError(result.reason === 'expired' ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
  const { sub, sid, tid, amr } = result.claims;
  // Revoked sessions (logout, password reset, refresh reuse) stop working on the next request.
  const live = await db.withUser(sub, (tx) =>
    tx.select({ id: schema.authSessions.id }).from(schema.authSessions)
      .where(and(eq(schema.authSessions.id, sid), isNull(schema.authSessions.revokedAt))));
  if (live.length === 0) throw new ProblemError('UNAUTHENTICATED', 'session revoked');
  return { userId: sub, sessionId: sid, tenantId: tid, amr };
}

/** Valid access token + live session. Tenant optional (e.g. tenant selection, /v1/me, MFA settings). */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(@Inject(SIGNER) private readonly signer: TokenSigner, @Inject(DB) private readonly db: DbHandle) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    req.principal = await authenticate(req, this.signer, this.db);
    return true;
  }
}

/** Access token bound to a tenant; loads the authorization context from the database for every request
 *  (so role/module changes apply on the next request, G2) and applies the module gate (ADR-0014 §2). */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Inject(SIGNER) private readonly signer: TokenSigner, @Inject(DB) private readonly db: DbHandle) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = req.principal ?? (await authenticate(req, this.signer, this.db));
    req.principal = principal;
    const tenantId = principal.tenantId;
    if (!tenantId) throw new ProblemError('TENANT_REQUIRED');

    const loaded = await this.db.withTenant({ tenantId, userId: principal.userId }, async (tx) => {
      const [membership] = await tx.select().from(schema.memberships).where(eq(schema.memberships.userId, principal.userId));
      const [tenant] = await tx.select().from(schema.tenants);
      const roles = await tx.execute<{ key: string }>(sql`
        SELECT r.key FROM user_roles ur JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
        WHERE ur.user_id = ${principal.userId} AND (ur.valid_until IS NULL OR ur.valid_until > now())`);
      const modules = await tx.select({ id: schema.tenantModules.moduleId }).from(schema.tenantModules).where(eq(schema.tenantModules.enabled, true));
      return { membership, tenant, roleKeys: roles.rows.map((r) => r.key), modules: modules.map((m) => m.id) };
    });
    if (!loaded.membership || loaded.membership.status !== 'active' || !loaded.tenant) throw new ProblemError('UNAUTHENTICATED', 'no active membership');
    if (loaded.tenant.status !== 'trial' && loaded.tenant.status !== 'active') throw new ProblemError('FORBIDDEN', 'tenant is not active');

    const enabledModules = new Set(['core', ...loaded.modules]);
    const routeModule = moduleForPath(req.routeOptions.url ?? req.url.split('?')[0] ?? '');
    if (routeModule && !enabledModules.has(routeModule)) throw new ProblemError('MODULE_DISABLED');

    const t = loaded.tenant;
    const tenant: TenantInfo = { id: t.id, slug: t.slug, name: t.name, status: t.status, salesMode: t.salesMode, locale: t.locale, timezone: t.timezone, currency: t.currency };
    req.tenantCtx = {
      principal: { ...principal, tenantId },
      tenant,
      authz: {
        tenantId,
        userId: principal.userId,
        roleKeys: loaded.roleKeys,
        enabledModules,
        authzVersion: loaded.membership.authzVersion,
        tenantAuthzEpoch: t.authzEpoch,
        enabledPolicies: defaultEnabledPolicies(),
      },
    };
    return true;
  }
}
