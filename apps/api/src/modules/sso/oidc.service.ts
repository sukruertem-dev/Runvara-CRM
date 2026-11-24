import { Inject, Injectable } from '@nestjs/common';
import type { ApiEnv } from '@flexa/config';
import { randomToken } from '@flexa/security';
import * as oidc from 'openid-client';
import { assertSafeOutboundUrl } from '../../common/egress';
import { ProblemError } from '../../common/problem';
import { ENV, REDIS, type Redis } from '../../infra/tokens';
import { SsoMembersService } from './sso-members.service';
import { SsoProvidersService, type LoadedOidc } from './sso-providers.service';

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
    @Inject(REDIS) private readonly redis: Redis,
    private readonly providers: SsoProvidersService,
    private readonly members: SsoMembersService,
  ) {}

  /** Drops the cached discovery of a provider whose settings changed. */
  forget(providerId: string): void {
    this.configs.delete(providerId);
  }

  redirectUri(providerId: string): string {
    return this.providers.oidcRedirectUri(providerId);
  }

  /** Builds the IdP authorization URL (PKCE S256 + state + nonce; state kept server-side for 10 minutes). */
  async start(providerId: string): Promise<string> {
    const provider = await this.loadOidc(providerId);
    const config = await this.discover(provider);
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const state = randomToken();
    const nonce = randomToken();
    const pending: PendingLogin = { providerId, tenantId: provider.tenantId, codeVerifier, nonce };
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
    const provider = await this.loadOidc(providerId);
    const config = await this.discover(provider);
    const tokens = await oidc.authorizationCodeGrant(config, currentUrl, { pkceCodeVerifier: pending.codeVerifier, expectedState: state, expectedNonce: pending.nonce })
      .catch((e: unknown) => { throw new ProblemError('VALIDATION_FAILED', `identity provider rejected the login: ${(e as Error).message}`); });
    const claims: Record<string, unknown> = tokens.claims() ?? {};
    const email = typeof claims.email === 'string' ? claims.email : null;
    if (!email || claims.email_verified !== true) throw new ProblemError('SSO_EMAIL_UNVERIFIED');
    return this.members.resolve({
      providerId, tenantId: provider.tenantId, emailDomains: provider.emailDomains, jitEnabled: provider.jitEnabled,
      email, name: typeof claims.name === 'string' ? claims.name : null, via: 'oidc',
    });
  }

  private async loadOidc(providerId: string): Promise<LoadedOidc> {
    const p = await this.providers.load(providerId);
    if (p.kind !== 'oidc') throw new ProblemError('NOT_FOUND');
    return p;
  }

  private async discover(p: LoadedOidc): Promise<oidc.Configuration> {
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
