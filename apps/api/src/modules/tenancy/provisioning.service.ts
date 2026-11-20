import { Inject, Injectable } from '@nestjs/common';
import { ALWAYS_ON_MODULES } from '@runvara/modules';
import { SYSTEM_ROLES } from '@runvara/authz';
import { schema, sql, type Db, type DbHandle } from '@runvara/db';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { isUniqueViolation, ProblemError } from '../../common/problem';
import { DB, KEYRING, type KeyRing } from '../../infra/tokens';

export const SYSTEM_ROLE_NAMES: Record<string, string> = {
  admin: 'Admin',
  manager: 'Yönetici',
  sales_rep: 'Satış Temsilcisi',
  call_agent: 'Çağrı Temsilcisi',
  analyst: 'Analist',
};

export interface NewTenantInput {
  slug: string;
  name: string;
  locale: string;
  admin: { email: string; displayName: string; passwordHash: string; locale: string };
  ip: string;
}

@Injectable()
export class ProvisioningService {
  constructor(@Inject(DB) private readonly db: DbHandle, @Inject(KEYRING) private readonly keys: KeyRing) {}

  /** Creates tenant (trial), admin user, system roles, core module and the tenant DEK in ONE transaction. */
  async createTenantWithAdmin(input: NewTenantInput): Promise<{ tenantId: string; userId: string }> {
    const tenantId = randomUUID();
    const userId = randomUUID();
    try {
      await this.db.withTenant({ tenantId, userId }, async (tx) => {
        await tx.insert(schema.tenants).values({
          id: tenantId, slug: input.slug, name: input.name, status: 'trial', salesMode: 'both', locale: input.locale,
          timezone: 'Europe/Istanbul', currency: 'TRY', country: 'TR', authzEpoch: 0, statusChangedAt: new Date(),
        });
        await tx.insert(schema.users).values({
          id: userId, email: input.admin.email, displayName: input.admin.displayName, locale: input.admin.locale,
          timezone: 'Europe/Istanbul', status: 'active',
        });
        await tx.insert(schema.userCredentials).values({ userId, passwordHash: input.admin.passwordHash });
        await this.seedTenant(tx, tenantId, userId);
        await audit(tx, tenantId, { action: 'tenant.created', actorId: userId, targetType: 'tenant', targetId: tenantId, ip: input.ip, details: { slug: input.slug, plan: 'trial' } });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'tenants_slug_key')) throw new ProblemError('SLUG_TAKEN');
      throw err;
    }
    return { tenantId, userId };
  }

  /** Roles, admin membership, always-on modules, DEK v1. Separate so seeds and tests reuse the same path. */
  async seedTenant(tx: Db, tenantId: string, adminUserId: string): Promise<void> {
    await tx.insert(schema.memberships).values({ tenantId, userId: adminUserId, status: 'active', authzVersion: 0, density: 'comfortable' });
    const roles = await tx.insert(schema.roles)
      .values(SYSTEM_ROLES.map((key) => ({ tenantId, key, name: SYSTEM_ROLE_NAMES[key] ?? key, isSystem: true, path: key, version: 1 })))
      .returning({ id: schema.roles.id, key: schema.roles.key });
    const admin = roles.find((r) => r.key === 'admin')!;
    await tx.insert(schema.userRoles).values({ tenantId, userId: adminUserId, roleId: admin.id, grantedBy: null });
    for (const moduleId of ALWAYS_ON_MODULES) {
      await tx.insert(schema.tenantModules).values({ tenantId, moduleId, enabled: true, enabledBy: adminUserId, enabledAt: new Date(), config: {} });
    }
    const { wrapped } = this.keys.newTenantKey(tenantId);
    await tx.insert(schema.tenantKeys).values({ tenantId, version: 1, wrappedDek: wrapped });
  }

  async slugAvailable(slug: string): Promise<boolean> {
    return this.db.withAnonymous(async (tx) => {
      const r = await tx.execute<{ ok: boolean }>(sql`SELECT app.slug_available(${slug}) AS ok`);
      return r.rows[0]?.ok === true;
    });
  }

  /** Current tenant DEK (unwrapped in memory only). */
  async tenantKey(tx: Db, tenantId: string): Promise<{ key: Buffer; version: number }> {
    const r = await tx.execute<{ version: number; wrapped_dek: Buffer }>(
      sql`SELECT version, wrapped_dek FROM tenant_keys WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1`);
    const row = r.rows[0];
    if (!row) throw new Error(`tenant ${tenantId} has no active key`);
    return { key: this.keys.unwrapTenantKey(tenantId, row.wrapped_dek), version: row.version };
  }
}
