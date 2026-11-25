import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const Email = z.string().trim().toLowerCase().pipe(z.email().max(254)).openapi({ example: 'ayse@firma.com.tr' });
export const Password = z.string().min(1).max(256).openapi({ format: 'password' });
export const Uuid = z.uuid();
export const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'slug: 3–40 chars, a–z, 0–9 and inner hyphens')
  .openapi({ example: 'firma' });
export const Locale = z.enum(['tr-TR', 'en-US']);
export const RoleKey = z.enum(['admin', 'manager', 'sales_rep', 'call_agent', 'analyst']);
export const Token = z.string().min(20).max(200);
export const TotpCode = z.string().regex(/^\d{6}$/);

// ---------------------------------------------------------------- auth
export const SignupRequest = z
  .object({
    email: Email,
    password: Password,
    displayName: z.string().trim().min(1).max(120),
    tenantName: z.string().trim().min(1).max(120),
    tenantSlug: Slug,
    locale: Locale.default('tr-TR'),
  })
  .openapi('SignupRequest');

export const LoginRequest = z.object({ email: Email, password: Password }).openapi('LoginRequest');

export const MfaVerifyRequest = z
  .object({ mfaToken: z.string().min(20), code: TotpCode.optional(), recoveryCode: z.string().trim().min(8).max(20).optional() })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), 'exactly one of code or recoveryCode')
  .openapi('MfaVerifyRequest');

export const SelectTenantRequest = z.object({ tenantId: Uuid }).openapi('SelectTenantRequest');
export const EmailOnlyRequest = z.object({ email: Email }).openapi('EmailOnlyRequest');
export const TokenRequest = z.object({ token: Token }).openapi('TokenRequest');
export const ResetPasswordRequest = z.object({ token: Token, password: Password }).openapi('ResetPasswordRequest');

export const TenantSummary = z
  .object({ id: Uuid, slug: z.string(), name: z.string(), status: z.string(), roles: z.array(z.string()) })
  .openapi('TenantSummary');

export const UserSummary = z
  .object({ id: Uuid, email: z.string(), displayName: z.string(), locale: z.string(), timezone: z.string(), mfaEnabled: z.boolean() })
  .openapi('UserSummary');

export const SessionResponse = z
  .object({
    next: z.enum(['done', 'select_tenant']),
    accessToken: z.string(),
    expiresIn: z.number().int(),
    csrfToken: z.string(),
    tenant: TenantSummary.nullable(),
    tenants: z.array(TenantSummary),
    user: UserSummary,
  })
  .openapi('SessionResponse');

export const MfaChallengeResponse = z
  .object({ next: z.literal('mfa'), mfaToken: z.string(), expiresIn: z.number().int() })
  .openapi('MfaChallengeResponse');

export const LoginResponse = z.union([SessionResponse, MfaChallengeResponse]).openapi('LoginResponse');

export const AccessTokenResponse = z
  .object({ accessToken: z.string(), expiresIn: z.number().int(), csrfToken: z.string(), tenant: TenantSummary.nullable() })
  .openapi('AccessTokenResponse');

export const AcceptedResponse = z.object({ status: z.literal('accepted') }).openapi('AcceptedResponse');

// ---------------------------------------------------------------- me / mfa
export const MeResponse = z
  .object({
    user: UserSummary,
    tenant: TenantSummary.nullable(),
    tenants: z.array(TenantSummary),
    /** Platform operator (P7c): the console is offered; it still needs a second factor. */
    operator: z.boolean(),
  })
  .openapi('MeResponse');

export const TotpSetupResponse = z.object({ secret: z.string(), otpauthUri: z.string() }).openapi('TotpSetupResponse');
export const TotpConfirmRequest = z.object({ code: TotpCode }).openapi('TotpConfirmRequest');
export const RecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()) }).openapi('RecoveryCodesResponse');

/** Permissions the shell asks about to show or hide global affordances (the API still decides every request). */
export const UI_CAPABILITIES = [
  // Record-level task actions: true when the user holds any scope for them (own, team, queue or all).
  'task.create',
  'task.update',
  'task.delete',
  'task.bulk',
  'tenant.config.read',
  'tenant.config.manage',
  'tenant.modules.manage',
  'tenant.sales_mode.manage',
  'users.manage',
  'authz.matrix.read',
  'authz.matrix.edit',
  'teams.manage',
  'teams.members.manage',
  'catalog.product.manage',
  'catalog.price_list.manage',
  'fields.cost_margin.read',
  'sales_tracking.target.manage',
  'sales_b2b.quote.create',
  'mentions.create',
] as const;

export const NavigationResponse = z
  .object({
    modules: z.array(z.object({ id: z.string(), displayNameKey: z.string() })),
    menu: z.array(z.object({ id: z.string(), module: z.string(), labelKey: z.string(), path: z.string(), icon: z.string() })),
    roles: z.array(z.string()),
    /** Segments the switcher may offer: the user's active grants ∩ the tenant's sales mode (not narrowed by X-Segment). */
    segments: z.array(z.enum(['b2b', 'b2c'])),
    salesMode: z.enum(['b2b_only', 'b2c_only', 'both']),
    capabilities: z.array(z.enum(UI_CAPABILITIES)),
    /** Approved support access (TEN-08): `operator` while an operator works in the workspace, `observed`
     *  for the workspace Admins while support access is active. */
    support: z.object({ role: z.enum(['operator', 'observed']), grantId: Uuid, operatorName: z.string(), validUntil: z.iso.datetime() }).nullable(),
    tenantStatus: z.enum(['trial', 'active', 'suspended', 'pending_deletion', 'deleted']),
  })
  .openapi('NavigationResponse');

// ---------------------------------------------------------------- tenancy
export const TenantResponse = z
  .object({
    id: Uuid,
    slug: z.string(),
    name: z.string(),
    status: z.string(),
    salesMode: z.enum(['b2b_only', 'b2c_only', 'both']),
    locale: z.string(),
    timezone: z.string(),
    currency: z.string(),
  })
  .openapi('TenantResponse');

export const ModuleState = z
  .object({
    id: z.string(), displayNameKey: z.string(), enabled: z.boolean(), alwaysOn: z.boolean(), dependsOn: z.array(z.array(z.string())),
    /** MOD-04: in the plan tier, bought as an add-on, purchasable as an add-on, or not available on this plan. */
    entitlement: z.enum(['included', 'add_on', 'available_add_on', 'not_in_plan']),
  })
  .openapi('ModuleState');
export const ModuleListResponse = z.object({ data: z.array(ModuleState) }).openapi('ModuleListResponse');
export const ModuleToggleResponse = z
  .object({ enabled: z.array(z.string()), disabled: z.array(z.string()), modules: z.array(ModuleState) })
  .openapi('ModuleToggleResponse');

export const CreateInvitationRequest = z
  .object({
    email: Email,
    roleKey: RoleKey,
    /** Segments the new member is granted (default: the inviter's segments). */
    segments: z.array(z.enum(['b2b', 'b2c'])).min(1).max(2).transform((v) => [...new Set(v)]).optional(),
    /** Team the new member joins; required when a Manager invites (A04 managed_teams_only). */
    teamId: z.uuid().optional(),
  })
  .strict()
  .openapi('CreateInvitationRequest');
export const InvitationResponse = z
  .object({
    id: Uuid,
    email: z.string(),
    roleKey: z.string(),
    expiresAt: z.iso.datetime(),
    acceptedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi('InvitationResponse');
export const InvitationListResponse = z.object({ data: z.array(InvitationResponse) }).openapi('InvitationListResponse');
export const InvitationPreviewResponse = z
  .object({ tenantName: z.string(), email: z.string(), roleKey: z.string(), accountExists: z.boolean() })
  .openapi('InvitationPreviewResponse');
export const AcceptInvitationRequest = z
  .object({ token: Token, password: Password.optional(), displayName: z.string().trim().min(1).max(120).optional() })
  .openapi('AcceptInvitationRequest');
export const AcceptInvitationResponse = z.object({ tenantId: Uuid, userCreated: z.boolean() }).openapi('AcceptInvitationResponse');

// ---------------------------------------------------------------- single sign-on (OIDC, SAML: P7d)
const EmailDomains = z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1).max(20);
/** An X.509 certificate in PEM form (the IdP's signing certificate). */
const PemCertificate = z.string().trim().min(100).max(10_000).regex(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/, 'PEM certificate');
const IdpCertificates = z.array(PemCertificate).min(1).max(3);

const SsoProviderCommon = {
  name: z.string().trim().min(1).max(80),
  emailDomains: EmailDomains,
  jitEnabled: z.boolean().default(false),
};
export const CreateSsoProviderRequest = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('oidc'), ...SsoProviderCommon, issuer: z.url(), clientId: z.string().min(1).max(200), clientSecret: z.string().min(1).max(500) }),
    z.object({ kind: z.literal('saml'), ...SsoProviderCommon, idpEntityId: z.string().trim().min(1).max(500), idpSsoUrl: z.url(), idpCerts: IdpCertificates }),
  ])
  .openapi('CreateSsoProviderRequest');
export const UpdateSsoProviderRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    emailDomains: EmailDomains,
    jitEnabled: z.boolean(),
    enabled: z.boolean(),
    clientSecret: z.string().min(1).max(500),
    idpEntityId: z.string().trim().min(1).max(500),
    idpSsoUrl: z.url(),
    idpCerts: IdpCertificates,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'nothing to change')
  .openapi('UpdateSsoProviderRequest');
export const SsoCertificateInfo = z
  .object({ subject: z.string(), notAfter: z.iso.datetime(), fingerprint: z.string(), expired: z.boolean() })
  .openapi('SsoCertificateInfo');
export const SsoProviderResponse = z
  .object({
    id: Uuid,
    kind: z.enum(['oidc', 'saml']),
    name: z.string(),
    emailDomains: z.array(z.string()),
    jitEnabled: z.boolean(),
    enabled: z.boolean(),
    startUrl: z.string(),
    issuer: z.string().nullable(),
    clientId: z.string().nullable(),
    redirectUri: z.string().nullable(),
    idpEntityId: z.string().nullable(),
    idpSsoUrl: z.string().nullable(),
    certificates: z.array(SsoCertificateInfo),
    /** What the IdP administrator enters for this service provider (SAML). */
    sp: z.object({ entityId: z.string(), acsUrl: z.string(), metadataUrl: z.string() }).nullable(),
  })
  .openapi('SsoProviderResponse');
export const SsoProviderListResponse = z.object({ data: z.array(SsoProviderResponse) }).openapi('SsoProviderListResponse');
export const SsoDiscoverResponse = z
  .object({ providers: z.array(z.object({ id: Uuid, name: z.string(), kind: z.enum(['oidc', 'saml']), startUrl: z.string() })) })
  .openapi('SsoDiscoverResponse');

// ---------------------------------------------------------------- tenant security policy remedies (P7d)
export const StepUpRequest = z
  .object({ code: TotpCode.optional(), recoveryCode: z.string().trim().min(8).max(20).optional() })
  .refine((v) => (v.code === undefined) !== (v.recoveryCode === undefined), 'exactly one of code or recoveryCode')
  .openapi('StepUpRequest');
export const ChangePasswordRequest = z
  .object({ currentPassword: Password, newPassword: Password, tenantId: Uuid.optional() })
  .openapi('ChangePasswordRequest');

export const HealthResponse = z.object({ status: z.enum(['ok', 'degraded']), checks: z.record(z.string(), z.enum(['ok', 'fail'])) }).openapi('HealthResponse');

// ---------------------------------------------------------------- mail jobs (api → worker)
export const MailJob = z.discriminatedUnion('template', [
  z.object({ template: z.literal('verify_email'), to: z.string(), locale: Locale, vars: z.object({ displayName: z.string(), url: z.url() }) }),
  z.object({ template: z.literal('reset_password'), to: z.string(), locale: Locale, vars: z.object({ displayName: z.string(), url: z.url() }) }),
  z.object({ template: z.literal('signup_exists'), to: z.string(), locale: Locale, vars: z.object({ loginUrl: z.url(), resetUrl: z.url() }) }),
  z.object({
    template: z.literal('invitation'),
    to: z.string(),
    locale: Locale,
    vars: z.object({ tenantName: z.string(), inviterName: z.string(), url: z.url() }),
  }),
  z.object({
    template: z.literal('notification_digest'),
    to: z.string(),
    locale: Locale,
    vars: z.object({
      tenantName: z.string(),
      items: z.array(z.object({ title: z.string(), message: z.string().nullable(), url: z.url() })).min(1).max(20),
      more: z.number().int().min(0),
      url: z.url(),
    }),
  }),
  z.object({
    template: z.literal('automation_notice'),
    to: z.string(),
    locale: Locale,
    vars: z.object({ tenantName: z.string(), subject: z.string(), body: z.string(), url: z.url() }),
  }),
  z.object({
    template: z.literal('quota_warning'),
    to: z.string(),
    locale: Locale,
    vars: z.object({
      tenantName: z.string(),
      dimension: z.enum(['users', 'storage_bytes', 'records', 'call_minutes', 'ai_tokens']),
      level: z.enum(['warning', 'soft', 'hard']),
      used: z.string(),
      limit: z.string(),
      url: z.url(),
    }),
  }),
  z.object({
    template: z.literal('support_request'),
    to: z.string(),
    locale: Locale,
    vars: z.object({ tenantName: z.string(), operatorName: z.string(), reason: z.string(), minutes: z.number().int(), url: z.url() }),
  }),
]);
export type MailJob = z.infer<typeof MailJob>;
export const MAIL_QUEUE = 'mail';
