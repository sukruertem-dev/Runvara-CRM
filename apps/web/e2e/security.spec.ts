import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Secret, TOTP } from 'otpauth';
import { generate } from 'selfsigned';
import { addMember, api, createWorkspace, loginUi, PASSWORD, uniqueId } from './support/accounts';

// P7d acceptance (docs/p7-plan.md §18–22): a security policy blocks a member until they meet it, resolved on
// the workspace screen; SAML providers with the service provider details; SSO discovery on the sign-in page.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

const totp = (secret: string): string => new TOTP({ secret: Secret.fromBase32(secret) }).generate();

test('güvenlik politikası: 2FA zorunlu → üye engellenir → yerinde kurar → çalışma alanı açılır', async ({ browser }) => {
  const admin = await createWorkspace('pol', 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: admin.token });
  const member = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  // The Admin turns two-step verification on first (the policy refuses to lock its writer out).
  const setup = await api<{ secret: string }>('POST', '/v1/me/mfa/totp/setup', { token: admin.token });
  const { recoveryCodes } = await api<{ recoveryCodes: string[] }>('POST', '/v1/me/mfa/totp/confirm', { token: admin.token, body: { code: totp(setup.secret) } });

  const adminCtx = await browser.newContext();
  const memberCtx = await browser.newContext();
  const a = await adminCtx.newPage();
  const m = await memberCtx.newPage();
  try {
    await a.goto('/login');
    await a.getByLabel('E-posta').fill(admin.email);
    await a.getByLabel('Parola', { exact: true }).fill(PASSWORD);
    await a.getByRole('button', { name: 'Giriş yap' }).click();
    // Generous: a dev server compiles the verification page on first visit.
    await expect(a).toHaveURL(/\/login\/mfa$/, { timeout: 120_000 });
    await a.getByRole('button', { name: 'Kurtarma kodu kullan' }).click();
    await a.getByLabel('Kurtarma kodu').fill(recoveryCodes[0] ?? '');
    await a.getByRole('button', { name: 'Doğrula', exact: true }).click();
    await expect(a.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });

    await a.goto('/settings/policies');
    await expect(a.getByTestId('policy-form')).toBeVisible({ timeout: 30_000 });
    await expectNoSeriousA11y(a, 'policies');
    await a.getByRole('combobox', { name: 'Kimden istenir' }).click();
    await a.getByRole('option', { name: 'Herkesten' }).click();
    await a.getByTestId('policy-min-length').fill('16');
    await a.getByTestId('policy-save').click();
    await a.getByRole('button', { name: 'Uygula' }).click();
    await expect(a.getByText('Güvenlik politikası kaydedildi.').first()).toBeVisible({ timeout: 30_000 });

    // The member signs in: the workspace does not open; the screen explains and resolves it.
    await m.goto('/login');
    await m.getByLabel('E-posta').fill(member.email);
    await m.getByLabel('Parola', { exact: true }).fill(PASSWORD);
    await m.getByRole('button', { name: 'Giriş yap' }).click();
    const block = m.getByTestId('tenant-block');
    await expect(block).toContainText('iki adımlı doğrulama istiyor', { timeout: 120_000 });
    await expectNoSeriousA11y(m, 'tenant block');
    await block.getByRole('button', { name: 'İki adımlı doğrulamayı aç' }).click();
    const secret = (await m.getByTestId('totp-secret').textContent()) ?? '';
    await block.getByLabel('Doğrulama kodu').fill(totp(secret.trim()));
    await block.getByRole('button', { name: 'Doğrula ve aç' }).click();
    await expect(m.getByTestId('recovery-codes')).toBeVisible({ timeout: 30_000 });
    await block.getByRole('button', { name: 'Çalışma alanını aç' }).click();
    await expect(m.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
  } finally {
    await adminCtx.close();
    await memberCtx.close();
  }
});

test('SSO: SAML sağlayıcı, SP bilgileri, giriş ekranında keşif, kapatma ve silme', async ({ page, browser }) => {
  const admin = await createWorkspace('sso', 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: admin.token });
  const domain = `${uniqueId('kurum').toLowerCase()}.test`;
  const { cert } = await generate([{ name: 'commonName', value: 'idp.example.test' }], { keySize: 2048, algorithm: 'sha256' });

  await loginUi(page, admin.email);
  await page.goto('/settings/sso');
  await expect(page.getByRole('heading', { name: 'Tek oturum açma (SSO)' })).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'sso empty');
  await page.getByTestId('sso-add').click();
  const dialog = page.getByTestId('sso-dialog');
  await dialog.getByLabel('Ad (giriş düğmesinde görünür)').fill('Kurumsal SAML');
  await dialog.getByLabel('E-posta alan adları (virgülle ayırın)').fill(domain);
  await dialog.getByLabel('IdP entity ID').fill('https://idp.example.test/metadata');
  await dialog.getByLabel('IdP SSO adresi (HTTP-Redirect)').fill('https://idp.example.test/sso');
  await dialog.getByLabel('IdP imza sertifikası (PEM)').fill(cert);
  await page.getByTestId('sso-save').click();
  await expect(page.getByText('Sağlayıcı eklendi.').first()).toBeVisible({ timeout: 30_000 });
  const sp = page.getByTestId('sso-sp');
  await expect(sp).toContainText('/v1/auth/saml/');
  await expect(sp).toContainText('/acs');
  await expect(page.getByTestId('sso-providers')).toContainText('CN=idp.example.test');
  await expectNoSeriousA11y(page, 'sso list');

  // Sign-in page: an unknown domain gets an explanation; the provider's domain goes to the IdP.
  const visitorCtx = await browser.newContext();
  const v = await visitorCtx.newPage();
  try {
    await v.goto('/login');
    await v.getByRole('button', { name: 'SSO ile giriş' }).click();
    await expect(v.getByTestId('sso-form')).toBeVisible();
    await expectNoSeriousA11y(v, 'sso login');
    await v.getByLabel('E-posta').fill('kim@hic-tanimli-olmayan.test');
    await v.getByRole('button', { name: 'Devam et' }).click();
    await expect(v.getByText('Bu alan adı için tanımlı bir SSO sağlayıcısı yok.')).toBeVisible({ timeout: 30_000 });
    await v.getByLabel('E-posta').fill(`kim@${domain}`);
    const toIdp = v.waitForRequest((r) => r.url().startsWith('https://idp.example.test/sso?SAMLRequest='), { timeout: 30_000 });
    await v.getByRole('button', { name: 'Devam et' }).click();
    await toIdp;
  } finally {
    await visitorCtx.close();
  }

  // Disabled providers are not offered; then the provider is deleted.
  await page.getByRole('switch', { name: 'Kurumsal SAML: Kapat' }).click();
  await expect(page.getByRole('switch', { name: 'Kurumsal SAML: Etkinleştir' })).toBeVisible({ timeout: 30_000 });
  const found = await api<{ providers: unknown[] }>('POST', '/v1/auth/sso/discover', { body: { email: `kim@${domain}` } });
  expect(found.providers).toEqual([]);
  await page.getByRole('button', { name: 'Sil: Kurumsal SAML' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sil' }).click();
  await expect(page.getByText('Henüz sağlayıcı yok')).toBeVisible({ timeout: 30_000 });
});
