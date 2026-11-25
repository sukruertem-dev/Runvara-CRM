import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P9a acceptance (docs/p9-plan.md §1–7): opportunity → quote → discount approval → sent by e-mail → revision; template.

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
  for (const m of ['crm', 'sales_b2b', 'sales_tracking']) await api('POST', `/v1/modules/${m}/enable`, as);
  const team = await api<{ id: string }>('POST', '/v1/teams', { ...as, body: { name: 'Saha' } });
  const lead = await addMember(admin, 'manager', 'Mert Lider');
  const rep = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  await api('PUT', `/v1/teams/${team.id}/members/${lead.userId}`, { ...as, body: { role: 'manager' } });
  await api('PUT', `/v1/teams/${team.id}/members/${rep.userId}`, { ...as, body: {} });
  const tax = await api<{ id: string }>('POST', '/v1/tax-rates', { ...as, body: { name: 'KDV', rate: '20' } });
  const product = await api<{ id: string }>('POST', '/v1/products', { ...as, body: { sku: 'FLT-1', name: 'Filo takip cihazı', unit: 'adet', segments: ['b2b'], taxRateId: tax.id } });
  const list = await api<{ id: string }>('POST', '/v1/price-lists', { ...as, body: { name: 'Genel', currency: 'TRY' } });
  await api('PUT', `/v1/price-lists/${list.id}/products/${product.id}`, { ...as, body: { breaks: [{ minQty: '1', unitPrice: '1000' }] } });
  const opp = await api<{ id: string }>('POST', '/v1/opportunities', { token: rep.token, body: { name: 'Filo anlaşması', segment: 'b2b', amount: '1000', currency: 'TRY' } });
  return { admin, lead, rep, opp };
}

test('teklif: katalogdan kalem, iskonto onayı, gönderim, yeni sürüm', async ({ browser }) => {
  const { lead, rep, opp } = await setup('quote');
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [r, l] = await Promise.all(contexts.map((c) => c.newPage()));
  if (!r || !l) throw new Error('no page');
  try {
    await loginUi(r, rep.email);
    await r.goto(`/crm/opportunity/${opp.id}`);
    await r.getByTestId('quote-new').click();
    await expect(r.getByTestId('quote-number')).toContainText(/^T-\d{4}-00001$/, { timeout: 60_000 });
    await r.getByRole('combobox', { name: 'Ürün ekle' }).click();
    await r.getByRole('option', { name: /Filo takip cihazı/ }).click();
    const line = r.getByTestId('quote-line');
    await line.getByLabel('Miktar (adet)').fill('3');
    await line.getByLabel('İskonto (%)').fill('12');
    await expect(r.getByTestId('quote-submit')).toBeDisabled();
    await r.getByTestId('quote-save').click();
    await expect(r.getByTestId('quote-totals')).toContainText('3.168,00 TRY', { timeout: 30_000 });
    await expect(r.getByTestId('quote-approval')).toContainText('%12');
    await expectNoSeriousA11y(r, 'quote editor');

    // Beyond the own authority a reason is asked for, then the manager decides.
    await r.getByTestId('quote-submit').click();
    await r.getByTestId('quote-submit-save').click();
    await expect(r.getByTestId('quote-submit-dialog')).toContainText('Bu iskonto (%12) onay gerektiriyor');
    await r.getByTestId('quote-submit-dialog').getByLabel('Gerekçe').fill('Rakip teklifi');
    await expectNoSeriousA11y(r, 'submit dialog');
    await r.getByTestId('quote-submit-save').click();
    await expect(r.getByTestId('quote-status')).toContainText('Onay bekliyor');
    await expect(r.getByTestId('quote-content')).toBeVisible();

    await loginUi(l, lead.email);
    await l.goto('/approvals');
    await l.getByRole('link', { name: /Teklif T-\d{4}-00001, sürüm 1/ }).click();
    await expect(l.getByTestId('quote-content')).toContainText('Filo takip cihazı', { timeout: 60_000 });
    await expectNoSeriousA11y(l, 'quote read-only');
    await l.goto('/approvals');
    await l.getByRole('button', { name: 'Onayla: Filo anlaşması' }).click();
    await l.getByTestId('decision-save').click();

    // The open page follows the decision; the version goes out and can no longer be edited.
    await expect(r.getByTestId('quote-status')).toContainText('Gönderilebilir', { timeout: 30_000 });
    await r.getByTestId('quote-send').click();
    await r.getByTestId('quote-send-dialog').getByLabel('Alıcılar').fill('musteri@firma.test');
    await r.getByTestId('quote-send-dialog').getByLabel('Mesaj').fill('Teklifimiz ektedir.');
    await expectNoSeriousA11y(r, 'send dialog');
    await r.getByTestId('quote-send-save').click();
    await expect(r.getByTestId('quote-status')).toContainText('Gönderildi', { timeout: 30_000 });
    await expect(r.getByText(/musteri@firma\.test/)).toBeVisible();
    const download = r.waitForEvent('download');
    await r.getByRole('button', { name: 'PDF indir', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/^T-\d{4}-00001-v1\.pdf$/);

    await r.getByTestId('quote-revise').click();
    await expect(r.getByTestId('quote-status')).toContainText('Taslak', { timeout: 30_000 });
    await expect(r.getByTestId('quote-versions').getByRole('listitem')).toHaveCount(2);

    await r.goto('/sales/b2b/quotes');
    await expect(r.getByTestId('quote-list')).toContainText('Filo anlaşması', { timeout: 30_000 });
    await expectNoSeriousA11y(r, 'quote list');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('teklif şablonu: ön ek ve standart koşullar yeni teklife yansır', async ({ page }) => {
  const { admin, opp } = await setup('qtpl');
  await loginUi(page, admin.email);
  await page.goto('/settings/quotes');
  await page.getByTestId('qtpl-prefix').fill('FLX');
  await page.getByLabel('Koşullar').fill('Ödeme 30 gün.');
  await expectNoSeriousA11y(page, 'quote template');
  await page.getByTestId('qtpl-save').click();
  await page.getByRole('button', { name: 'Uygula' }).click();
  await expect(page.getByText('Teklif şablonu kaydedildi.').first()).toBeVisible({ timeout: 30_000 });
  await page.goto(`/crm/opportunity/${opp.id}`);
  await page.getByTestId('quote-new').click();
  await expect(page.getByTestId('quote-number')).toContainText(/^FLX-/, { timeout: 60_000 });
  await expect(page.getByLabel('Koşullar')).toHaveValue('Ödeme 30 gün.');
  await page.getByTestId('quote-preview').click();
  await expect(page.getByTestId('quote-preview-frame')).toBeVisible({ timeout: 30_000 });
});
