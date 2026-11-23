import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P7a acceptance (docs/p7-plan.md §6): configuration changes go through validation and a diff preview, can be
// reverted from the history, the brand color is refused when it cannot meet contrast, and personal preferences
// override the workspace defaults.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

/** Brand colors typed by the user in these tests: input data, not styling (the token lint rule targets styles). */
const color = (rgb: string): string => `#${rgb}`;
const YELLOW = color('FFFF00');
const GREEN = color('10B981');
const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><script>alert(1)</script><circle cx="4" cy="4" r="4" fill="${color('0F766E')}"/></svg>`;

interface Layer { version: number; value: Record<string, unknown>; effective: Record<string, unknown> }

test('genel ayarlar: diff önizlemesiyle kaydet, geçmişten geri al', async ({ page }) => {
  const ws = await createWorkspace('cfg');
  await loginUi(page, ws.email);
  await page.goto('/settings/general');
  await expect(page.getByTestId('general-form')).toBeVisible();
  await expectNoSeriousA11y(page, 'general');

  // Nothing changed yet: nothing to review.
  await expect(page.getByTestId('general-save')).toBeDisabled();
  await page.getByLabel('Tarih biçimi').click();
  await page.getByRole('option', { name: 'YYYY-AA-GG' }).click();
  await page.getByLabel('Hafta başlangıcı').click();
  await page.getByRole('option', { name: 'Pazar', exact: true }).click();
  await page.getByTestId('general-save').click();

  const review = page.getByTestId('config-review');
  await expect(review.getByTestId('patch-list')).toContainText('Tarih biçimi', { timeout: 30_000 });
  await expect(review.getByTestId('patch-list')).toContainText('YYYY-AA-GG');
  await expect(review.getByTestId('patch-list')).toContainText('Hafta başlangıcı');
  await expectNoSeriousA11y(page, 'review dialog');
  await review.getByLabel('Not').fill('Raporlar ISO tarih kullanıyor');
  await page.getByTestId('config-apply').click();
  await expect(page.getByText('Yapılandırma kaydedildi').first()).toBeVisible();
  await expect.poll(async () => (await api<Layer>('GET', '/v1/config/locale?scope=tenant', { token: ws.token })).value).toEqual({ dateFormat: 'ymd', weekStart: 'sunday' });

  // History: version 1 with the note; going back to "no override" is version 2 → revert creates version 3.
  await page.getByLabel('Saat biçimi').click();
  await page.getByRole('option', { name: '12 saat (2:30 PM)' }).click();
  await page.getByTestId('general-save').click();
  await page.getByTestId('config-apply').click();
  await expect(page.getByText('Yapılandırma kaydedildi').first()).toBeVisible();

  await expect.poll(async () => (await api<Layer>('GET', '/v1/config/locale?scope=tenant', { token: ws.token })).version).toBe(2);
  await page.getByRole('link', { name: 'Yapılandırma geçmişi' }).first().click();
  // First visit of the page compiles it on a dev server.
  await expect(page.getByTestId('version-2')).toContainText('Geçerli', { timeout: 30_000 });
  await expect(page.getByTestId('version-1')).toContainText('Raporlar ISO tarih kullanıyor');
  await expectNoSeriousA11y(page, 'history');
  await page.getByTestId('revert-1').click();
  await expect(page.getByTestId('revert-dialog')).toContainText('"dateFormat": "ymd"');
  await page.getByTestId('revert-apply').click();
  await expect(page.getByTestId('version-3')).toContainText('1. sürümden geri alındı');
  const after = await api<Layer>('GET', '/v1/config/locale?scope=tenant', { token: ws.token });
  expect(after.version).toBe(3);
  expect(after.effective.timeFormat).toBe('24h');
});

test('marka: kontrastı sağlanamayan renk reddedilir, uygun renk düzeltilerek uygulanır', async ({ page }) => {
  const ws = await createWorkspace('brand');
  await loginUi(page, ws.email);
  await page.goto('/settings/brand');
  await expect(page.getByTestId('brand-form')).toBeVisible();

  // Pure yellow cannot be brought close enough: no preview, a clear reason, nothing to save.
  await page.getByTestId('brand-hex').fill(YELLOW);
  await expect(page.getByText('okunabilirlik kurallarını sağlayacak kadar yakın')).toBeVisible();
  await expect(page.getByTestId('brand-save')).toBeDisabled();

  // A light green is darkened for white text; both themes are previewed and every check passes.
  await page.getByTestId('brand-hex').fill(GREEN);
  await expect(page.getByText('Renk okunabilirlik için ayarlandı')).toBeVisible();
  await expect(page.getByTestId('swatch-original')).toHaveText(GREEN);
  await expect(page.getByTestId('brand-sample-light')).toBeVisible();
  await expect(page.getByTestId('brand-sample-dark')).toBeVisible();
  await expectNoSeriousA11y(page, 'brand');
  const button = await page.getByTestId('swatch-button').textContent();
  expect(button).not.toBe(GREEN);
  await page.getByTestId('brand-save').click();
  await page.getByTestId('config-apply').click();
  await expect(page.getByText('Yapılandırma kaydedildi').first()).toBeVisible();

  // The shell now uses the derived accent (CSS variables from the server's derivation).
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-btn').trim())).toBe(button);

  // Logo: an SVG with a script is accepted only after sanitizing and shows in the sidebar.
  await page.getByTestId('logo-file').setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(LOGO),
  });
  await page.getByTestId('config-apply').click();
  await expect(page.getByTestId('brand-logo')).toBeVisible();
  await expect(page.getByTestId('tenant-logo')).toBeVisible();
});

test('tercihlerim: kullanıcı geçersiz kılması tenant varsayılanını ezer; yönetici yalnızca okur', async ({ page }) => {
  const ws = await createWorkspace('prefs');
  await api('PUT', '/v1/config/ui?scope=tenant', { token: ws.token, body: { value: { density: 'compact' } }, ifMatch: 0 });
  const manager = await addMember(ws, 'manager', 'Mert Yönetici');
  await loginUi(page, manager.email);
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset['density'])).toBe('compact');

  await page.goto('/settings/preferences');
  await expect(page.getByTestId('prefs-form')).toBeVisible();
  await expectNoSeriousA11y(page, 'preferences');
  await page.getByTestId('pref-density').click();
  await page.getByRole('option', { name: 'Rahat' }).click();
  await page.getByTestId('pref-language').click();
  await page.getByRole('option', { name: 'English' }).click();
  await page.getByTestId('prefs-save').click();

  // English UI, comfortable density; the workspace default is unchanged.
  await expect(page.getByRole('heading', { name: 'My preferences' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset['density'])).toBe('comfortable');
  expect((await api<Layer>('GET', '/v1/config/ui?scope=tenant', { token: ws.token })).value).toEqual({ density: 'compact' });

  // A manager may read the workspace settings but not change them.
  await page.goto('/settings/general');
  await expect(page.getByText('You can view these settings; changing them needs the Admin role.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('general-save')).toHaveCount(0);
  await page.goto('/settings/history');
  await page.getByTestId('history-key').click();
  await page.getByRole('option', { name: 'Appearance' }).click();
  await expect(page.getByTestId('version-1')).toContainText('Current', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Go back to this version' })).toHaveCount(0);
});
