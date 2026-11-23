import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Secret, TOTP } from 'otpauth';
import { api, createWorkspace, loginUi, PASSWORD, type Workspace } from './support/accounts';

// P7c acceptance (docs/p7-plan.md §13–17): support access only after the workspace Admin approves, read-only
// and visible to both sides; data export and a deletion that can be cancelled during the grace period.

test.describe.configure({ timeout: 300_000 });

const STEP_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

/** Turns an account into a platform operator: TOTP enrolled through the API, the operator mark set with the
 *  database owner (operators are never created through the API). Returns the TOTP secret and its step. */
async function makeOperator(ws: Workspace): Promise<{ secret: string; step: number }> {
  const setup = await api<{ secret: string }>('POST', '/v1/me/mfa/totp/setup', { token: ws.token });
  const step = Math.floor(Date.now() / STEP_MS);
  await api('POST', '/v1/me/mfa/totp/confirm', { token: ws.token, body: { code: new TOTP({ secret: Secret.fromBase32(setup.secret) }).generate() } });
  if (!UUID.test(ws.userId)) throw new Error('bad user id');
  execFileSync('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'flexa', '-v', 'ON_ERROR_STOP=1', '-q', '-c',
    `INSERT INTO platform_operators (user_id) VALUES ('${ws.userId}') ON CONFLICT DO NOTHING`], { cwd: resolve(__dirname, '../../..'), stdio: 'pipe' });
  return { secret: setup.secret, step };
}

/** Signs in with password and a TOTP code from a later step than the enrolment code (codes are single-use). */
async function loginWithTotp(page: Page, email: string, secret: string, afterStep: number): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(email);
  await page.getByLabel('Parola', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
  await expect(page).toHaveURL(/\/login\/mfa$/, { timeout: 30_000 });
  while (Math.floor(Date.now() / STEP_MS) <= afterStep) await page.waitForTimeout(500);
  await page.getByLabel('Doğrulama kodu').fill(new TOTP({ secret: Secret.fromBase32(secret) }).generate());
  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
}

test('destek erişimi: talep → Admin onayı → salt okuma oturum → iptal', async ({ browser }) => {
  const customer = await createWorkspace('sup', 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: customer.token });
  await api('POST', '/v1/tasks', { token: customer.token, body: { title: 'Destekte görülecek görev' } });
  const staff = await createWorkspace('ops', 'Ece Operatör');
  const { secret, step } = await makeOperator(staff);

  const opCtx = await browser.newContext();
  const adminCtx = await browser.newContext();
  const op = await opCtx.newPage();
  const admin = await adminCtx.newPage();
  try {
    await loginWithTotp(op, staff.email, secret, step);
    await op.goto('/operator');
    await expect(op.getByTestId('op-tenants')).toContainText(customer.tenantName, { timeout: 30_000 });
    await expectNoSeriousA11y(op, 'operator list');
    await op.getByRole('link', { name: customer.tenantName }).click();
    await expect(op.getByTestId('op-tenant-name')).toHaveText(customer.tenantName, { timeout: 30_000 });
    await expectNoSeriousA11y(op, 'operator detail');
    await op.getByTestId('op-support').getByLabel('Gerekçe (çalışma alanı yöneticisi görür)').fill('Raporlama hatasını incelemek için');
    await op.getByTestId('op-support').getByLabel('Süre (dakika, en fazla 480)').fill('60');
    await op.getByRole('button', { name: 'Talep gönder' }).click();
    await expect(op.getByText('Talep gönderildi').first()).toBeVisible();

    await loginUi(admin, customer.email);
    await admin.goto('/settings/support');
    const grants = admin.getByTestId('support-grants');
    await expect(grants).toContainText('Raporlama hatasını incelemek için', { timeout: 30_000 });
    await expectNoSeriousA11y(admin, 'support settings');
    await grants.getByRole('button', { name: 'Onayla' }).click();
    await expect(admin.getByText('Destek erişimi onaylandı').first()).toBeVisible();

    await op.goto('/operator/support');
    await op.getByRole('button', { name: 'Salt okuma aç' }).click();
    await expect(op.getByTestId('support-banner')).toContainText('Destek modu', { timeout: 30_000 });
    await op.goto('/tasks');
    await expect(op.getByText('Destekte görülecek görev')).toBeVisible({ timeout: 30_000 });

    // The Admin sees who has access, and ends it.
    await admin.goto('/');
    await expect(admin.getByTestId('support-banner')).toContainText('Ece Operatör', { timeout: 30_000 });
    await admin.goto('/settings/support');
    await admin.getByRole('button', { name: 'Erişimi sonlandır' }).click();
    await expect(admin.getByText('Destek erişimi sonlandırıldı').first()).toBeVisible();

    // The operator's next request finds the grant ended: the session leaves support mode on its own.
    await op.reload();
    await expect(op).toHaveURL(/\/operator\/support$/, { timeout: 30_000 });
    await expect(op.getByTestId('op-grants')).toContainText('Sonlandırıldı', { timeout: 30_000 });
    await expect(op.getByTestId('support-banner')).toHaveCount(0);
  } finally {
    await opCtx.close();
    await adminCtx.close();
  }
});

test('veri ve silme: dışa aktarma, silme planı, bekleme ekranı, iptal', async ({ page }) => {
  const ws = await createWorkspace('del', 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: ws.token });
  const tenant = await api<{ slug: string }>('GET', '/v1/tenant', { token: ws.token });
  await loginUi(page, ws.email);
  await page.goto('/settings/data');
  await expect(page.getByTestId('data-export')).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'data');

  await page.getByRole('button', { name: 'Dışa aktarmayı başlat' }).click();
  // The automation service builds the file; the list refreshes on its own.
  await expect(page.getByTestId('export-list').getByRole('button', { name: 'İndir' })).toBeVisible({ timeout: 60_000 });

  await expect(page.getByTestId('delete-schedule')).toBeDisabled();
  await page.getByTestId('delete-confirm').fill(tenant.slug);
  await page.getByTestId('delete-schedule').click();
  await expect(page.getByTestId('pending-deletion')).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'pending deletion');
  await page.goto('/tasks');
  await expect(page.getByTestId('pending-deletion')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Silmeyi iptal et' }).click();
  await expect(page.getByText('Silme iptal edildi.').first()).toBeVisible();
  await expect(page.getByTestId('pending-deletion')).toHaveCount(0, { timeout: 30_000 });
  expect((await api<{ status: string }>('GET', '/v1/tenant', { token: ws.token })).status).toBe('trial');
});
