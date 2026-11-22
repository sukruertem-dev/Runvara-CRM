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
  .object({ user: UserSummary, tenant: TenantSummary.nullable(), tenants: z.array(TenantSummary) })
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
  'users.manage',
  'authz.matrix.read',
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
  .object({ id: z.string(), displayNameKey: z.string(), enabled: z.boolean(), alwaysOn: z.boolean(), dependsOn: z.array(z.array(z.string())) })
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

export const CreateSsoProviderRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    issuer: z.url(),
    clientId: z.string().min(1).max(200),
    clientSecret: z.string().min(1).max(500),
    emailDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).min(1).max(20),
    jitEnabled: z.boolean().default(false),
  })
  .openapi('CreateSsoProviderRequest');
export const SsoProviderResponse = z
  .object({ id: Uuid, name: z.string(), issuer: z.string(), clientId: z.string(), emailDomains: z.array(z.string()), jitEnabled: z.boolean(), enabled: z.boolean() })
  .openapi('SsoProviderResponse');

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
]);
export type MailJob = z.infer<typeof MailJob>;
export const MAIL_QUEUE = 'mail';
