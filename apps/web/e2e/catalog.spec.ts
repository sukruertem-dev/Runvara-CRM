import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P8a acceptance (docs/p8-plan.md §5–6): products, price lists, the price that applies, read-only roles, teams.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

async function pick(page: Page, root: ReturnType<Page['locator']>, label: string, option: string): Promise<void> {
  await root.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
}

test('ürün, fiyat listesi, miktar kırılımı, kur ve fiyat deneme; temsilci salt okunur', async ({ page, browser }) => {
  const admin = await createWorkspace('cat', 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: admin.token });
  await api('POST', '/v1/modules/crm/enable', { token: admin.token });
  const account = await api<{ id: string }>('POST', '/v1/accounts', { token: admin.token, body: { name: 'Anadolu Lojistik', segments: ['b2b'] } });
  const rep = await addMember(admin, 'sales_rep', 'Ece Temsilci');

  await loginUi(page, admin.email);
  await page.getByTestId('nav-products').click();
  await expect(page.getByTestId('product-add')).toBeVisible({ timeout: 120_000 });
  await expectNoSeriousA11y(page, 'products empty');

  await page.getByRole('tab', { name: 'Kur ve vergi' }).click();
  const taxForm = page.getByTestId('tax-form');
  await taxForm.getByLabel('Vergi adı').fill('KDV %20');
  await taxForm.getByLabel('Oran (%)').fill('20');
  await taxForm.getByRole('button', { name: 'Vergi oranı ekle' }).click();
  await expect(page.getByTestId('tax-list')).toContainText('KDV %20');
  const fx = page.getByTestId('fx-form');
  await fx.getByLabel('Tarih').fill('2026-01-01');
  await fx.getByLabel('Kur', { exact: true }).fill('40');
  await fx.getByRole('button', { name: 'Kur ekle' }).click();
  await expect(page.getByTestId('fx-list')).toContainText('1 USD = 40 TRY');
  await expectNoSeriousA11y(page, 'rates');

  await page.getByRole('tab', { name: 'Ürünler' }).click();
  await page.getByTestId('product-add').click();
  const dialog = page.getByTestId('product-dialog');
  await dialog.getByLabel('SKU').fill('LIS-1');
  await dialog.getByLabel('Ürün adı').fill('Kurumsal lisans');
  await dialog.getByLabel('Birim maliyet').fill('60,5');
  await pick(page, dialog, 'Vergi oranı', 'KDV %20');
  await expectNoSeriousA11y(page, 'product dialog');
  await page.getByTestId('product-save').click();
  await expect(page.getByTestId('product-table')).toContainText('60.5000 TRY');

  await page.getByRole('tab', { name: 'Fiyat listeleri' }).click();
  for (const [name, customer, currency] of [['Genel liste', null, 'TRY'], ['Anadolu anlaşması', 'Anadolu Lojistik', 'USD']] as const) {
    await page.getByTestId('plist-add').click();
    const d = page.getByTestId('plist-dialog');
    await d.getByLabel('Liste adı').fill(name);
    await d.getByLabel('Para birimi').fill(currency);
    if (customer) await pick(page, d, 'Müşteriye özel', customer);
    await page.getByTestId('plist-save').click();
    await expect(page.getByTestId('plist-list')).toContainText(name);
  }
  for (const [name, prices] of [['Genel liste', [['1', '100'], ['10', '90']]], ['Anadolu anlaşması', [['1', '2']]]] as const) {
    await page.getByRole('button', { name: `Fiyatlar: ${name}` }).click();
    await page.getByTestId('price-add').click();
    const f = page.getByTestId('price-form');
    await pick(page, f, 'Ürün', 'Kurumsal lisans');
    for (const [i, [qty, unit]] of prices.entries()) {
      if (i > 0) await f.getByRole('button', { name: 'Miktar kırılımı ekle' }).click();
      await f.getByLabel('En az miktar').nth(i).fill(qty);
      await f.getByLabel(/^Birim fiyat/).nth(i).fill(unit);
    }
    await page.getByTestId('price-save').click();
    await expect(page.getByTestId('prices-dialog')).toContainText(`${prices[0][1]}.0000`);
    await expectNoSeriousA11y(page, 'prices dialog');
    await page.getByRole('dialog').getByRole('button', { name: 'Kapat' }).click();
    await expect(page.getByTestId('prices-dialog')).toBeHidden();
  }
  await expectNoSeriousA11y(page, 'price lists');

  const form = page.getByTestId('try-form');
  await pick(page, form, 'Ürün', 'Kurumsal lisans');
  await form.getByLabel('Miktar').fill('12');
  await page.getByTestId('try-run').click();
  await expect(page.getByTestId('try-result')).toContainText('90.0000 TRY · Genel liste (genel)');
  await pick(page, form, 'Müşteriye özel', 'Anadolu Lojistik');
  await page.getByTestId('try-run').click();
  await expect(page.getByTestId('try-result')).toContainText('80.0000 TRY · Anadolu anlaşması (müşteriye özel)');
  await expect(page.getByTestId('try-result')).toContainText('40 kuruyla');

  // The sales rep reads without costs, buttons or the list of a customer they cannot see.
  const ctx = await browser.newContext();
  const r = await ctx.newPage();
  try {
    await loginUi(r, rep.email);
    await r.goto('/products');
    await expect(r.getByTestId('product-table')).toContainText('Kurumsal lisans', { timeout: 60_000 });
    await expect(r.getByTestId('cat-readonly')).toBeVisible();
    await expect(r.getByTestId('product-add')).toHaveCount(0);
    await expect(r.getByTestId('product-table')).not.toContainText('60.5');
    await r.getByRole('tab', { name: 'Fiyat listeleri' }).click();
    await expect(r.getByTestId('plist-list')).toContainText('Genel liste');
    await expect(r.getByTestId('plist-list')).not.toContainText('Anadolu');
    await expectNoSeriousA11y(r, 'rep price lists');
  } finally {
    await ctx.close();
  }
  expect(account.id).toBeTruthy();
});

test('ekipler: ekip ve alt ekip, üye, yönetici ve birincil ekip', async ({ page }) => {
  const admin = await createWorkspace('team', 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: admin.token });
  await addMember(admin, 'sales_rep', 'Ece Temsilci');
  await loginUi(page, admin.email);
  await page.goto('/settings/teams');
  await expect(page.getByText('Ekip yok')).toBeVisible({ timeout: 120_000 });
  for (const [name, parent] of [['Satış', null], ['Saha', 'Satış']] as const) {
    await page.getByTestId('team-add').click();
    const d = page.getByTestId('team-dialog');
    await d.getByLabel('Ekip adı').fill(name);
    if (parent) await pick(page, d, 'Üst ekip', parent);
    await page.getByTestId('team-save').click();
    await expect(page.getByTestId(`team-${name}`)).toBeVisible();
  }
  await expect(page.getByTestId('team-Saha')).toContainText('Üst ekip: Satış');
  for (const name of ['Satış', 'Saha']) {
    await page.getByRole('button', { name: `Üye ekle: ${name}` }).click();
    await pick(page, page.getByTestId('member-dialog'), 'Kişi', 'Ece Temsilci');
    await page.getByTestId('member-save').click();
    await expect(page.getByTestId(`team-${name}`)).toContainText('Ece Temsilci');
  }
  await expect(page.getByTestId('team-Satış')).toContainText('Birincil ekip');
  await page.getByRole('button', { name: 'Birincil yap: Ece Temsilci' }).click();
  await expect(page.getByTestId('team-Saha')).toContainText('Birincil ekip');
  await expect(page.getByTestId('team-Satış')).not.toContainText('Birincil ekip');
  await expectNoSeriousA11y(page, 'teams');
  await page.getByTestId('team-Saha').getByRole('button', { name: 'Ekipten çıkar: Ece Temsilci' }).click();
  await expect(page.getByTestId('team-Satış')).toContainText('Birincil ekip');
});
