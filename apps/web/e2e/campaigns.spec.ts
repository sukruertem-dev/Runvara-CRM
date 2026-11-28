import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P9f acceptance (docs/p9-plan.md §39–48): a Manager's campaign is approved by an Admin, its message reaches only the
// customers with consent (AC-G5-2), a coupon lowers an order; RFM segments.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

test('kampanya: Yönetici hazırlar, Admin onaylar; ileti yalnızca izinliye gider; kupon siparişi indirir; RFM', async ({ browser }) => {
  const admin = await createWorkspace('camp', 'Deniz Yönetici');
  const as = { token: admin.token };
  await api('POST', '/v1/onboarding/skip', as);
  for (const m of ['crm', 'sales_b2c']) await api('POST', `/v1/modules/${m}/enable`, as);
  const team = await api<{ id: string }>('POST', '/v1/teams', { ...as, body: { name: 'Pazarlama' } });
  const lead = await addMember(admin, 'manager', 'Elif Yönetici');
  const rep = await addMember(admin, 'sales_rep', 'Zeynep Arslan');
  await api('PUT', `/v1/teams/${team.id}/members/${lead.userId}`, { ...as, body: { role: 'manager' } });
  await api('PUT', `/v1/teams/${team.id}/members/${rep.userId}`, { ...as, body: {} });
  const tax = await api<{ id: string }>('POST', '/v1/tax-rates', { ...as, body: { name: 'KDV', rate: '20' } });
  const product = await api<{ id: string }>('POST', '/v1/products', { ...as, body: { sku: 'AYK-1', name: 'Koşu ayakkabısı', unit: 'adet', segments: ['b2c'], taxRateId: tax.id } });
  const list = await api<{ id: string }>('POST', '/v1/price-lists', { ...as, body: { name: 'Perakende', currency: 'TRY' } });
  await api('PUT', `/v1/price-lists/${list.id}/products/${product.id}`, { ...as, body: { breaks: [{ minQty: '1', unitPrice: '100' }] } });
  const people: string[] = [];
  for (const [first, mail, consent] of [['Ayşe', 'ayse', true], ['Burak', 'burak', false]] as const) {
    const c = await api<{ id: string }>('POST', '/v1/contacts', { token: rep.token, body: { firstName: first, lastName: 'Müşteri', segments: ['b2c'], contactPoints: [{ kind: 'email', value: `${mail}@ornek.test` }] } });
    await api('PUT', `/v1/sales/b2c/customers/${c.id}/profile`, { token: rep.token, ifMatch: 0, body: { preferredChannel: null, language: null, tags: ['VIP'] } });
    if (consent) await api('POST', `/v1/sales/b2c/customers/${c.id}/consents`, { token: rep.token, body: { channel: 'email', status: 'granted', source: 'web_form' } });
    people.push(c.id);
  }

  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [m, a, r] = await Promise.all(contexts.map((c) => c.newPage()));
  if (!m || !a || !r) throw new Error('no page');
  try {
    // The Manager drafts a VIP campaign with a message and submits it.
    await loginUi(m, lead.email);
    await m.goto('/sales/b2c');
    await m.getByTestId('campaigns-link').click({ timeout: 60_000 });
    await m.getByTestId('campaign-new').click({ timeout: 60_000 });
    const d = m.getByTestId('campaign-dialog');
    await d.getByLabel('Ad', { exact: true }).fill('VIP yaz');
    await d.getByLabel('Bitiş').fill('2099-12-31');
    await d.getByLabel('Hedef etiketler').fill('VIP');
    await d.getByLabel('E-posta konusu').fill('VIP fırsatı');
    await d.getByLabel('E-posta metni').fill('Size özel indirim.');
    await expectNoSeriousA11y(m, 'new campaign');
    await m.getByTestId('campaign-save').click();
    await expect(m.getByTestId('campaign-status')).toContainText('Taslak', { timeout: 60_000 });
    await m.getByTestId('campaign-submit').click();
    await expect(m.getByTestId('campaign-status')).toContainText('Onay bekliyor', { timeout: 30_000 });
    await expect(m.getByTestId('campaign-approve')).toHaveCount(0);
    const campaignUrl = m.url();

    // The Admin sees who it reaches, approves it, adds a coupon and sends the message.
    await loginUi(a, admin.email);
    await a.goto(campaignUrl);
    await expect(a.getByTestId('campaign-audience')).toContainText('2 müşteri hedefte, 1 müşteriye e-posta gidebilir', { timeout: 60_000 });
    await expect(a.getByTestId('campaign-audience')).toContainText('izin yok: 1');
    await expectNoSeriousA11y(a, 'campaign');
    await a.getByTestId('campaign-approve').click();
    await expect(a.getByTestId('campaign-status')).toContainText('Yürürlükte', { timeout: 30_000 });
    await a.getByTestId('coupon-code').fill('YAZ10');
    await a.getByTestId('coupon-add').click();
    await expect(a.getByTestId('coupon-list')).toContainText('YAZ10', { timeout: 30_000 });
    await a.getByTestId('campaign-send').click();
    await expect(a.getByText('1 müşteriye gönderildi.').first()).toBeVisible({ timeout: 30_000 });
    await expect(a.getByTestId('campaign-audience')).toContainText('1 müşteri');

    // The rep applies the coupon to Ayşe's order.
    await loginUi(r, rep.email);
    await r.goto(`/crm/contact/${people[0] ?? ''}`);
    await r.getByTestId('b2corder-new').click({ timeout: 60_000 });
    const od = r.getByTestId('b2corder-dialog');
    await od.getByRole('combobox', { name: 'Ürün ekle' }).click();
    await r.getByRole('option', { name: /Koşu ayakkabısı/ }).click();
    await od.getByLabel('Miktar').fill('2');
    await r.getByTestId('order-coupon').fill('YAZ10');
    await r.getByTestId('order-coupon-check').click();
    await expect(od.getByText('Geçerli: %10 indirim')).toBeVisible({ timeout: 30_000 });
    await r.getByTestId('b2corder-save').click();
    await expect(r.getByTestId('b2corder-discount')).toContainText('20,00 TRY', { timeout: 60_000 });
    await expect(r.getByTestId('b2corder-totals')).toContainText('216,00 TRY');

    // RFM: both customers are new; Ayşe with one order.
    await a.goto('/sales/b2c/rfm');
    await a.getByTestId('rfm-recompute').click({ timeout: 60_000 });
    await expect(a.getByText('RFM yeniden hesaplandı.').first()).toBeVisible({ timeout: 30_000 });
    await a.getByRole('button', { name: /Yeni/ }).click();
    await expect(a.getByTestId('rfm-list')).toContainText('Ayşe Müşteri', { timeout: 30_000 });
    await expectNoSeriousA11y(a, 'rfm');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
