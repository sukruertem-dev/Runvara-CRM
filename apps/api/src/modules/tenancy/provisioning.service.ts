import { Inject, Injectable } from '@nestjs/common';
import { ALWAYS_ON_MODULES, getPlan, type PlanId } from '@flexa/modules';
import { SYSTEM_ROLES } from '@flexa/authz';
import { schema, sql, type Db, type DbHandle } from '@flexa/db';
import { randomUUID } from 'node:crypto';
import { randomToken, sha256 } from '@flexa/security';
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
        // TEN-09: self-service tenants start on the trial plan; the wizard runs on first visit (docs/p7-plan.md §8).
        await this.startPlan(tx, tenantId, 'trial', userId);
        await audit(tx, tenantId, { action: 'tenant.created', actorId: userId, targetType: 'tenant', targetId: tenantId, ip: input.ip, details: { slug: input.slug, plan: 'trial' } });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'tenants_slug_key')) throw new ProblemError('SLUG_TAKEN');
      throw err;
    }
    return { tenantId, userId };
  }

  /** Roles, admin membership, always-on modules, DEK v1. Separate so seeds and tests reuse the same path.
   *  Without an Admin user (a tenant an operator opens) the first Admin arrives through an invitation. */
  async seedTenant(tx: Db, tenantId: string, adminUserId: string | null): Promise<void> {
    if (adminUserId) {
      await tx.insert(schema.memberships).values({ tenantId, userId: adminUserId, status: 'active', authzVersion: 0, density: 'comfortable' });
      // ADR-0010: segment visibility comes from grants; the founding Admin holds both (sales mode still narrows).
      await tx.insert(schema.userSegmentGrants).values([{ tenantId, userId: adminUserId, segment: 'b2b' }, { tenantId, userId: adminUserId, segment: 'b2c' }]);
    }
    const roles = await tx.insert(schema.roles)
      .values(SYSTEM_ROLES.map((key) => ({ tenantId, key, name: SYSTEM_ROLE_NAMES[key] ?? key, isSystem: true, path: key, version: 1 })))
      .returning({ id: schema.roles.id, key: schema.roles.key });
    const admin = roles.find((r) => r.key === 'admin');
    if (!admin) throw new Error('system role admin was not created');
    if (adminUserId) await tx.insert(schema.userRoles).values({ tenantId, userId: adminUserId, roleId: admin.id, grantedBy: null });
    for (const moduleId of ALWAYS_ON_MODULES) {
      await tx.insert(schema.tenantModules).values({ tenantId, moduleId, enabled: true, enabledBy: adminUserId, enabledAt: new Date(), config: {} });
    }
    const { wrapped } = this.keys.newTenantKey(tenantId);
    await tx.insert(schema.tenantKeys).values({ tenantId, version: 1, wrappedDek: wrapped });
    // Same SQL function the 0002 migration used for pre-existing tenants: one definition of the default.
    await tx.execute(sql`SELECT app.seed_task_workflow(${tenantId})`);
    await tx.execute(sql`SELECT app.seed_crm_workflows(${tenantId})`);
  }

  /** Plan row and pending onboarding of a new tenant. */
  private async startPlan(tx: Db, tenantId: string, planId: PlanId, createdBy: string): Promise<void> {
    const trialDays = getPlan('trial').trialDays ?? 14;
    await tx.execute(planId === 'trial'
      ? sql`INSERT INTO tenant_plans (tenant_id, plan_id, trial_ends_at) VALUES (${tenantId}, 'trial', now() + make_interval(days => ${trialDays}))`
      : sql`INSERT INTO tenant_plans (tenant_id, plan_id) VALUES (${tenantId}, ${planId})`);
    await tx.execute(sql`INSERT INTO tenant_settings (tenant_id, scope_type, scope_id, key, version, value, schema_version, created_by, change_note)
      VALUES (${tenantId}, 'tenant', ${tenantId}, 'onboarding', 1, ${JSON.stringify({ status: 'pending', blueprint: null })}::jsonb, 1, ${createdBy}, 'tenant created')`);
    await tx.execute(sql`INSERT INTO tenant_settings_head (tenant_id, scope_type, scope_id, key, version) VALUES (${tenantId}, 'tenant', ${tenantId}, 'onboarding', 1)`);
  }

  /** TEN-01: a tenant opened by a platform operator. Its first Admin is invited by e-mail; the operator is
   *  never a member. Returns the invitation token for the e-mail. */
  async createTenantForOperator(input: { slug: string; name: string; locale: string; plan: PlanId; adminEmail: string }, operatorUserId: string, ip: string): Promise<{ tenantId: string; invitationToken: string }> {
    const tenantId = randomUUID();
    const token = randomToken();
    try {
      await this.db.withTenant({ tenantId, userId: operatorUserId }, async (tx) => {
        await tx.insert(schema.tenants).values({
          id: tenantId, slug: input.slug, name: input.name, status: input.plan === 'trial' ? 'trial' : 'active', salesMode: 'both', locale: input.locale,
          timezone: 'Europe/Istanbul', currency: 'TRY', country: 'TR', authzEpoch: 0, statusChangedAt: new Date(),
        });
        await this.seedTenant(tx, tenantId, null);
        await this.startPlan(tx, tenantId, input.plan, operatorUserId);
        await tx.insert(schema.invitations).values({
          tenantId, email: input.adminEmail, roleKey: 'admin', tokenHash: sha256(token), invitedBy: operatorUserId,
          expiresAt: new Date(Date.now() + 7 * 86_400_000), segments: ['b2b', 'b2c'], teamId: null,
        });
        await audit(tx, tenantId, { action: 'tenant.created', actorType: 'operator', actorId: operatorUserId, targetType: 'tenant', targetId: tenantId, ip, details: { slug: input.slug, plan: input.plan, by: 'operator' } });
      });
    } catch (err) {
      if (isUniqueViolation(err, 'tenants_slug_key')) throw new ProblemError('SLUG_TAKEN');
      throw err;
    }
    return { tenantId, invitationToken: token };
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
