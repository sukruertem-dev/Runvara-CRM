import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, backdateOpportunity, createWorkspace, loginUi } from './support/accounts';

// P9c acceptance (docs/p9-plan.md §15–21): the whole B2B flow (AC-G4-1) lead → opportunity → quote → discount
// approval → won → contract → order, then the weighted forecast with the Manager's call and a snapshot; the
// untouched-opportunity warning and the next-step rule.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

/** This month, in the browser's (and the test machine's) calendar. */
function thisMonth(): { period: string; day: string } {
  const now = new Date();
  const period = `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return { period, day: `${period}-15` };
}

async function setup(label: string) {
  const admin = await createWorkspace(label, 'Deniz Yönetici');
  const as = { token: admin.token };
  await api('POST', '/v1/onboarding/skip', as);
  for (const m of ['crm', 'sales_b2b']) await api('POST', `/v1/modules/${m}/enable`, as);
  const team = await api<{ id: string }>('POST', '/v1/teams', { ...as, body: { name: 'Kurumsal' } });
  const lead = await addMember(admin, 'manager', 'Mert Lider');
  const rep = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  await api('PUT', `/v1/teams/${team.id}/members/${lead.userId}`, { ...as, body: { role: 'manager' } });
  await api('PUT', `/v1/teams/${team.id}/members/${rep.userId}`, { ...as, body: {} });
  const product = await api<{ id: string }>('POST', '/v1/products', { ...as, body: { sku: 'BKM-1', name: 'Bakım hizmeti', unit: 'ay', segments: ['b2b'] } });
  const list = await api<{ id: string }>('POST', '/v1/price-lists', { ...as, body: { name: 'Genel', currency: 'TRY' } });
  await api('PUT', `/v1/price-lists/${list.id}/products/${product.id}`, { ...as, body: { breaks: [{ minQty: '1', unitPrice: '1000' }] } });
  return { admin, lead, rep, product };
}

test('uçtan uca B2B: aday → fırsat → teklif → iskonto onayı → sözleşme → sipariş; forecast ve Yönetici ayarı', async ({ browser }) => {
  const { lead, rep, product } = await setup('fc');
  const me = { token: rep.token };
  const { period, day } = thisMonth();

  // Lead → account, contact and opportunity in one step.
  const l = await api<{ id: string }>('POST', '/v1/leads', { ...me, body: { firstName: 'Ayşe', lastName: 'Kara', company: 'Kara Lojistik', segment: 'b2b', contactPoints: [{ kind: 'email', value: 'ayse@karalojistik.test' }] } });
  await api('POST', `/v1/leads/${l.id}/transition`, { ...me, body: { transitionKey: 'start' } });
  const conv = await api<{ opportunityId: string }>('POST', `/v1/leads/${l.id}/convert`, { ...me, body: { opportunity: { name: 'Kara Lojistik bakım', amount: '12000', currency: 'TRY', expectedClose: day } } });
  const opp = conv.opportunityId;

  // Quote above the free discount: the Manager approves, the customer accepts, the opportunity is won.
  const q = await api<{ id: string; version: number }>('POST', '/v1/sales/b2b/quotes', { ...me, body: { opportunityId: opp } });
  await api('PUT', `/v1/sales/b2b/quotes/${q.id}/draft`, { ...me, ifMatch: q.version, body: { validUntil: '2099-12-31', lines: [{ productId: product.id, quantity: '12', discountPercent: '12' }] } });
  await api('POST', `/v1/sales/b2b/quotes/${q.id}/submit`, { ...me, body: { reason: 'Yıllık taahhüt' } });
  const inbox = await api<{ data: { id: string }[] }>('GET', '/v1/approvals', { token: lead.token });
  const request = inbox.data[0];
  if (!request) throw new Error('no approval request');
  await api('POST', `/v1/approvals/${request.id}/decision`, { token: lead.token, body: { decision: 'approve' } });
  await api('POST', `/v1/sales/b2b/quotes/${q.id}/send`, { ...me, body: { to: ['ayse@karalojistik.test'] } });
  await api('POST', `/v1/sales/b2b/quotes/${q.id}/outcome`, { ...me, body: { outcome: 'accepted' } });
  await api('POST', `/v1/opportunities/${opp}/transition`, { ...me, body: { transitionKey: 'win' } });
  // A second, still open opportunity of the period.
  const open = await api<{ id: string; probability: number }>('POST', '/v1/opportunities', { ...me, body: { name: 'Depo genişletme', segment: 'b2b', amount: '4000', currency: 'TRY', expectedClose: day } });

  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [r, m] = await Promise.all(contexts.map((c) => c.newPage()));
  if (!r || !m) throw new Error('no page');
  try {
    // The rep turns the won opportunity into a contract and an order.
    await loginUi(r, rep.email);
    await r.goto(`/crm/opportunity/${opp}`);
    await r.getByTestId('contract-new').click();
    const dialog = r.getByTestId('contract-dialog');
    await dialog.getByLabel('Başlangıç', { exact: true }).fill(`${period}-01`);
    await dialog.getByLabel('Bitiş', { exact: true }).fill('2099-12-31');
    await r.getByTestId('contract-save').click();
    await expect(r.getByTestId('contract-number')).toContainText(/^S-\d{4}-00001$/, { timeout: 60_000 });
    await r.goto(`/crm/opportunity/${opp}`);
    await r.getByTestId('order-new').click();
    await r.getByTestId('order-save').click();
    await expect(r.getByTestId('order-number')).toContainText(/^SP-\d{4}-00001$/, { timeout: 60_000 });
    await expect(r.getByTestId('order-lines')).toContainText('Bakım hizmeti');

    // The Manager sees the team's forecast: won in full, the open one weighted; calls it and records a snapshot.
    await loginUi(m, lead.email);
    await m.goto('/sales/b2b');
    await m.getByTestId('pipeline-forecast').click();
    const owner = m.getByTestId('forecast-owner');
    await expect(owner).toHaveCount(1, { timeout: 60_000 });
    await expect(owner).toContainText('Ece Temsilci');
    const weighted = (4000 * open.probability / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    await expect(m.getByTestId('total-weighted')).toContainText(`${weighted} TRY`);
    await expect(m.getByTestId('forecast-opps')).toContainText('Depo genişletme');
    await expectNoSeriousA11y(m, 'forecast');
    await m.getByTestId('owner-adjust').click();
    await m.getByTestId('adjust-amount').fill('15000');
    await m.getByTestId('adjust-dialog').getByLabel('Gerekçe').fill('Ek sipariş bekleniyor');
    await expectNoSeriousA11y(m, 'adjust dialog');
    await m.getByTestId('adjust-save').click();
    await expect(m.getByTestId('owner-forecast')).toContainText('15.000,00 TRY', { timeout: 30_000 });
    await expect(owner).toContainText('Yönetici ayarı');
    await m.getByTestId('snapshot-take').click();
    await expect(m.getByTestId('snapshot-list').getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
    await expect(m.getByTestId('snapshot-list')).toContainText('15.000,00 TRY');

    // The rep sees their own figure with the Manager's call, but may not adjust it.
    await r.goto('/sales/b2b/forecast');
    await expect(r.getByTestId('owner-forecast')).toContainText('15.000,00 TRY', { timeout: 60_000 });
    await expect(r.getByTestId('owner-adjust')).toHaveCount(0);
    await expect(r.getByTestId('snapshot-take')).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('dokunulmamış fırsat uyarısı ve sonraki adım zorunluluğu', async ({ page }) => {
  const { admin, rep } = await setup('stale');
  const me = { token: rep.token };
  const opp = await api<{ id: string }>('POST', '/v1/opportunities', { ...me, body: { name: 'Unutulan fırsat', segment: 'b2b', amount: '500', currency: 'TRY' } });
  await backdateOpportunity(admin, opp.id, 9);

  // The Admin asks for a next step before a stage change.
  await loginUi(page, admin.email);
  await page.goto('/settings/pipelines');
  await page.getByTestId('rules-next').click();
  await page.getByTestId('rules-save').click();
  await page.getByRole('button', { name: 'Uygula' }).click();
  await expect(page.getByText('Aktivite kuralları kaydedildi.').first()).toBeVisible({ timeout: 30_000 });
  await expectNoSeriousA11y(page, 'activity rules');

  await page.goto(`/crm/opportunity/${opp.id}`);
  const panel = page.getByTestId('pulse-panel');
  await expect(panel).toContainText('9 gündür bu fırsatta işlem yok.', { timeout: 60_000 });
  await expect(panel).toContainText('Aşama değiştirmek için fırsata açık bir görev ekleyin.');
  await expectNoSeriousA11y(page, 'pulse');
  await page.goto('/sales/b2b/forecast');
  await expect(page.getByTestId('stale-list')).toContainText('Unutulan fırsat', { timeout: 60_000 });

  await expect(api('POST', `/v1/opportunities/${opp.id}/transition`, { ...me, body: { transitionKey: 'to_proposal' } })).rejects.toThrow(/422 .*NEXT_STEP_REQUIRED/);
  await api('POST', '/v1/tasks', { ...me, body: { title: 'Teklif sunumu', related: { type: 'opportunity', id: opp.id }, dueAt: '2099-01-01T09:00:00.000Z' } });
  await api('POST', `/v1/opportunities/${opp.id}/transition`, { ...me, body: { transitionKey: 'to_proposal' } });
  await page.goto(`/crm/opportunity/${opp.id}`);
  await expect(page.getByTestId('pulse-next')).toContainText('Teklif sunumu', { timeout: 60_000 });
  await expect(panel).not.toContainText('gündür bu fırsatta işlem yok');
});
