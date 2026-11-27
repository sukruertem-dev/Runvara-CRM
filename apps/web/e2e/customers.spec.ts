import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P9d acceptance (docs/p9-plan.md §22–29): a B2C customer with addresses and tags; channel consent with source and
// time, withdrawal in the history; the consent gate answers "may not be reached".

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

test('B2C müşteri: profil, adres, etiket; kanal bazlı izin ve geri çekme', async ({ page }) => {
  const admin = await createWorkspace('b2c', 'Deniz Yönetici');
  const as = { token: admin.token };
  await api('POST', '/v1/onboarding/skip', as);
  for (const m of ['crm', 'sales_b2c']) await api('POST', `/v1/modules/${m}/enable`, as);
  const rep = await addMember(admin, 'sales_rep', 'Zeynep Arslan');

  await loginUi(page, rep.email);
  await page.goto('/sales/b2c');
  await expect(page).toHaveURL(/\/sales\/b2c\/customers$/, { timeout: 60_000 });
  await page.getByTestId('customer-new').click();
  const create = page.getByTestId('customer-dialog');
  await create.getByLabel('Ad', { exact: true }).fill('Elif');
  await create.getByLabel('Soyad').fill('Demir');
  await create.getByLabel('E-posta').fill('elif@ornek.test');
  await create.getByLabel('Telefon').fill('0532 111 22 33');
  await expectNoSeriousA11y(page, 'new customer');
  await page.getByTestId('customer-create').click();
  await expect(page).toHaveURL(/\/crm\/contact\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const id = page.url().split('/').pop() ?? '';

  // Profile: tags and preferred channel.
  const profile = page.getByTestId('customer-profile');
  await expect(profile).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('tag-input').fill('VIP');
  await page.getByTestId('tag-input').press('Enter');
  await profile.getByRole('combobox', { name: 'Tercih ettiği kanal' }).click();
  await page.getByRole('option', { name: 'SMS' }).click();
  await page.getByTestId('profile-save').click();
  await expect(page.getByText('Profil kaydedildi.').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('customer-tags')).toContainText('VIP');

  // Two addresses; the second becomes the default.
  for (const [label, line, city, def] of [['Ev', 'Atatürk Cad. 10', 'İzmir', false], ['İş', 'Plaza 3', 'İstanbul', true]] as const) {
    await page.getByTestId('address-new').click();
    const d = page.getByTestId('address-dialog');
    await d.getByLabel('Ad (ör. Ev, İş)').fill(label);
    await d.getByLabel('Adres', { exact: true }).fill(line);
    await d.getByLabel('İl', { exact: true }).fill(city);
    if (def) await d.getByRole('switch', { name: 'Varsayılan adres' }).click();
    await page.getByTestId('address-save').click();
    await expect(page.getByTestId('address-dialog')).toHaveCount(0, { timeout: 30_000 });
  }
  const addresses = page.getByTestId('customer-addresses');
  await expect(addresses.getByRole('listitem')).toHaveCount(2);
  await expect(addresses.getByRole('listitem').first()).toContainText('İş');
  await expect(addresses.getByRole('listitem').first()).toContainText('Varsayılan');

  // SMS consent from a web form, then withdrawn by phone.
  await page.getByRole('button', { name: 'İzin kaydet: SMS' }).click();
  const consent = page.getByTestId('consent-dialog');
  await consent.getByRole('combobox', { name: 'Kaynak' }).click();
  await page.getByRole('option', { name: 'Web formu' }).click();
  await consent.getByLabel('Kanıt').fill('Üyelik formu');
  await expectNoSeriousA11y(page, 'consent dialog');
  await page.getByTestId('consent-save').click();
  await expect(page.getByTestId('consent-sms')).toContainText('İzin var', { timeout: 30_000 });
  await expect(page.getByTestId('consent-sms')).toContainText('Web formu');
  expect(await api<{ allowed: boolean }>('GET', `/v1/sales/b2c/customers/${id}/reachability?channel=sms`, { token: rep.token })).toMatchObject({ allowed: true });
  await expectNoSeriousA11y(page, 'customer');

  await page.getByRole('button', { name: 'İzin kaydet: SMS' }).click();
  await expect(page.getByTestId('consent-dialog').getByRole('combobox', { name: 'Durum' })).toContainText('Geri çekildi');
  await page.getByTestId('consent-save').click();
  await expect(page.getByTestId('consent-sms')).toContainText('Geri çekildi', { timeout: 30_000 });
  expect(await api<{ allowed: boolean; reason: string }>('GET', `/v1/sales/b2c/customers/${id}/reachability?channel=sms`, { token: rep.token })).toMatchObject({ allowed: false, reason: 'withdrawn' });
  await page.getByTestId('consent-history-open').click();
  await expect(page.getByTestId('consent-history').getByRole('listitem')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByTestId('consent-history').getByRole('listitem').first()).toContainText('Geri çekildi');
  await expectNoSeriousA11y(page, 'consent history');
  await page.keyboard.press('Escape');

  // The list: by tag; nobody may be reached by SMS any more.
  await page.goto('/sales/b2c/customers');
  await expect(page.getByTestId('customer-list')).toContainText('Elif Demir', { timeout: 60_000 });
  await expect(page.getByTestId('customer-list')).toContainText('VIP');
  await page.getByRole('combobox', { name: 'İletişim izni' }).click();
  await page.getByRole('option', { name: 'SMS izni olanlar' }).click();
  await expect(page.getByText('Müşteri yok')).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'customer list');
});
