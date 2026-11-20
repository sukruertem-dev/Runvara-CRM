import type { ZodType } from 'zod';
import * as S from './schemas';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';
export type AuthMode = 'none' | 'access' | 'tenant' | 'refresh_cookie';

export interface EndpointSpec {
  method: HttpMethod;
  path: string; // OpenAPI style: /v1/invitations/{id}
  summary: string;
  tag: string;
  auth: AuthMode;
  body?: ZodType;
  responses: Partial<Record<200 | 201 | 202 | 204 | 302, ZodType | null>>;
  errors: number[];
}

/** Every /v1 route the API serves. A test asserts that the Fastify route table and this list are identical. */
export const ENDPOINTS: readonly EndpointSpec[] = [
  { method: 'post', path: '/v1/auth/signup', summary: 'Self-service sign-up (user + trial tenant)', tag: 'auth', auth: 'none', body: S.SignupRequest, responses: { 202: S.AcceptedResponse }, errors: [400, 409, 422, 429] },
  { method: 'post', path: '/v1/auth/email/verify', summary: 'Verify e-mail address with the token from the e-mail', tag: 'auth', auth: 'none', body: S.TokenRequest, responses: { 204: null }, errors: [400, 410] },
  { method: 'post', path: '/v1/auth/email/resend', summary: 'Resend the verification e-mail', tag: 'auth', auth: 'none', body: S.EmailOnlyRequest, responses: { 202: S.AcceptedResponse }, errors: [400, 429] },
  { method: 'post', path: '/v1/auth/login', summary: 'E-mail + password login (may require MFA)', tag: 'auth', auth: 'none', body: S.LoginRequest, responses: { 200: S.LoginResponse }, errors: [400, 401, 403, 429] },
  { method: 'post', path: '/v1/auth/mfa/verify', summary: 'Complete login with a TOTP or recovery code', tag: 'auth', auth: 'none', body: S.MfaVerifyRequest, responses: { 200: S.SessionResponse }, errors: [400, 401, 429] },
  { method: 'post', path: '/v1/auth/tenant', summary: 'Select the active tenant for the session', tag: 'auth', auth: 'access', body: S.SelectTenantRequest, responses: { 200: S.AccessTokenResponse }, errors: [401, 404] },
  { method: 'post', path: '/v1/auth/refresh', summary: 'Rotate the refresh token (cookie + X-CSRF-Token)', tag: 'auth', auth: 'refresh_cookie', responses: { 200: S.AccessTokenResponse }, errors: [401, 403] },
  { method: 'post', path: '/v1/auth/logout', summary: 'Revoke the session (cookie + X-CSRF-Token)', tag: 'auth', auth: 'refresh_cookie', responses: { 204: null }, errors: [403] },
  { method: 'post', path: '/v1/auth/password/forgot', summary: 'Send a password reset e-mail', tag: 'auth', auth: 'none', body: S.EmailOnlyRequest, responses: { 202: S.AcceptedResponse }, errors: [400, 429] },
  { method: 'post', path: '/v1/auth/password/reset', summary: 'Set a new password with a reset token', tag: 'auth', auth: 'none', body: S.ResetPasswordRequest, responses: { 204: null }, errors: [400, 410, 422] },
  { method: 'get', path: '/v1/auth/oidc/{providerId}/start', summary: 'Start OIDC login (redirect to the IdP)', tag: 'auth', auth: 'none', responses: { 302: null }, errors: [404] },
  { method: 'get', path: '/v1/auth/oidc/{providerId}/callback', summary: 'OIDC redirect URI', tag: 'auth', auth: 'none', responses: { 302: null }, errors: [400, 403, 404, 422] },
  { method: 'get', path: '/v1/me', summary: 'Current user, active tenant and memberships', tag: 'me', auth: 'access', responses: { 200: S.MeResponse }, errors: [401] },
  { method: 'get', path: '/v1/me/navigation', summary: 'Menu for the enabled and permitted modules', tag: 'me', auth: 'tenant', responses: { 200: S.NavigationResponse }, errors: [401] },
  { method: 'post', path: '/v1/me/mfa/totp/setup', summary: 'Begin TOTP enrolment', tag: 'me', auth: 'access', responses: { 200: S.TotpSetupResponse }, errors: [401, 409] },
  { method: 'post', path: '/v1/me/mfa/totp/confirm', summary: 'Confirm TOTP enrolment; returns recovery codes once', tag: 'me', auth: 'access', body: S.TotpConfirmRequest, responses: { 200: S.RecoveryCodesResponse }, errors: [401, 409] },
  { method: 'delete', path: '/v1/me/mfa', summary: 'Disable TOTP (requires a current code)', tag: 'me', auth: 'access', body: S.TotpConfirmRequest, responses: { 204: null }, errors: [401] },
  { method: 'get', path: '/v1/tenant', summary: 'Active tenant', tag: 'tenant', auth: 'tenant', responses: { 200: S.TenantResponse }, errors: [401] },
  { method: 'get', path: '/v1/modules', summary: 'Module catalogue with this tenant’s state', tag: 'modules', auth: 'tenant', responses: { 200: S.ModuleListResponse }, errors: [401, 403] },
  { method: 'post', path: '/v1/modules/{moduleId}/enable', summary: 'Enable a module (dependencies must be met)', tag: 'modules', auth: 'tenant', responses: { 200: S.ModuleToggleResponse }, errors: [401, 403, 422] },
  { method: 'post', path: '/v1/modules/{moduleId}/disable', summary: 'Disable a module; data is kept (?cascade=true)', tag: 'modules', auth: 'tenant', responses: { 200: S.ModuleToggleResponse }, errors: [401, 403, 422] },
  { method: 'get', path: '/v1/invitations', summary: 'List invitations', tag: 'invitations', auth: 'tenant', responses: { 200: S.InvitationListResponse }, errors: [401, 403] },
  { method: 'post', path: '/v1/invitations', summary: 'Invite a user by e-mail', tag: 'invitations', auth: 'tenant', body: S.CreateInvitationRequest, responses: { 201: S.InvitationResponse }, errors: [401, 403, 409, 422] },
  { method: 'post', path: '/v1/invitations/{id}/revoke', summary: 'Revoke a pending invitation', tag: 'invitations', auth: 'tenant', responses: { 204: null }, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/invitations/preview', summary: 'Public preview of an invitation token', tag: 'invitations', auth: 'none', body: S.TokenRequest, responses: { 200: S.InvitationPreviewResponse }, errors: [410] },
  { method: 'post', path: '/v1/invitations/accept', summary: 'Accept an invitation (new account, or signed-in existing account)', tag: 'invitations', auth: 'none', body: S.AcceptInvitationRequest, responses: { 200: S.AcceptInvitationResponse }, errors: [401, 410, 422] },
  { method: 'get', path: '/v1/sso-providers', summary: 'List OIDC providers', tag: 'sso', auth: 'tenant', responses: { 200: S.SsoProviderResponse.array() }, errors: [401, 403] },
  { method: 'post', path: '/v1/sso-providers', summary: 'Add an OIDC provider (client secret stored encrypted)', tag: 'sso', auth: 'tenant', body: S.CreateSsoProviderRequest, responses: { 201: S.SsoProviderResponse }, errors: [401, 403] },
];
