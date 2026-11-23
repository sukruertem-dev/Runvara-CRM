import { Inject, Injectable } from '@nestjs/common';
import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider, type Profile } from '@node-saml/node-saml';
import { ProblemError } from '../../common/problem';
import { REDIS, type Redis } from '../../infra/tokens';
import { SsoMembersService } from './sso-members.service';
import { SsoProvidersService, type LoadedSaml } from './sso-providers.service';

// SAML 2.0 service provider (TEN-04, docs/p7-plan.md §20, B78): SP-initiated login only, signed assertions,
// InResponseTo bound to a request we issued (single use), replayed assertions refused.

const REQUEST_TTL_MS = 10 * 60_000;
const EMAIL_FORMAT = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const EMAIL_ATTRIBUTES = ['email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'] as const;
const NAME_ATTRIBUTES = ['displayName', 'name', 'urn:oid:2.16.840.1.113730.3.1.241', 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'] as const;

/** Request IDs and seen assertion IDs in Redis, per provider. Atomic consume and save-if-absent. */
class RedisSamlCache implements CacheProvider {
  constructor(private readonly redis: Redis, private readonly prefix: string) {}

  async saveAsync(key: string, value: string): Promise<CacheItem | null> {
    await this.redis.set(this.prefix + key, value, 'PX', REQUEST_TTL_MS);
    return { value, createdAt: Date.now() };
  }

  getAsync(key: string): Promise<string | null> {
    return this.redis.get(this.prefix + key);
  }

  async removeAsync(key: string | null): Promise<string | null> {
    if (key === null) return null;
    return this.redis.getdel(this.prefix + key);
  }

  consumeAsync(key: string): Promise<string | null> {
    return this.redis.getdel(this.prefix + key);
  }

  async saveIfAbsentAsync(key: string, value: string, expiresAtMs: number): Promise<boolean> {
    const ttl = Math.max(1000, expiresAtMs - Date.now());
    return (await this.redis.set(this.prefix + key, value, 'PX', ttl, 'NX')) === 'OK';
  }
}

const firstString = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) return x.trim();
  return null;
};

@Injectable()
export class SamlService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly providers: SsoProvidersService,
    private readonly members: SsoMembersService,
  ) {}

  /** Service provider metadata for the IdP administrator (entity ID, ACS, NameID format). */
  async metadata(providerId: string): Promise<string> {
    const p = await this.loadSaml(providerId);
    return this.client(p).generateServiceProviderMetadata(null, null);
  }

  /** IdP URL with a deflated AuthnRequest (HTTP-Redirect binding); the request ID is remembered for 10 min. */
  async start(providerId: string): Promise<string> {
    const p = await this.loadSaml(providerId);
    return this.client(p).getAuthorizeUrlAsync('', undefined, {});
  }

  /** Validates the posted SAMLResponse and maps the asserted e-mail to a member of the provider's tenant. */
  async acs(providerId: string, body: Record<string, string>): Promise<{ userId: string; tenantId: string }> {
    const p = await this.loadSaml(providerId);
    if (typeof body.SAMLResponse !== 'string' || body.SAMLResponse.length === 0) throw new ProblemError('SSO_RESPONSE_INVALID', 'SAMLResponse missing');
    let profile: Profile | null;
    try {
      ({ profile } = await this.client(p).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse }));
    } catch (e) {
      throw new ProblemError('SSO_RESPONSE_INVALID', `identity provider response rejected: ${(e as Error).message}`);
    }
    if (!profile) throw new ProblemError('SSO_RESPONSE_INVALID', 'no assertion in the response');
    const email = this.email(profile);
    if (!email) throw new ProblemError('SSO_EMAIL_UNVERIFIED', 'the assertion carries no e-mail address');
    const name = NAME_ATTRIBUTES.map((a) => firstString(profile[a])).find((v) => v !== null) ?? null;
    return this.members.resolve({ providerId, tenantId: p.tenantId, emailDomains: p.emailDomains, jitEnabled: p.jitEnabled, email, name, via: 'saml' });
  }

  private email(profile: Profile): string | null {
    for (const a of EMAIL_ATTRIBUTES) {
      const v = firstString(profile[a]);
      if (v?.includes('@')) return v.toLowerCase();
    }
    return profile.nameIDFormat === EMAIL_FORMAT && profile.nameID.includes('@') ? profile.nameID.toLowerCase() : null;
  }

  private client(p: LoadedSaml): SAML {
    const entityId = this.providers.spEntityId(p.id);
    return new SAML({
      issuer: entityId,
      callbackUrl: this.providers.acsUrl(p.id),
      entryPoint: p.idpSsoUrl,
      idpCert: p.idpCerts,
      idpIssuer: p.idpEntityId,
      audience: entityId,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: REQUEST_TTL_MS,
      rejectReplayedAssertions: true,
      cacheProvider: new RedisSamlCache(this.redis, `saml:${p.id}:`),
      acceptedClockSkewMs: 120_000,
      identifierFormat: EMAIL_FORMAT,
      disableRequestedAuthnContext: true,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
    });
  }

  private async loadSaml(providerId: string): Promise<LoadedSaml> {
    const p = await this.providers.load(providerId);
    if (p.kind !== 'saml') throw new ProblemError('NOT_FOUND');
    return p;
  }
}
