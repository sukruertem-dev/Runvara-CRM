import { Inject, Injectable } from '@nestjs/common';
import { eq, one, schema, sql, type DbHandle } from '@flexa/db';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { ProblemError } from '../../common/problem';
import { DB } from '../../infra/tokens';

// Maps an e-mail proven by an identity provider (OIDC or SAML) to a member of the provider's tenant, or
// provisions one just in time when the provider allows it. Shared by both protocols.

export interface SsoIdentity {
  providerId: string;
  tenantId: string;
  emailDomains: readonly string[];
  jitEnabled: boolean;
  email: string;
  name: string | null;
  via: 'oidc' | 'saml';
}

@Injectable()
export class SsoMembersService {
  constructor(@Inject(DB) private readonly db: DbHandle) {}

  async resolve(id: SsoIdentity): Promise<{ userId: string; tenantId: string }> {
    const email = id.email.trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    if (!id.emailDomains.includes(domain)) throw new ProblemError('SSO_NOT_MEMBER', 'e-mail domain is not allowed for this provider');

    const existing = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ user_id: string; status: string }>(sql`SELECT user_id, status FROM app.find_user_for_login(${email})`)).rows[0] ?? null);
    if (existing?.status === 'disabled') throw new ProblemError('ACCOUNT_DISABLED');
    if (existing) {
      const member = await this.db.withTenant({ tenantId: id.tenantId, userId: existing.user_id }, async (tx) =>
        (await tx.select({ s: schema.memberships.status }).from(schema.memberships).where(eq(schema.memberships.userId, existing.user_id)))[0]?.s === 'active');
      if (!member) throw new ProblemError('SSO_NOT_MEMBER');
      return { userId: existing.user_id, tenantId: id.tenantId };
    }
    if (!id.jitEnabled) throw new ProblemError('SSO_NOT_MEMBER');
    // JIT provisioning: least-privilege role (Analist, read-only) until an Admin assigns a role.
    const userId = randomUUID();
    const name = id.name?.trim() ? id.name.trim().slice(0, 120) : email;
    const tenantId = id.tenantId;
    await this.db.withTenant({ tenantId, userId }, async (tx) => {
      await tx.insert(schema.users).values({ id: userId, email, displayName: name, locale: 'tr-TR', timezone: 'Europe/Istanbul', status: 'active', emailVerifiedAt: new Date() });
      await tx.insert(schema.memberships).values({ tenantId, userId, status: 'active', authzVersion: 0, density: 'comfortable' });
      const role = one(await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'analyst')), 'analyst role');
      await tx.insert(schema.userRoles).values({ tenantId, userId, roleId: role.id, grantedBy: null });
      await tx.execute(sql`INSERT INTO user_segment_grants (tenant_id, user_id, segment)
        SELECT ${tenantId}, ${userId}, s::segment FROM tenants t, unnest(CASE t.sales_mode WHEN 'b2b_only' THEN ARRAY['b2b'] WHEN 'b2c_only' THEN ARRAY['b2c'] ELSE ARRAY['b2b', 'b2c'] END) s
        WHERE t.id = ${tenantId}`);
      await audit(tx, tenantId, { action: 'user.joined', actorType: 'system', actorId: null, targetType: 'user', targetId: userId, details: { via: `${id.via}_jit`, providerId: id.providerId } });
    });
    return { userId, tenantId };
  }
}
