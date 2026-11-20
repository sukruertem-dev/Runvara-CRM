// Error code catalogue (ADR-0012). Single source for API responses and UI messages (i18n key = `error.<code>`).
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  CSRF_INVALID: 403,
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  MFA_INVALID: 401,
  REFRESH_INVALID: 401,
  REFRESH_REUSED: 401,
  TENANT_REQUIRED: 401,
  EMAIL_NOT_VERIFIED: 403,
  ACCOUNT_DISABLED: 403,
  FORBIDDEN: 403,
  MANAGER_LIMIT: 403,
  NOT_FOUND: 404,
  MODULE_DISABLED: 404,
  CONFLICT: 409,
  SLUG_TAKEN: 409,
  MFA_ALREADY_ENABLED: 409,
  INVITATION_INVALID: 410,
  TOKEN_INVALID: 410,
  PASSWORD_POLICY: 422,
  MODULE_UNKNOWN: 422,
  MODULE_ALWAYS_ON: 422,
  MODULE_DEPENDENCY_UNMET: 422,
  MODULE_HAS_DEPENDENTS: 422,
  INVITATION_EMAIL_MISMATCH: 422,
  ROLE_UNKNOWN: 422,
  SSO_EMAIL_UNVERIFIED: 422,
  SSO_NOT_MEMBER: 403,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: { path: string; code: string; message: string }[];
  [extension: string]: unknown;
}

export const PROBLEM_TYPE_BASE = 'https://docs.runvara.app/errors/';
