import { Inject, Injectable } from '@nestjs/common';
import { configKey, mergeLayer, type ApiEnv, type JsonObject, type SecurityPolicy } from '@flexa/config';
import { eq, schema, sql, type Db, type DbHandle } from '@flexa/db';
import { ProblemError } from '../../common/problem';
import { DB, ENV } from '../../infra/tokens';

// Tenant security policy (TEN-04, docs/p7-plan.md §18–19). Evaluated whenever a session is bound to a tenant:
// login, tenant selection, refresh and the SSO return (B76). Support sessions and API keys are out of scope.

/** Authentication methods that count as single sign-on and as a second factor. */
export const SSO_AMR = ['oidc', 'saml'] as const;
export const SECOND_FACTOR_AMR = ['otp', 'recovery'] as const;

const isSso = (amr: readonly string[]): boolean => amr.some((a) => (SSO_AMR as readonly string[]).includes(a));
const hasSecondFactor = (amr: readonly string[]): boolean => amr.some((a) => (SECOND_FACTOR_AMR as readonly string[]).includes(a));

/** The tenant's effective `security` value: platform default deep-merged with the tenant layer. */
export async function readSecurityPolicy(tx: Db, tenantId: string): Promise<SecurityPolicy> {
  const r = await tx.execute<{ value: JsonObject }>(sql`
    SELECT s.value FROM tenant_settings_head h
    JOIN tenant_settings s USING (tenant_id, scope_type, scope_id, key, version)
    WHERE h.scope_type = 'tenant' AND h.scope_id = ${tenantId} AND h.key = 'security'`);
  const def = configKey('security');
  if (!def) throw new Error('security config key is not registered');
  return mergeLayer(def.default, r.rows[0]?.value ?? {}) as unknown as SecurityPolicy;
}

/** Enabled single sign-on providers of the transaction's tenant, as the login screen shows them. */
export async function enabledProviders(tx: Db, apiPublicUrl: string): Promise<{ id: string; name: string; kind: 'oidc' | 'saml'; startUrl: string }[]> {
  const rows = await tx.select({ id: schema.tenantSsoProviders.id, name: schema.tenantSsoProviders.name, kind: schema.tenantSsoProviders.kind })
    .from(schema.tenantSsoProviders).where(eq(schema.tenantSsoProviders.enabled, true));
  return rows.map((p) => ({ ...p, startUrl: ssoStartUrl(apiPublicUrl, p.kind, p.id) }));
}

export function ssoStartUrl(apiPublicUrl: string, kind: 'oidc' | 'saml', id: string): string {
  return new URL(`/v1/auth/${kind}/${id}/start`, apiPublicUrl).toString();
}

export interface PolicySubject {
  userId: string;
  sessionId: string;
  tenantId: string;
  /** Role keys in the tenant (Admin may keep password sign-in when SSO is required). */
  roles: readonly string[];
  /** Methods the session was opened with, read from the session row. */
  amr: readonly string[];
}

/** Why a session may not open a tenant and what the person must do first. Null when nothing blocks. */
export type PolicyBlock = ProblemError;

@Injectable()
export class SecurityPolicyService {
  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
  ) {}

  policy(tenantId: string): Promise<SecurityPolicy> {
    return this.db.withTenant({ tenantId, userId: null }, (tx) => readSecurityPolicy(tx, tenantId));
  }

  /** Checks in order: single sign-on, second factor, password. Returns the first block, or null. */
  async check(s: PolicySubject): Promise<PolicyBlock | null> {
    const { policy, providers } = await this.db.withTenant({ tenantId: s.tenantId, userId: s.userId }, async (tx) => ({
      policy: await readSecurityPolicy(tx, s.tenantId),
      providers: await enabledProviders(tx, this.env.API_PUBLIC_URL),
    }));
    const admin = s.roles.includes('admin');
    const sso = isSso(s.amr);

    // A required SSO with no enabled provider cannot be satisfied; writes refuse that state (lockout check),
    // so this only guards against a provider removed outside the API.
    if (policy.sso.required && providers.length > 0 && !sso && !(admin && policy.sso.adminPasswordFallback)) {
      return new ProblemError('TENANT_SSO_REQUIRED', 'this workspace requires single sign-on', { providers });
    }

    const mfaApplies = policy.mfa.require === 'all' || (policy.mfa.require === 'admins' && admin);
    if (mfaApplies && !hasSecondFactor(s.amr) && !(sso && policy.mfa.ssoSatisfies)) {
      return new ProblemError('TENANT_MFA_REQUIRED', 'this workspace requires two-step verification', { enrolled: await this.mfaEnrolled(s.userId) });
    }

    if (s.amr.includes('pwd')) {
      const reasons = await this.passwordReasons(s.userId, s.sessionId, policy);
      if (reasons.length > 0) return new ProblemError('PASSWORD_CHANGE_REQUIRED', 'this workspace requires a new password', { reasons });
    }
    return null;
  }

  /** Session length: idle time since the last refresh and age since sign-in (checked on refresh). */
  async lifetimeExceeded(tenantId: string, createdAt: Date, lastUsedAt: Date, now = Date.now()): Promise<'policy_idle' | 'policy_max_age' | null> {
    const { session } = await this.policy(tenantId);
    if (now - createdAt.getTime() > session.maxHours * 3_600_000) return 'policy_max_age';
    if (now - lastUsedAt.getTime() > session.idleMinutes * 60_000) return 'policy_idle';
    return null;
  }

  /** Reasons a new password does not satisfy a tenant's rules (the base rules are checked separately). */
  static passwordRuleReasons(policy: SecurityPolicy, profile: { length: number; mixed: boolean }): ('too_short' | 'needs_mixed')[] {
    const reasons: ('too_short' | 'needs_mixed')[] = [];
    if (profile.length < policy.password.minLength) reasons.push('too_short');
    if (policy.password.requireMixed && !profile.mixed) reasons.push('needs_mixed');
    return reasons;
  }

  private async mfaEnrolled(userId: string): Promise<boolean> {
    return this.db.withUser(userId, async (tx) =>
      Boolean((await tx.select({ on: schema.userMfa.totpEnabledAt }).from(schema.userMfa).where(eq(schema.userMfa.userId, userId)))[0]?.on));
  }

  private async passwordReasons(userId: string, sessionId: string, policy: SecurityPolicy): Promise<('too_short' | 'needs_mixed' | 'expired')[]> {
    const { profile, changedAt } = await this.db.withUser(userId, async (tx) => {
      const [s] = await tx.select({ p: schema.authSessions.passwordProfile }).from(schema.authSessions).where(eq(schema.authSessions.id, sessionId));
      const [c] = await tx.select({ at: schema.userCredentials.updatedAt }).from(schema.userCredentials).where(eq(schema.userCredentials.userId, userId));
      return { profile: s?.p ?? null, changedAt: c?.at ?? null };
    });
    // Sessions opened before P7d have no measure: only the age rule applies to them (B77).
    const reasons: ('too_short' | 'needs_mixed' | 'expired')[] = profile ? SecurityPolicyService.passwordRuleReasons(policy, profile) : [];
    if (policy.password.maxAgeDays > 0 && changedAt && Date.now() - new Date(changedAt).getTime() > policy.password.maxAgeDays * 86_400_000) reasons.push('expired');
    return reasons;
  }
}
