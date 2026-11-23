import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P7b acceptance (docs/p7-plan.md §12): onboarding with a blueprint, the module catalogue with plan and
// dependencies, usage and quota, configuration export → import with a dry run and a conflict.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

interface ModuleRow { id: string; enabled: boolean }

test('onboarding: şablon, satış modu ve modüller tek seferde uygulanır', async ({ page }) => {
  const ws = await createWorkspace('onb');
  await loginUi(page, ws.email);
  await expect(page.getByTestId('onboarding-card')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Kuruluma başla' }).click();
  await expect(page.getByTestId('onboarding')).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'onboarding blueprint');

  await page.getByTestId('blueprint-retail-b2c').click();
  await page.getByTestId('onboarding-next').click();
  // The blueprint chose B2C; the wizard keeps it.
  await expect(page.getByTestId('sales-mode-b2c_only').getByRole('radio')).toBeChecked();
  await expectNoSeriousA11y(page, 'onboarding sales mode');
  await page.getByTestId('onboarding-next').click();

  // Modules: the blueprint's are ticked; adding the call centre keeps CRM.
  await expect(page.getByTestId('onboarding-module-sales_b2c').getByRole('checkbox')).toBeChecked();
  await page.getByTestId('onboarding-module-call_center').click();
  await expect(page.getByTestId('onboarding-module-call_center').getByRole('checkbox')).toBeChecked();
  await expectNoSeriousA11y(page, 'onboarding modules');
  await page.getByTestId('onboarding-next').click();

  await expect(page.getByTestId('plan-summary')).toContainText('yeni', { timeout: 30_000 });
  await expect(page.getByTestId('plan-view')).toContainText('Çağrı merkezi ve santral');
  await expectNoSeriousA11y(page, 'onboarding review');
  await page.getByTestId('onboarding-finish').click();
  await expect(page.getByText('Çalışma alanınız hazır.').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('onboarding-card')).toHaveCount(0);

  expect(await api<{ status: string; blueprint: string }>('GET', '/v1/onboarding', { token: ws.token })).toEqual({ status: 'completed', blueprint: 'retail-b2c' });
  const modules = (await api<{ data: ModuleRow[] }>('GET', '/v1/modules', { token: ws.token })).data;
  expect(modules.filter((m) => m.enabled).map((m) => m.id).sort()).toEqual(['automation_sla', 'call_center', 'core', 'crm', 'sales_b2c', 'sales_tracking']);
  expect((await api<{ salesMode: string }>('GET', '/v1/tenant', { token: ws.token })).salesMode).toBe('b2c_only');
});

test('modüller ve kullanım: bağımlılık uyarısı, zincirleme kapatma, plan ve kota', async ({ page }) => {
  const ws = await createWorkspace('mod');
  await api('POST', '/v1/onboarding/skip', { token: ws.token });
  await loginUi(page, ws.email);
  await page.goto('/settings/modules');
  await expect(page.getByTestId('module-list')).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'modules');

  // Sales tracking needs a sales module: refused with the missing list.
  await page.getByRole('switch', { name: 'Satış takibi ve hedefler modülünü aç' }).click();
  await expect(page.getByText('Önce şu modüllerin açılması gerekir').first()).toBeVisible();
  await page.getByRole('switch', { name: 'CRM ve müşteri 360 modülünü aç' }).click();
  await expect(page.getByText('CRM ve müşteri 360 açıldı.').first()).toBeVisible();
  await page.getByRole('switch', { name: 'B2B satış modülünü aç' }).click();
  await expect(page.getByRole('switch', { name: 'B2B satış modülünü kapat' })).toBeChecked();

  // Turning CRM off would orphan B2B sales: the cascade is confirmed in a dialog; nothing is deleted.
  await page.getByRole('switch', { name: 'CRM ve müşteri 360 modülünü kapat' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bağlı modüller de kapatılsın mı?' });
  await expect(dialog).toContainText('B2B satış');
  await expectNoSeriousA11y(page, 'cascade dialog');
  await dialog.getByRole('button', { name: 'Hepsini kapat' }).click();
  await expect(page.getByRole('switch', { name: 'CRM ve müşteri 360 modülünü aç' })).not.toBeChecked();

  await page.getByRole('link', { name: 'Kullanım ve plan' }).first().click();
  await expect(page.getByTestId('usage-plan')).toContainText('Deneme', { timeout: 30_000 });
  await expect(page.getByTestId('usage-users')).toContainText('1 / 10');
  await expectNoSeriousA11y(page, 'usage');

  // A Manager reads the catalogue but cannot switch modules.
  const manager = await addMember(ws, 'manager', 'Mert Yönetici');
  await page.context().clearCookies();
  await loginUi(page, manager.email);
  await page.goto('/settings/modules');
  await expect(page.getByTestId('module-list')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('switch', { name: 'CRM ve müşteri 360 modülünü aç' })).toBeDisabled();
});

test('dışa aktar → içe aktar: kuru çalıştırma, çakışma ve koruma', async ({ page }) => {
  const source = await createWorkspace('exp');
  await api('POST', '/v1/onboarding/skip', { token: source.token });
  await api('POST', '/v1/blueprints/enterprise-b2b/apply', { token: source.token, body: {} });
  await api('POST', '/v1/custom-fields', { token: source.token, body: { resourceType: 'task', key: 'cf_effort', type: 'number', label: { tr: 'Efor' } } });
  const bundle = await api('GET', '/v1/config/export', { token: source.token });

  const target = await createWorkspace('imp');
  await api('POST', '/v1/onboarding/skip', { token: target.token });
  await api('POST', '/v1/custom-fields', { token: target.token, body: { resourceType: 'task', key: 'cf_effort', type: 'number', label: { tr: 'Süre' } } });
  await loginUi(page, target.email);
  await page.goto('/settings/transfer');
  await expect(page.getByTestId('transfer-import')).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'transfer');

  // Export downloads a JSON file.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'JSON olarak indir' }).click();
  expect((await download).suggestedFilename()).toMatch(/^flexa-config-e2e-imp.*\.json$/);

  await page.getByTestId('import-file').setInputFiles({ name: 'sandbox.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  const plan = page.getByTestId('plan-view');
  await expect(plan).toContainText('Aynı adla farklı tanım var', { timeout: 30_000 });
  await expect(page.getByTestId('plan-summary')).toContainText('1 çakışma');
  await expectNoSeriousA11y(page, 'import dry run');
  // Default: keep the workspace's own definition.
  await page.getByTestId('plan-apply').click();
  await expect(page.getByText(/Yapılandırma uygulandı/).first()).toBeVisible({ timeout: 30_000 });

  const fields = (await api<{ data: { key: string; label: Record<string, string> }[] }>('GET', '/v1/custom-fields?resourceType=task', { token: target.token })).data;
  expect(fields.find((f) => f.key === 'cf_effort')?.label).toEqual({ tr: 'Süre' });
  const accountFields = (await api<{ data: { key: string }[] }>('GET', '/v1/custom-fields?resourceType=account', { token: target.token })).data;
  expect(accountFields.map((f) => f.key)).toContain('cf_industry');
  expect((await api<{ salesMode: string }>('GET', '/v1/tenant', { token: target.token })).salesMode).toBe('b2b_only');
});
