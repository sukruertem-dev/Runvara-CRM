import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { waitForLink } from './support/mailpit';

const PASSWORD = 'Kuvvetli-Parola-2026!x';
const STEP_MS = 30_000;

interface Account {
  email: string;
  tenantName: string;
  slug: string;
}

let counter = 0;
function newAccount(label: string): Account {
  counter += 1;
  const id = `${String(Date.now())}${String(counter)}${Math.floor(Math.random() * 1000).toString()}`;
  return { email: `e2e-${label}-${id}@firma.test`, tenantName: `Firma ${label} ${id}`, slug: `e2e-${label}-${id}`.slice(0, 40) };
}

async function signUpAndVerify(page: Page, acc: Account): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('Ad Soyad').fill(`Test ${acc.email.slice(4, 12)}`);
  await page.getByLabel('E-posta').fill(acc.email);
  await page.getByLabel('Parola', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Firma adı').fill(acc.tenantName);
  await page.getByLabel('Çalışma alanı adresi').fill(acc.slug);
  await page.getByRole('button', { name: 'Hesap oluştur' }).click();
  await expect(page.getByRole('heading', { name: 'E-postanızı kontrol edin' })).toBeVisible();

  const link = await waitForLink(acc.email, 'doğrulayın', '/verify-email');
  await page.goto(link);
  await expect(page.getByText('E-posta adresiniz doğrulandı')).toBeVisible();
}

async function login(page: Page, acc: Account): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('E-posta').fill(acc.email);
  await page.getByLabel('Parola', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Giriş yap' }).click();
}

async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Çıkış' }).click();
  await expect(page).toHaveURL(/\/login$/);
}

function totp(secret: string): TOTP {
  return new TOTP({ secret: Secret.fromBase32(secret), algorithm: 'SHA1', digits: 6, period: 30 });
}

async function waitForNextStep(afterStep: number): Promise<void> {
  while (Math.floor(Date.now() / STEP_MS) <= afterStep) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test('kayıt → e-posta doğrulama → giriş → 2FA → çıkış → 2FA ile giriş', async ({ page }) => {
  const acc = newAccount('mfa');
  await signUpAndVerify(page, acc);

  await login(page, acc);
  await expect(page.getByTestId('tenant-heading')).toHaveText(acc.tenantName);

  await page.goto('/settings/security');
  await page.getByRole('button', { name: 'İki adımlı doğrulamayı aç' }).click();
  const secret = (await page.getByTestId('totp-secret').textContent())?.trim() ?? '';
  expect(secret).not.toBe('');

  const confirmStep = Math.floor(Date.now() / STEP_MS);
  await page.getByLabel('Doğrulama kodu').fill(totp(secret).generate());
  await page.getByRole('button', { name: 'Doğrula ve aç' }).click();
  await expect(page.getByTestId('recovery-codes').getByRole('listitem')).toHaveCount(10);

  await page.goto('/');
  await logout(page);

  await login(page, acc);
  await expect(page).toHaveURL(/\/login\/mfa$/);
  await waitForNextStep(confirmStep);
  await page.getByLabel('Doğrulama kodu').fill(totp(secret).generate());
  await page.getByRole('button', { name: 'Doğrula' }).click();
  await expect(page.getByTestId('tenant-heading')).toHaveText(acc.tenantName);
});

test('tenant seçimi', async ({ browser }) => {
  const a = newAccount('a');
  const b = newAccount('b');
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    await signUpAndVerify(pageA, a);
    await signUpAndVerify(pageB, b);

    await login(pageB, b);
    await expect(pageB.getByTestId('tenant-heading')).toHaveText(b.tenantName);
    await pageB.goto('/settings/invitations');
    await pageB.getByLabel('E-posta').fill(a.email);
    await pageB.getByLabel('Rol').selectOption({ label: 'Yönetici' });
    await pageB.getByRole('button', { name: 'Davet gönder' }).click();
    await expect(pageB.getByText('Davet gönderildi.')).toBeVisible();

    await login(pageA, a);
    await expect(pageA.getByTestId('tenant-heading')).toHaveText(a.tenantName);

    const link = await waitForLink(a.email, 'davet ediyor', '/invite');
    await pageA.goto(link);
    await pageA.getByRole('button', { name: 'Daveti kabul et' }).click();
    await expect(pageA).toHaveURL(/\/select-tenant$/);

    await pageA.goto('/');
    await logout(pageA);
    await login(pageA, a);
    await expect(pageA).toHaveURL(/\/select-tenant$/);
    await expect(pageA.getByRole('button', { name: new RegExp(a.tenantName) })).toBeVisible();
    await pageA.getByRole('button', { name: new RegExp(b.tenantName) }).click();
    await expect(pageA.getByTestId('tenant-heading')).toHaveText(b.tenantName);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});

for (const path of ['/login', '/signup']) {
  test(`erişilebilirlik ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    expect(blocking.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
}
