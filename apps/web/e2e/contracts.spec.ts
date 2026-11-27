import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P9b acceptance (docs/p9-plan.md §8–14): won opportunity → contract (renewal) and order from the accepted quote;
// buying roles; sales pipelines.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

async function setup(label: string) {
  const admin = await createWorkspace(label, 'Deniz Yönetici');
  const as = { token: admin.token };
  await api('POST', '/v1/onboarding/skip', as);
  for (const m of ['crm', 'sales_b2b']) await api('POST', `/v1/modules/${m}/enable`, as);
  const rep = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  const me = { token: rep.token };
  const product = await api<{ id: string }>('POST', '/v1/products', { ...as, body: { sku: 'BKM-1', name: 'Bakım hizmeti', unit: 'ay', segments: ['b2b'] } });
  const list = await api<{ id: string }>('POST', '/v1/price-lists', { ...as, body: { name: 'Genel', currency: 'TRY' } });
  await api('PUT', `/v1/price-lists/${list.id}/products/${product.id}`, { ...as, body: { breaks: [{ minQty: '1', unitPrice: '100' }] } });
  const account = await api<{ id: string }>('POST', '/v1/accounts', { ...me, body: { name: 'Anadolu Lojistik', segments: ['b2b'] } });
  const contact = await api<{ id: string }>('POST', '/v1/contacts', { ...me, body: { firstName: 'Ayşe', lastName: 'Yılmaz', segments: ['b2b'], account: { id: account.id, role: 'user' } } });
  const opp = await api<{ id: string }>('POST', '/v1/opportunities', { ...me, body: { name: 'Yıllık bakım', segment: 'b2b', amount: '1200', currency: 'TRY', accountId: account.id } });
  const q = await api<{ id: string; version: number }>('POST', '/v1/sales/b2b/quotes', { ...me, body: { opportunityId: opp.id } });
  await api('PUT', `/v1/sales/b2b/quotes/${q.id}/draft`, { ...me, ifMatch: q.version, body: { validUntil: '2099-12-31', lines: [{ productId: product.id, quantity: '12' }] } });
  await api('POST', `/v1/sales/b2b/quotes/${q.id}/submit`, { ...me, body: {} });
  await api('POST', `/v1/sales/b2b/quotes/${q.id}/send`, { ...me, body: { to: ['musteri@firma.test'] } });
  await api('POST', `/v1/sales/b2b/quotes/${q.id}/outcome`, { ...me, body: { outcome: 'accepted' } });
  return { admin, rep, opp, account, contact };
}

test('kazanılan fırsat: sözleşme, yenileme ve kabul edilen tekliften sipariş', async ({ page }) => {
  const { rep, opp } = await setup('ctr');
  await loginUi(page, rep.email);
  await page.goto(`/crm/opportunity/${opp.id}`);
  await expect(page.getByTestId('contracts-panel')).toContainText('fırsat kazanılmış olmalı', { timeout: 60_000 });
  await api('POST', `/v1/opportunities/${opp.id}/transition`, { token: rep.token, body: { transitionKey: 'win' } });
  await page.reload();

  await page.getByTestId('contract-new').click();
  const dialog = page.getByTestId('contract-dialog');
  await dialog.getByLabel('Başlangıç', { exact: true }).fill('2026-01-01');
  await dialog.getByLabel('Bitiş', { exact: true }).fill('2026-12-31');
  await expectNoSeriousA11y(page, 'contract dialog');
  await page.getByTestId('contract-save').click();
  await expect(page.getByTestId('contract-number')).toContainText(/^S-\d{4}-00001$/, { timeout: 60_000 });
  await expect(page.getByTestId('contract-status')).toContainText('Yürürlükte');
  await expect(page.getByLabel(/Tutar/)).toHaveValue('1200.00');
  await expectNoSeriousA11y(page, 'contract');
  await page.getByTestId('contract-renew').click();
  await page.getByTestId('renew-save').click();
  await expect(page.getByTestId('contract-status')).toContainText('Yenilendi', { timeout: 30_000 });
  await page.getByTestId('contract-next').click();
  await expect(page.getByTestId('contract-number')).toContainText(/-00002$/, { timeout: 30_000 });

  await page.goto(`/crm/opportunity/${opp.id}`);
  await page.getByTestId('order-new').click();
  await expectNoSeriousA11y(page, 'order dialog');
  await page.getByTestId('order-save').click();
  await expect(page.getByTestId('order-number')).toContainText(/^SP-\d{4}-00001$/, { timeout: 60_000 });
  await expect(page.getByTestId('order-lines')).toContainText('Bakım hizmeti');
  await expectNoSeriousA11y(page, 'order');
  await page.getByTestId('order-fulfil').click();
  await expect(page.getByTestId('order-status')).toContainText('Teslim edildi', { timeout: 30_000 });
  await page.goto('/sales/b2b/orders');
  await expect(page.getByTestId('order-list')).toContainText('Yıllık bakım', { timeout: 30_000 });
  await page.goto('/sales/b2b/contracts');
  await expect(page.getByTestId('contract-list').getByRole('listitem')).toHaveCount(2, { timeout: 30_000 });
  await expectNoSeriousA11y(page, 'contract list');
});

test('satın alma rolleri ve satış hatları', async ({ page }) => {
  const { admin, account, contact } = await setup('pipe');
  await loginUi(page, admin.email);
  await page.goto(`/crm/account/${account.id}`);
  const role = page.getByRole('combobox', { name: 'Rol: Ayşe Yılmaz' });
  await expect(role).toContainText('Kullanıcı', { timeout: 60_000 });
  await role.click();
  await page.getByRole('option', { name: 'Karar verici' }).click();
  await expect(page.getByText('Rol kaydedildi.').first()).toBeVisible({ timeout: 30_000 });
  const c = await api<{ accounts: { role: string }[] }>('GET', `/v1/contacts/${contact.id}`, { token: admin.token });
  expect(c.accounts[0]?.role).toBe('decision_maker');

  await page.goto('/settings/pipelines');
  const field = page.getByLabel('Varsayılan satış hattı: Olasılık (%): Teklif');
  await expect(field).toHaveValue('50', { timeout: 30_000 });
  await field.fill('40');
  await page.getByRole('button', { name: 'Olasılıkları kaydet: Varsayılan satış hattı' }).click();
  await expect(page.getByText('Satış hattı kaydedildi.').first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('pipe-new').click();
  await page.getByLabel('Ad', { exact: true }).fill('Kurumsal');
  await page.getByRole('button', { name: 'Oluştur' }).click();
  await expect(page.getByTestId('pipe-item')).toHaveCount(2, { timeout: 30_000 });
  await expectNoSeriousA11y(page, 'pipelines');
});
