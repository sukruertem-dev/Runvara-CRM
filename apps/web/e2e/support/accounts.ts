import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { waitForToken } from './mailpit';

export const PASSWORD = 'Kuvvetli-Parola-2026!x';
const WEB_BASE = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const API = `${WEB_BASE}/api`;

let counter = 0;
export function uniqueId(label: string): string {
  counter += 1;
  return `${label}-${String(Date.now())}${String(counter)}${Math.floor(Math.random() * 1000).toString()}`;
}

interface ApiOptions {
  token?: string;
  body?: unknown;
  ifMatch?: number;
}

/** Calls the API through the web app's /api proxy (same path the browser uses). */
export async function api<T = Record<string, unknown>>(method: string, path: string, opts: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.ifMatch !== undefined) headers['if-match'] = `"${String(opts.ifMatch)}"`;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  // A stack with the default per-IP limits (20 auth requests a minute) can throttle a fast run, where every
  // account comes from one machine: wait as the API asks and try again.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, init);
    const text = await res.text();
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get('retry-after') ?? '20');
      await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(wait) ? wait + 1 : 21) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${String(res.status)} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export interface Workspace {
  email: string;
  displayName: string;
  tenantName: string;
  token: string;
  userId: string;
}

/** Sign-up, e-mail verification and login through the API (the UI flow itself is covered by auth.spec.ts). */
export async function createWorkspace(label: string, displayName = 'Deniz Yönetici', fixedTenantName?: string): Promise<Workspace> {
  const id = uniqueId(label);
  const email = `e2e-${id}@firma.test`;
  const tenantName = fixedTenantName ?? `Firma ${id}`;
  await api('POST', '/v1/auth/signup', { body: { email, password: PASSWORD, displayName, tenantName, tenantSlug: `e2e-${id}`.slice(0, 40) } });
  await api('POST', '/v1/auth/email/verify', { body: { token: await waitForToken(email, 'doğrulayın') } });
  const login = await api<{ accessToken: string; user: { id: string } }>('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
  return { email, displayName, tenantName, token: login.accessToken, userId: login.user.id };
}

/** Invites a member with `role` and accepts the invitation; returns their login. */
export async function addMember(admin: Workspace, role: string, displayName: string): Promise<{ email: string; token: string; userId: string }> {
  const email = `e2e-${uniqueId(role)}@firma.test`;
  await api('POST', '/v1/invitations', { token: admin.token, body: { email, roleKey: role } });
  await api('POST', '/v1/invitations/accept', { body: { token: await waitForToken(email, 'davet'), password: PASSWORD, displayName } });
  const login = await api<{ accessToken: string; user: { id: string } }>('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
  return { email, token: login.accessToken, userId: login.user.id };
}

export async function loginUi(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Parola', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  // Generous: password hashing is deliberately slow, and a dev server compiles pages on first visit.
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Bulk data for volume tests, written straight into the Compose PostgreSQL (the API's per-IP rate limit makes
 * 10 000 HTTP creates take over 15 minutes). Rows use the tenant's default task workflow and initial status.
 */
export async function seedTasksSql(ws: Workspace, count: number): Promise<void> {
  const tenant = await api<{ id: string }>('GET', '/v1/tenant', { token: ws.token });
  if (!UUID.test(tenant.id) || !UUID.test(ws.userId) || !Number.isInteger(count)) throw new Error('bad seed input');
  const sql = `
    INSERT INTO tasks (tenant_id, title, workflow_id, status_id, priority, owner_type, owner_id, position, created_by)
    SELECT w.tenant_id, 'Görev ' || lpad(g::text, 5, '0'), w.id, s.id, g % 5, 'user', '${ws.userId}', 'b' || lpad(g::text, 6, '0'), '${ws.userId}'
    FROM workflows w JOIN statuses s ON s.workflow_id = w.id AND s.is_initial, generate_series(1, ${String(count)}) g
    WHERE w.tenant_id = '${tenant.id}' AND w.resource_type = 'task' AND w.is_default`;
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'flexa', '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], {
    cwd: resolve(__dirname, '../../../..'),
    stdio: 'pipe',
  });
}

/** Moves an opportunity's history `days` back, so it reads as untouched (P9c). Test data only. */
export async function backdateOpportunity(ws: Workspace, opportunityId: string, days: number): Promise<void> {
  const tenant = await api<{ id: string }>('GET', '/v1/tenant', { token: ws.token });
  if (!UUID.test(tenant.id) || !UUID.test(opportunityId) || !Number.isInteger(days)) throw new Error('bad backdate input');
  const sql = `SET session_replication_role = replica;
    UPDATE activity_events SET occurred_at = now() - interval '${String(days)} days' WHERE tenant_id = '${tenant.id}' AND record_id = '${opportunityId}';
    UPDATE opportunities SET created_at = now() - interval '${String(days)} days' WHERE tenant_id = '${tenant.id}' AND id = '${opportunityId}';`;
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'flexa', '-v', 'ON_ERROR_STOP=1', '-q', '-c', sql], {
    cwd: resolve(__dirname, '../../../..'),
    stdio: 'pipe',
  });
}
