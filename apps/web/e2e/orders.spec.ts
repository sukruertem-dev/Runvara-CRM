import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P9e acceptance (docs/p9-plan.md §30–38): order → payment → delivery → return, end to end (AC-G5-1); KVKK erasure.

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
  for (const m of ['crm', 'sales_b2c']) await api('POST', `/v1/modules/${m}/enable`, as);
  const team = await api<{ id: string }>('POST', '/v1/teams', { ...as, body: { name: 'Mağaza' } });
  const lead = await addMember(admin, 'manager', 'Mert Lider');
  const rep = await addMember(admin, 'sales_rep', 'Zeynep Arslan');
  await api('PUT', `/v1/teams/${team.id}/members/${lead.userId}`, { ...as, body: { role: 'manager' } });
  await api('PUT', `/v1/teams/${team.id}/members/${rep.userId}`, { ...as, body: {} });
  const tax = await api<{ id: string }>('POST', '/v1/tax-rates', { ...as, body: { name: 'KDV', rate: '20' } });
  const product = await api<{ id: string }>('POST', '/v1/products', { ...as, body: { sku: 'AYK-1', name: 'Koşu ayakkabısı', unit: 'adet', segments: ['b2c'], taxRateId: tax.id } });
  const list = await api<{ id: string }>('POST', '/v1/price-lists', { ...as, body: { name: 'Perakende', currency: 'TRY' } });
  await api('PUT', `/v1/price-lists/${list.id}/products/${product.id}`, { ...as, body: { breaks: [{ minQty: '1', unitPrice: '100' }] } });
  const customer = await api<{ id: string }>('POST', '/v1/contacts', { token: rep.token, body: { firstName: 'Elif', lastName: 'Demir', segments: ['b2c'], contactPoints: [{ kind: 'email', value: 'elif@ornek.test' }] } });
  await api('POST', `/v1/sales/b2c/customers/${customer.id}/addresses`, { token: rep.token, body: { label: 'Ev', line1: 'Atatürk Cad. 10', city: 'İzmir', isDefault: true } });
  return { admin, lead, rep, customer };
}

test('B2C sipariş: oluştur → ödeme → hazırlık, kargo, teslim → iade talebi ve Yönetici onayı', async ({ browser }) => {
  const { lead, rep, customer } = await setup('b2co');
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [r, m] = await Promise.all(contexts.map((c) => c.newPage()));
  if (!r || !m) throw new Error('no page');
  try {
    // The rep takes a phone order from the customer page.
    await loginUi(r, rep.email);
    await r.goto(`/crm/contact/${customer.id}`);
    await r.getByTestId('b2corder-new').click({ timeout: 60_000 });
    const d = r.getByTestId('b2corder-dialog');
    await d.getByRole('combobox', { name: 'Ürün ekle' }).click();
    await r.getByRole('option', { name: /Koşu ayakkabısı/ }).click();
    await d.getByLabel('Miktar').fill('2');
    await expectNoSeriousA11y(r, 'new order');
    await r.getByTestId('b2corder-save').click();
    await expect(r.getByTestId('b2corder-number')).toContainText(/^SP-\d{4}-00001$/, { timeout: 60_000 });
    await expect(r.getByTestId('b2corder-totals')).toContainText('240,00 TRY');
    await expect(r.getByTestId('b2corder-status')).toContainText('Yeni');
    const orderUrl = r.url();
    await r.getByTestId('step-confirm').click();
    await r.getByTestId('step-save').click();
    await expect(r.getByTestId('b2corder-status')).toContainText('Onaylandı', { timeout: 30_000 });
    await expect(r.getByTestId('step-prepare')).toHaveCount(0);
    await r.getByRole('combobox', { name: 'Ödeme durumu' }).click();
    await r.getByRole('option', { name: 'Ödendi' }).click();
    await expect(r.getByTestId('b2corder-payment')).toContainText('Ödendi', { timeout: 30_000 });
    await expectNoSeriousA11y(r, 'order');

    // The Manager moves it on from the list (bulk), then ships with a tracking number and delivers.
    await loginUi(m, lead.email);
    await m.goto('/sales/b2c');
    await m.getByRole('checkbox', { name: /Seç: SP-/ }).check({ timeout: 60_000 });
    await m.getByRole('combobox', { name: 'Toplu işlem' }).click();
    await m.getByRole('option', { name: 'Hazırlamaya al' }).click();
    await m.getByTestId('bulk-run').click();
    await expect(m.getByText('1 siparişin 1 tanesi güncellendi.').first()).toBeVisible({ timeout: 30_000 });
    await expectNoSeriousA11y(m, 'order list');
    await m.goto(orderUrl);
    await m.getByTestId('step-ship').click({ timeout: 60_000 });
    await m.getByTestId('step-dialog').getByLabel('Takip numarası').fill('YK123456');
    await m.getByTestId('step-save').click();
    await expect(m.getByTestId('b2corder-status')).toContainText('Kargoda', { timeout: 30_000 });
    await m.getByTestId('step-deliver').click();
    await m.getByTestId('step-save').click();
    await expect(m.getByTestId('b2corder-status')).toContainText('Teslim edildi', { timeout: 30_000 });

    // The customer sends one back; the Manager approves; the payment becomes partly refunded.
    await r.reload();
    await r.getByTestId('return-new').click({ timeout: 60_000 });
    const rd = r.getByTestId('return-dialog');
    await rd.getByLabel(/Koşu ayakkabısı/).fill('1');
    await rd.getByLabel('Açıklama').fill('Numara küçük geldi');
    await expectNoSeriousA11y(r, 'return dialog');
    await r.getByTestId('return-save').click();
    await expect(r.getByTestId('b2corder-returns')).toContainText('Onay bekliyor', { timeout: 30_000 });

    await m.goto('/sales/b2c/returns');
    await m.getByTestId('return-list').getByRole('link', { name: /^IA-/ }).click({ timeout: 60_000 });
    await expect(m.getByTestId('return-amount')).toContainText('120,00 TRY', { timeout: 60_000 });
    await expectNoSeriousA11y(m, 'return');
    await m.getByTestId('return-approve').click();
    await expect(m.getByTestId('return-status')).toContainText('Onaylandı', { timeout: 30_000 });
    await m.goto(orderUrl);
    await expect(m.getByTestId('b2corder-payment')).toContainText('Kısmen iade edildi', { timeout: 60_000 });
    await expect(m.getByTestId('b2corder-history')).toContainText('Teslim edildi');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('KVKK: müşteri verisini indir ve anonimleştir', async ({ page }) => {
  const { admin, customer } = await setup('kvkk');
  await loginUi(page, admin.email);
  await page.goto(`/crm/contact/${customer.id}`);
  const download = page.waitForEvent('download');
  await page.getByTestId('kvkk-export').click({ timeout: 60_000 });
  expect((await download).suggestedFilename()).toBe(`musteri-${customer.id}.json`);
  await page.getByTestId('kvkk-anonymize').click();
  await page.getByTestId('kvkk-dialog').getByLabel(/Onaylamak için/).fill('Elif Demir');
  await expectNoSeriousA11y(page, 'anonymize');
  await page.getByTestId('kvkk-confirm').click();
  await expect(page.getByText('Müşteri anonimleştirildi.').first()).toBeVisible({ timeout: 30_000 });
  const c = await api<{ fullName: string; contactPoints: unknown[] }>('GET', `/v1/contacts/${customer.id}`, { token: admin.token });
  expect(c.fullName).toMatch(/^Anonim #/);
  expect(c.contactPoints).toEqual([]);
});
