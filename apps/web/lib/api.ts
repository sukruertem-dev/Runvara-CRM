import type {
  AccessTokenResponse,
  AcceptInvitationResponse,
  InvitationListResponse,
  InvitationPreviewResponse,
  InvitationResponse,
  LoginResponse,
  MeResponse,
  ModuleListResponse,
  ModuleToggleResponse,
  NavigationResponse,
  RecoveryCodesResponse,
  SessionResponse,
  TenantResponse,
  TotpSetupResponse,
} from '@flexa/contracts';

type Out<T extends { _output: unknown }> = T['_output'];

export type Session = Out<typeof SessionResponse>;
export type LoginResult = Out<typeof LoginResponse>;
export type AccessToken = Out<typeof AccessTokenResponse>;
export type Me = Out<typeof MeResponse>;
export type Tenant = Out<typeof TenantResponse>;
export type Navigation = Out<typeof NavigationResponse>;
export type TotpSetup = Out<typeof TotpSetupResponse>;
export type RecoveryCodes = Out<typeof RecoveryCodesResponse>;
export type Invitation = Out<typeof InvitationResponse>;
export type InvitationList = Out<typeof InvitationListResponse>;
export type InvitationPreview = Out<typeof InvitationPreviewResponse>;
export type AcceptInvitation = Out<typeof AcceptInvitationResponse>;
export type ModuleList = Out<typeof ModuleListResponse>;
export type ModuleToggle = Out<typeof ModuleToggleResponse>;

export interface ProblemBody {
  code?: string;
  status?: number;
  detail?: string;
  errors?: { path: string; code: string; message: string }[];
  reasons?: string[];
  [extension: string]: unknown;
}

/** RFC 9457 problem+json returned by the API (ADR-0012). */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly problem: ProblemBody;

  constructor(status: number, problem: ProblemBody) {
    super(problem.detail ?? problem.code ?? `HTTP ${String(status)}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code ?? 'UNKNOWN';
    this.problem = problem;
  }

  get fieldErrors(): { path: string; code: string; message: string }[] {
    return this.problem.errors ?? [];
  }

  get reasons(): string[] {
    return Array.isArray(this.problem.reasons) ? this.problem.reasons.filter((r): r is string => typeof r === 'string') : [];
  }
}

const API_BASE = '/api';
const CSRF_COOKIE = 'fx_csrf';

/** Access token lives in memory only (never localStorage); the refresh token is an httpOnly cookie. */
let accessToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

function csrfHeaders(): Record<string, string> {
  const csrf = readCookie(CSRF_COOKIE);
  return csrf ? { 'x-csrf-token': csrf } : {};
}

async function toApiError(res: Response): Promise<ApiError> {
  let problem: ProblemBody = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === 'object') problem = parsed as ProblemBody;
  } catch {
    problem = {};
  }
  return new ApiError(res.status, problem);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...init });
  } catch {
    throw new ApiError(0, { code: 'NETWORK', status: 0 });
  }
}

/** Rotates the refresh cookie and stores the new access token. Concurrent callers share one request. */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const res = await send('/v1/auth/refresh', { method: 'POST', headers: csrfHeaders() });
      if (!res.ok) {
        accessToken = null;
        return false;
      }
      const body = (await res.json()) as AccessToken;
      accessToken = body.accessToken;
      return true;
    } catch {
      accessToken = null;
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the Authorization header when a token exists (default true). */
  auth?: boolean;
  /** Send the CSRF header (refresh-cookie endpoints such as logout). */
  csrf?: boolean;
  /** Refresh once and retry on an expired/missing token (default true). */
  retry?: boolean;
}

const RETRY_CODES = new Set(['TOKEN_EXPIRED', 'UNAUTHENTICATED']);

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, csrf = false, retry = true } = options;
  const build = (): RequestInit => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;
    if (csrf) Object.assign(headers, csrfHeaders());
    return body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
  };

  let res = await send(path, build());
  if (res.status === 401 && auth && retry) {
    const problem = await toApiError(res.clone());
    if (RETRY_CODES.has(problem.code) && (await refreshSession())) {
      res = await send(path, build());
    }
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Tries to resume a session from the refresh cookie. Returns true when an access token is available. */
export async function bootstrapSession(): Promise<boolean> {
  if (accessToken) return true;
  return refreshSession();
}

export async function logout(): Promise<void> {
  try {
    await request<undefined>('/v1/auth/logout', { method: 'POST', auth: false, csrf: true, retry: false });
  } finally {
    accessToken = null;
  }
}
