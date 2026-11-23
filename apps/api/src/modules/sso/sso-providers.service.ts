import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import type { CreateSsoProviderRequest, UpdateSsoProviderRequest, z } from '@flexa/contracts';
import { and, eq, one, schema, sql, type Db, type DbHandle } from '@flexa/db';
import { decrypt, encrypt } from '@flexa/security';
import { randomUUID, X509Certificate } from 'node:crypto';
import { audit } from '../../common/audit';
import { assertSafeOutboundUrl } from '../../common/egress';
import { ProblemError } from '../../common/problem';
import { DB, ENV } from '../../infra/tokens';
import { readSecurityPolicy, ssoStartUrl } from '../auth/security-policy.service';
import { ProvisioningService } from '../tenancy/provisioning.service';

// Single sign-on providers of a tenant (TEN-04; OIDC since P1, SAML since P7d, docs/p7-plan.md §20).

export type ProviderRow = typeof schema.tenantSsoProviders.$inferSelect;
type CreateInput = z.infer<typeof CreateSsoProviderRequest>;
type UpdateInput = z.infer<typeof UpdateSsoProviderRequest>;

export interface LoadedOidc { kind: 'oidc'; id: string; tenantId: string; issuer: string; clientId: string; clientSecret: string; emailDomains: string[]; jitEnabled: boolean }
export interface LoadedSaml { kind: 'saml'; id: string; tenantId: string; idpEntityId: string; idpSsoUrl: string; idpCerts: string[]; emailDomains: string[]; jitEnabled: boolean }

/** Subject, expiry and SHA-256 fingerprint of a PEM certificate; throws VALIDATION_FAILED for anything else. */
export function certificateInfo(pem: string): { subject: string; notAfter: string; fingerprint: string; expired: boolean } {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch {
    throw new ProblemError('VALIDATION_FAILED', 'idpCerts: not a valid X.509 certificate', { errors: [{ path: 'idpCerts', code: 'VALIDATION_FAILED', message: 'not a valid X.509 certificate' }] });
  }
  const notAfter = new Date(cert.validTo);
  return { subject: cert.subject.replaceAll('\n', ', '), notAfter: notAfter.toISOString(), fingerprint: cert.fingerprint256, expired: notAfter.getTime() <= Date.now() };
}

@Injectable()
export class SsoProvidersService {
  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    private readonly provisioning: ProvisioningService,
  ) {}

  spEntityId(id: string): string {
    return new URL(`/v1/auth/saml/${id}/metadata`, this.env.API_PUBLIC_URL).toString();
  }

  acsUrl(id: string): string {
    return new URL(`/v1/auth/saml/${id}/acs`, this.env.API_PUBLIC_URL).toString();
  }

  oidcRedirectUri(id: string): string {
    return new URL(`/v1/auth/oidc/${id}/callback`, this.env.API_PUBLIC_URL).toString();
  }

  /** What the settings screen shows: never the OIDC secret; SAML certificates as subject and expiry. */
  view(p: ProviderRow) {
    const saml = p.kind === 'saml';
    return {
      id: p.id,
      kind: p.kind,
      name: p.name,
      emailDomains: p.emailDomains,
      jitEnabled: p.jitEnabled,
      enabled: p.enabled,
      startUrl: ssoStartUrl(this.env.API_PUBLIC_URL, p.kind, p.id),
      issuer: p.issuer,
      clientId: p.clientId,
      redirectUri: saml ? null : this.oidcRedirectUri(p.id),
      idpEntityId: p.idpEntityId,
      idpSsoUrl: p.idpSsoUrl,
      certificates: (p.idpCerts ?? []).map(certificateInfo),
      sp: saml ? { entityId: this.spEntityId(p.id), acsUrl: this.acsUrl(p.id), metadataUrl: this.spEntityId(p.id) } : null,
    };
  }

  list(tx: Db): Promise<ProviderRow[]> {
    return tx.select().from(schema.tenantSsoProviders).orderBy(schema.tenantSsoProviders.name, schema.tenantSsoProviders.id);
  }

  async create(tenantId: string, userId: string, input: CreateInput, ip: string): Promise<ProviderRow> {
    if (input.kind === 'oidc') await assertSafeOutboundUrl(input.issuer, { allowInsecureLocalhost: this.env.OIDC_ALLOW_INSECURE_LOCALHOST });
    else this.checkSaml(input.idpSsoUrl, input.idpCerts);
    return this.db.withTenant({ tenantId, userId }, async (tx) => {
      const id = randomUUID();
      const common = { id, tenantId, name: input.name, emailDomains: input.emailDomains, jitEnabled: input.jitEnabled, enabled: true };
      let values: typeof schema.tenantSsoProviders.$inferInsert;
      if (input.kind === 'oidc') {
        const { key, version } = await this.provisioning.tenantKey(tx, tenantId);
        values = { ...common, kind: 'oidc', issuer: input.issuer, clientId: input.clientId, clientSecretEnc: encrypt(key, input.clientSecret, `sso:${id}`), keyVersion: version };
      } else {
        values = { ...common, kind: 'saml', idpEntityId: input.idpEntityId, idpSsoUrl: input.idpSsoUrl, idpCerts: input.idpCerts };
      }
      const row = one(await tx.insert(schema.tenantSsoProviders).values(values).returning(), 'sso provider');
      await audit(tx, tenantId, {
        action: 'sso.provider_created', actorId: userId, targetType: 'sso_provider', targetId: id, ip,
        details: { kind: input.kind, emailDomains: input.emailDomains, ...(input.kind === 'oidc' ? { issuer: input.issuer } : { idpEntityId: input.idpEntityId }) },
      });
      return row;
    });
  }

  async update(tenantId: string, userId: string, id: string, input: UpdateInput, ip: string): Promise<ProviderRow> {
    if (input.idpSsoUrl !== undefined || input.idpCerts !== undefined) this.checkSaml(input.idpSsoUrl, input.idpCerts);
    return this.db.withTenant({ tenantId, userId }, async (tx) => {
      const [p] = await tx.select().from(schema.tenantSsoProviders).where(eq(schema.tenantSsoProviders.id, id)).for('update');
      if (!p) throw new ProblemError('NOT_FOUND');
      const samlOnly = input.idpEntityId !== undefined || input.idpSsoUrl !== undefined || input.idpCerts !== undefined;
      if ((p.kind === 'oidc' && samlOnly) || (p.kind === 'saml' && input.clientSecret !== undefined)) throw new ProblemError('SSO_PROVIDER_KIND_MISMATCH');
      if (input.enabled === false && p.enabled) await this.assertNotLastRequired(tx, tenantId, id);
      const set: Partial<typeof schema.tenantSsoProviders.$inferInsert> = {};
      if (input.name !== undefined) set.name = input.name;
      if (input.emailDomains !== undefined) set.emailDomains = input.emailDomains;
      if (input.jitEnabled !== undefined) set.jitEnabled = input.jitEnabled;
      if (input.enabled !== undefined) set.enabled = input.enabled;
      if (input.idpEntityId !== undefined) set.idpEntityId = input.idpEntityId;
      if (input.idpSsoUrl !== undefined) set.idpSsoUrl = input.idpSsoUrl;
      if (input.idpCerts !== undefined) set.idpCerts = input.idpCerts;
      if (input.clientSecret !== undefined) {
        const { key, version } = await this.provisioning.tenantKey(tx, tenantId);
        set.clientSecretEnc = encrypt(key, input.clientSecret, `sso:${id}`);
        set.keyVersion = version;
      }
      const row = one(await tx.update(schema.tenantSsoProviders).set(set).where(eq(schema.tenantSsoProviders.id, id)).returning(), 'sso provider');
      // Which fields changed, never their values (the secret and certificates stay out of the audit).
      await audit(tx, tenantId, { action: 'sso.provider_updated', actorId: userId, targetType: 'sso_provider', targetId: id, ip, details: { fields: Object.keys(input).sort() } });
      return row;
    });
  }

  async remove(tenantId: string, userId: string, id: string, ip: string): Promise<void> {
    await this.db.withTenant({ tenantId, userId }, async (tx) => {
      const [p] = await tx.select().from(schema.tenantSsoProviders).where(eq(schema.tenantSsoProviders.id, id)).for('update');
      if (!p) throw new ProblemError('NOT_FOUND');
      if (p.enabled) await this.assertNotLastRequired(tx, tenantId, id);
      await tx.delete(schema.tenantSsoProviders).where(eq(schema.tenantSsoProviders.id, id));
      await audit(tx, tenantId, { action: 'sso.provider_deleted', actorId: userId, targetType: 'sso_provider', targetId: id, ip, details: { kind: p.kind, name: p.name } });
    });
  }

  /** The provider with its secret (OIDC) for a login; only enabled providers of trial/active tenants. */
  async load(providerId: string): Promise<LoadedOidc | LoadedSaml> {
    const tenantId = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ t: string | null }>(sql`SELECT app.resolve_sso_provider(${providerId}) AS t`)).rows[0]?.t ?? null);
    if (!tenantId) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant({ tenantId, userId: null }, async (tx) => {
      const [p] = await tx.select().from(schema.tenantSsoProviders).where(eq(schema.tenantSsoProviders.id, providerId));
      if (!p) throw new ProblemError('NOT_FOUND');
      const base = { id: p.id, tenantId, emailDomains: p.emailDomains, jitEnabled: p.jitEnabled };
      if (p.kind === 'saml') {
        if (!p.idpEntityId || !p.idpSsoUrl || !p.idpCerts) throw new ProblemError('NOT_FOUND');
        return { ...base, kind: 'saml' as const, idpEntityId: p.idpEntityId, idpSsoUrl: p.idpSsoUrl, idpCerts: p.idpCerts };
      }
      if (!p.issuer || !p.clientId || !p.clientSecretEnc) throw new ProblemError('NOT_FOUND');
      const { key } = await this.provisioning.tenantKey(tx, tenantId);
      return { ...base, kind: 'oidc' as const, issuer: p.issuer, clientId: p.clientId, clientSecret: decrypt(key, p.clientSecretEnc, `sso:${p.id}`).toString() };
    });
  }

  /** While the tenant requires SSO, its last enabled provider cannot be disabled or removed. */
  private async assertNotLastRequired(tx: Db, tenantId: string, id: string): Promise<void> {
    const policy = await readSecurityPolicy(tx, tenantId);
    if (!policy.sso.required) return;
    const others = await tx.select({ id: schema.tenantSsoProviders.id }).from(schema.tenantSsoProviders)
      .where(and(eq(schema.tenantSsoProviders.enabled, true), sql`${schema.tenantSsoProviders.id} <> ${id}`));
    if (others.length === 0) throw new ProblemError('SECURITY_POLICY_LOCKOUT', 'single sign-on is required: keep at least one enabled provider', { reasons: ['last_required_provider'] });
  }

  private checkSaml(ssoUrl: string | undefined, certs: string[] | undefined): void {
    if (ssoUrl !== undefined) {
      const u = new URL(ssoUrl);
      // The browser, not the API, goes to the IdP; still refuse plain http outside local development.
      if (u.protocol !== 'https:' && !(this.env.OIDC_ALLOW_INSECURE_LOCALHOST && u.hostname === 'localhost')) {
        throw new ProblemError('VALIDATION_FAILED', 'idpSsoUrl: https required', { errors: [{ path: 'idpSsoUrl', code: 'VALIDATION_FAILED', message: 'https required' }] });
      }
    }
    for (const c of certs ?? []) certificateInfo(c);
  }
}
