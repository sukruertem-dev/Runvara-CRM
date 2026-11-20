import type { ZodType } from 'zod';
import * as S from './schemas';
import * as T from './tasks';

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
  { method: 'get', path: '/v1/tasks', summary: 'List tasks (RQL ?q=, ?sort=, cursor pagination, ?fields=, ?count=true)', tag: 'tasks', auth: 'tenant', responses: { 200: T.TaskListResponse }, errors: [400, 401, 403] },
  { method: 'post', path: '/v1/tasks', summary: 'Create a task', tag: 'tasks', auth: 'tenant', body: T.TaskCreate, responses: { 201: T.TaskView }, errors: [400, 401, 403, 404, 422] },
  { method: 'post', path: '/v1/tasks/bulk', summary: 'Bulk update up to 1000 tasks', tag: 'tasks', auth: 'tenant', body: T.TaskBulkRequest, responses: { 200: T.TaskBulkResponse }, errors: [400, 401, 403] },
  { method: 'get', path: '/v1/tasks/{id}', summary: 'Get a task (ETag = version)', tag: 'tasks', auth: 'tenant', responses: { 200: T.TaskView }, errors: [401, 404] },
  { method: 'patch', path: '/v1/tasks/{id}', summary: 'Update a task (If-Match required; status changes use /transition)', tag: 'tasks', auth: 'tenant', body: T.TaskPatch, responses: { 200: T.TaskView }, errors: [400, 401, 403, 404, 409, 412, 422] },
  { method: 'delete', path: '/v1/tasks/{id}', summary: 'Soft-delete a task (If-Match required)', tag: 'tasks', auth: 'tenant', responses: { 204: null }, errors: [401, 403, 404, 412] },
  { method: 'post', path: '/v1/tasks/{id}/restore', summary: 'Restore a soft-deleted task', tag: 'tasks', auth: 'tenant', responses: { 200: T.TaskView }, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/tasks/{id}/transition', summary: 'Workflow transition (by key or target status)', tag: 'tasks', auth: 'tenant', body: T.TaskTransitionRequest, responses: { 200: T.TaskView }, errors: [400, 401, 403, 404, 422] },
  { method: 'post', path: '/v1/tasks/{id}/move', summary: 'Reorder (fractional position) and optionally transition', tag: 'tasks', auth: 'tenant', body: T.TaskMoveRequest, responses: { 200: T.TaskView }, errors: [400, 401, 403, 404, 422] },
  { method: 'get', path: '/v1/tasks/{id}/subtasks', summary: 'Sub-tasks and completion progress', tag: 'tasks', auth: 'tenant', responses: { 200: T.SubtaskListResponse }, errors: [401, 404] },
  { method: 'get', path: '/v1/tasks/{id}/dependencies', summary: 'Blockers of this task and tasks it blocks', tag: 'tasks', auth: 'tenant', responses: { 200: T.DependencyListResponse }, errors: [401, 404] },
  { method: 'post', path: '/v1/tasks/{id}/dependencies', summary: 'Add a blocker (cycles are rejected)', tag: 'tasks', auth: 'tenant', body: T.DependencyCreate, responses: { 201: T.DependencyView }, errors: [401, 403, 404, 409, 422] },
  { method: 'delete', path: '/v1/tasks/{id}/dependencies/{blockerId}', summary: 'Remove a blocker', tag: 'tasks', auth: 'tenant', responses: { 204: null }, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/task-series', summary: 'Create a recurring task series (RRULE) and its first occurrence', tag: 'tasks', auth: 'tenant', body: T.TaskSeriesCreate, responses: { 201: T.TaskSeriesView }, errors: [400, 401, 403, 422] },
  { method: 'get', path: '/v1/workflows', summary: 'Workflows with statuses and transitions', tag: 'workflows', auth: 'tenant', responses: { 200: T.WorkflowListResponse }, errors: [401] },
  { method: 'post', path: '/v1/workflows', summary: 'Create a workflow (validated state machine)', tag: 'workflows', auth: 'tenant', body: T.WorkflowCreate, responses: { 201: T.WorkflowView }, errors: [400, 401, 403, 409, 422] },
  { method: 'get', path: '/v1/custom-fields', summary: 'Custom field definitions (?resourceType=task)', tag: 'custom-fields', auth: 'tenant', responses: { 200: T.CustomFieldListResponse }, errors: [401] },
  { method: 'post', path: '/v1/custom-fields', summary: 'Define a custom field', tag: 'custom-fields', auth: 'tenant', body: T.CustomFieldCreate, responses: { 201: T.CustomFieldView }, errors: [400, 401, 403, 409, 422] },
  { method: 'post', path: '/v1/custom-fields/{id}/archive', summary: 'Archive a custom field (values are kept)', tag: 'custom-fields', auth: 'tenant', responses: { 204: null }, errors: [401, 403, 404] },
  { method: 'post', path: '/v1/rql/validate', summary: 'Validate an RQL query (error position for the filter bar)', tag: 'rql', auth: 'tenant', body: T.RqlValidateRequest, responses: { 200: T.RqlValidateResponse }, errors: [401] },
  { method: 'get', path: '/v1/rql/fields', summary: 'Fields the caller may query/sort (?resource=task)', tag: 'rql', auth: 'tenant', responses: { 200: T.RqlFieldsResponse }, errors: [401] },
];
