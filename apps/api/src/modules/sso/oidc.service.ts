import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { eq, one, schema, sql, type DbHandle } from '@flexa/db';
import { decrypt, encrypt, randomToken } from '@flexa/security';
import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';
import { audit } from '../../common/audit';
import { assertSafeOutboundUrl } from '../../common/egress';
import { ProblemError } from '../../common/problem';
import { DB, ENV, REDIS, type Redis } from '../../infra/tokens';
import { ProvisioningService } from '../tenancy/provisioning.service';

interface PendingLogin {
  providerId: string;
  tenantId: string;
  codeVerifier: string;
  nonce: string;
}

const STATE_TTL_S = 600;

@Injectable()
export class OidcService {
  private readonly configs = new Map<string, { config: oidc.Configuration; at: number }>();

  constructor(
    @Inject(ENV) private readonly env: ApiEnv,
    @Inject(DB) private readonly db: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly provisioning: ProvisioningService,
  ) {}

  redirectUri(providerId: string): string {
    return new URL(`/v1/auth/oidc/${providerId}/callback`, this.env.API_PUBLIC_URL).toString();
  }

  async createProvider(tenantId: string, userId: string, input: { name: string; issuer: string; clientId: string; clientSecret: string; emailDomains: string[]; jitEnabled: boolean }, ip: string) {
    await assertSafeOutboundUrl(input.issuer, { allowInsecureLocalhost: this.env.OIDC_ALLOW_INSECURE_LOCALHOST });
    return this.db.withTenant({ tenantId, userId }, async (tx) => {
      const { key, version } = await this.provisioning.tenantKey(tx, tenantId);
      const id = randomUUID();
      const row = one(await tx.insert(schema.tenantSsoProviders).values({
        id, tenantId, kind: 'oidc', name: input.name, issuer: input.issuer, clientId: input.clientId,
        clientSecretEnc: encrypt(key, input.clientSecret, `sso:${id}`), keyVersion: version,
        emailDomains: input.emailDomains, jitEnabled: input.jitEnabled, enabled: true,
      }).returning(), 'sso provider');
      await audit(tx, tenantId, { action: 'sso.provider_created', actorId: userId, targetType: 'sso_provider', targetId: id, ip, details: { issuer: input.issuer, emailDomains: input.emailDomains } });
      return row;
    });
  }

  /** Builds the IdP authorization URL (PKCE S256 + state + nonce; state kept server-side for 10 minutes). */
  async start(providerId: string): Promise<string> {
    const { tenantId, provider } = await this.load(providerId);
    const config = await this.discover(provider);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = randomToken();
    const nonce = randomToken();
    const pending: PendingLogin = { providerId, tenantId, codeVerifier, nonce };
    await this.redis.set(`oidc:state:${state}`, JSON.stringify(pending), 'EX', STATE_TTL_S);
    return oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri(providerId),
      scope: 'openid email profile',
      code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      nonce,
    }).toString();
  }

  /** Exchanges the code and maps the verified e-mail to a member of the provider's tenant. */
  async callback(providerId: string, currentUrl: URL): Promise<{ userId: string; tenantId: string }> {
    const state = currentUrl.searchParams.get('state') ?? '';
    const raw = await this.redis.getdel(`oidc:state:${state}`);
    if (!raw) throw new ProblemError('VALIDATION_FAILED', 'unknown or expired login state');
    const pending = JSON.parse(raw) as PendingLogin;
    if (pending.providerId !== providerId) throw new ProblemError('VALIDATION_FAILED', 'state does not belong to this provider');
    const { tenantId, provider } = await this.load(providerId);
    const config = await this.discover(provider);
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: pending.codeVerifier, expectedState: state, expectedNonce: pending.nonce })
      .catch((e: unknown) => { throw new ProblemError('VALIDATION_FAILED', `identity provider rejected the login: ${(e as Error).message}`); });
    const claims: Record<string, unknown> = tokens.claims() ?? {};
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    if (!email || claims.email_verified !== true) throw new ProblemError('SSO_EMAIL_UNVERIFIED');
    const domain = email.split('@')[1] ?? '';
    if (!provider.emailDomains.includes(domain)) throw new ProblemError('SSO_NOT_MEMBER', 'e-mail domain is not allowed for this provider');

    const existing = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ user_id: string; status: string }>(sql`SELECT user_id, status FROM app.find_user_for_login(${email})`)).rows[0] ?? null);
    if (existing?.status === 'disabled') throw new ProblemError('ACCOUNT_DISABLED');
    if (existing) {
      const member = await this.db.withTenant({ tenantId, userId: existing.user_id }, async (tx) =>
        (await tx.select({ s: schema.memberships.status }).from(schema.memberships).where(eq(schema.memberships.userId, existing.user_id)))[0]?.s === 'active');
      if (!member) throw new ProblemError('SSO_NOT_MEMBER');
      return { userId: existing.user_id, tenantId };
    }
    if (!provider.jitEnabled) throw new ProblemError('SSO_NOT_MEMBER');
    // JIT provisioning: least-privilege role (Analist, read-only) until an Admin assigns a role.
    const userId = randomUUID();
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : email;
    await this.db.withTenant({ tenantId, userId }, async (tx) => {
      await tx.insert(schema.users).values({ id: userId, email, displayName: name, locale: 'tr-TR', timezone: 'Europe/Istanbul', status: 'active', emailVerifiedAt: new Date() });
      await tx.insert(schema.memberships).values({ tenantId, userId, status: 'active', authzVersion: 0, density: 'comfortable' });
      const role = one(await tx.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'analyst')), 'analyst role');
      await tx.insert(schema.userRoles).values({ tenantId, userId, roleId: role.id, grantedBy: null });
      await tx.execute(sql`INSERT INTO user_segment_grants (tenant_id, user_id, segment)
        SELECT ${tenantId}, ${userId}, s::segment FROM tenants t, unnest(CASE t.sales_mode WHEN 'b2b_only' THEN ARRAY['b2b'] WHEN 'b2c_only' THEN ARRAY['b2c'] ELSE ARRAY['b2b', 'b2c'] END) s
        WHERE t.id = ${tenantId}`);
      await audit(tx, tenantId, { action: 'user.joined', actorType: 'system', actorId: null, targetType: 'user', targetId: userId, details: { via: 'oidc_jit', providerId } });
    });
    return { userId, tenantId };
  }

  private async load(providerId: string) {
    const tenantId = await this.db.withAnonymous(async (tx) =>
      (await tx.execute<{ t: string | null }>(sql`SELECT app.resolve_sso_provider(${providerId}) AS t`)).rows[0]?.t ?? null);
    if (!tenantId) throw new ProblemError('NOT_FOUND');
    return this.db.withTenant({ tenantId, userId: null }, async (tx) => {
      const [p] = await tx.select().from(schema.tenantSsoProviders).where(eq(schema.tenantSsoProviders.id, providerId));
      if (!p) throw new ProblemError('NOT_FOUND');
      const { key } = await this.provisioning.tenantKey(tx, tenantId);
      return { tenantId, provider: { ...p, clientSecret: decrypt(key, p.clientSecretEnc, `sso:${p.id}`).toString() } };
    });
  }

  private async discover(p: { id: string; issuer: string; clientId: string; clientSecret: string }): Promise<oidc.Configuration> {
    const cached = this.configs.get(p.id);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.config;
    const issuer = await assertSafeOutboundUrl(p.issuer, { allowInsecureLocalhost: this.env.OIDC_ALLOW_INSECURE_LOCALHOST });
    const insecure = issuer.protocol === 'http:' && this.env.OIDC_ALLOW_INSECURE_LOCALHOST;
    // allowInsecureRequests is deprecated on purpose (to stand out); only used for http://localhost in dev/test.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const config = await oidc.discovery(issuer, p.clientId, p.clientSecret, undefined, insecure ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((e: unknown) => { throw new ProblemError('UPSTREAM_UNAVAILABLE', `OIDC discovery failed: ${(e as Error).message}`); });
    this.configs.set(p.id, { config, at: Date.now() });
    return config;
  }
}
