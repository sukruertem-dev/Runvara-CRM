import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P8b acceptance (docs/p8-plan.md §7–12): discount request → the right approver → decision; rules and limits;
// targets with attainment.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

async function setup(label: string) {
  const admin = await createWorkspace(label, 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: admin.token });
  for (const m of ['crm', 'sales_b2b', 'sales_tracking']) await api('POST', `/v1/modules/${m}/enable`, { token: admin.token });
  const team = await api<{ id: string }>('POST', '/v1/teams', { token: admin.token, body: { name: 'Saha' } });
  const lead = await addMember(admin, 'manager', 'Mert Lider');
  const rep = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  await api('PUT', `/v1/teams/${team.id}/members/${lead.userId}`, { token: admin.token, body: { role: 'manager' } });
  await api('PUT', `/v1/teams/${team.id}/members/${rep.userId}`, { token: admin.token, body: {} });
  return { admin, lead, rep };
}

test('iskonto onayı: talep → ekip yöneticisi → karar; kural ve kişiye özel limit', async ({ browser }) => {
  const { admin, lead, rep } = await setup('appr');
  const opp = await api<{ id: string }>('POST', '/v1/opportunities', { token: rep.token, body: { name: 'Filo anlaşması', segment: 'b2b', amount: '1000', currency: 'TRY' } });
  const pages = await Promise.all([1, 2, 3].map(async () => (await browser.newContext()).newPage()));
  const [a, l, r] = pages as [Page, Page, Page];
  try {
    // The Admin lowers the free discount and raises the lead's own limit.
    await loginUi(a, admin.email);
    await a.goto('/settings/approvals');
    await a.getByTestId('apol-freePercent').fill('5');
    await a.getByTestId('apol-save').click();
    await a.getByRole('button', { name: 'Uygula' }).click();
    await expect(a.getByText('Onay kuralları kaydedildi.').first()).toBeVisible({ timeout: 30_000 });
    await a.getByLabel('Limit (%): Mert Lider').fill('25');
    await a.getByRole('button', { name: 'Kaydet: Mert Lider' }).click();
    await expect(a.getByRole('button', { name: 'Kaydet: Mert Lider' })).toBeDisabled();
    await expectNoSeriousA11y(a, 'approval rules');

    await loginUi(r, rep.email);
    await r.goto(`/crm/opportunity/${opp.id}`);
    await r.getByTestId('discount-ask').click();
    await r.getByTestId('discount-dialog').getByLabel('İskonto (%)').fill('20');
    await r.getByTestId('discount-dialog').getByLabel('Gerekçe').fill('Rakip teklifi');
    await expectNoSeriousA11y(r, 'discount dialog');
    await r.getByTestId('discount-save').click();
    await expect(r.getByTestId('discount-panel')).toContainText('Mert Lider');

    await loginUi(l, lead.email);
    await l.getByTestId('nav-approvals').click();
    const row = l.getByTestId('approval-row');
    await expect(row).toContainText('%20 iskonto · Filo anlaşması', { timeout: 60_000 });
    await row.getByText('Geçmiş').click();
    await expect(row).toContainText('Atandı → Mert Lider');
    await expectNoSeriousA11y(l, 'approval inbox');
    await l.getByRole('button', { name: 'Onayla: Filo anlaşması' }).click();
    await l.getByTestId('decision-dialog').getByLabel('Not (isteğe bağlı)').fill('Uygun');
    await l.getByTestId('decision-save').click();
    await expect(l.getByText('Talep yok')).toBeVisible();

    // The requester's open page follows the decision over the stream.
    await expect(r.getByTestId('discount-panel')).toContainText('Onaylı iskonto: %20', { timeout: 30_000 });
    await r.goto('/approvals');
    await r.getByRole('tab', { name: 'Taleplerim' }).click();
    await expect(r.getByTestId('approval-row')).toContainText('Onaylandı');
    await expect(r.getByTestId('approval-row')).toContainText('Mert Lider: Uygun');
    await expect(r.getByRole('button', { name: /^Onayla:/ })).toHaveCount(0);

    // Above the lead's limit it goes to the Admins; a pending request can be withdrawn.
    await r.goto(`/crm/opportunity/${opp.id}`);
    await r.getByTestId('discount-ask').click();
    await r.getByTestId('discount-dialog').getByLabel('İskonto (%)').fill('40');
    await r.getByTestId('discount-dialog').getByLabel('Gerekçe').fill('Stratejik müşteri');
    await r.getByTestId('discount-save').click();
    await expect(r.getByTestId('discount-panel')).toContainText('herhangi bir Admin');
    await a.goto('/approvals');
    await a.getByRole('checkbox', { name: 'Seç: Filo anlaşması' }).click();
    await a.getByTestId('approval-bulk').getByRole('button', { name: 'Reddet' }).click();
    await a.getByTestId('decision-save').click();
    await expect(a.getByText('Talep yok')).toBeVisible();
    await expect(r.getByTestId('discount-ask')).toBeVisible({ timeout: 30_000 });
  } finally {
    await Promise.all(pages.map((p) => p.context().close()));
  }
});

test('hedefler: Yönetici ekibindekine hedef verir, temsilci yalnızca kendininkini görür', async ({ browser }) => {
  const { lead, rep } = await setup('tgt');
  const pages = await Promise.all([1, 2].map(async () => (await browser.newContext()).newPage()));
  const [l, r] = pages as [Page, Page];
  try {
    await loginUi(l, lead.email);
    await l.getByTestId('nav-targets').click();
    await expect(l.getByText('Bu dönem için hedef yok')).toBeVisible({ timeout: 60_000 });
    for (const [metric, value] of [['Kapatılan görev', '4'], ['Kazanılan fırsat', '2']] as const) {
      await l.getByTestId('target-add').click();
      const d = l.getByTestId('target-dialog');
      await d.getByRole('combobox', { name: 'Kişi', exact: true }).click();
      await l.getByRole('option', { name: 'Ece Temsilci' }).click();
      await d.getByRole('combobox', { name: 'Ölçü' }).click();
      await l.getByRole('option', { name: metric }).click();
      await d.getByLabel('Hedef değer').fill(value);
      await expectNoSeriousA11y(l, 'target dialog');
      await l.getByTestId('target-save').click();
      await expect(d).toBeHidden();
    }
    await expect(l.getByTestId('target-card')).toHaveCount(2);
    await expect(l.getByTestId('target-card').filter({ hasText: 'Kapatılan görev' })).toContainText('0 / 4');
    await expectNoSeriousA11y(l, 'targets');
    await l.getByRole('button', { name: 'Hedefi değiştir: Ece Temsilci: Kapatılan görev' }).click();
    await l.getByRole('dialog').getByLabel('Hedef değer').fill('5');
    await l.getByRole('dialog').getByRole('button', { name: 'Kaydet' }).click();
    await expect(l.getByTestId('target-list')).toContainText('0 / 5');
    await l.getByRole('button', { name: 'Hedefi sil: Ece Temsilci: Kazanılan fırsat' }).click();
    await l.getByRole('dialog').getByRole('button', { name: 'Sil', exact: true }).click();
    await expect(l.getByTestId('target-card')).toHaveCount(1);

    await loginUi(r, rep.email);
    await r.goto('/targets');
    await expect(r.getByTestId('target-card')).toHaveCount(1, { timeout: 60_000 });
    await expect(r.getByTestId('target-add')).toHaveCount(0);
    await expect(r.getByRole('button', { name: /^Hedefi değiştir/ })).toHaveCount(0);
  } finally {
    await Promise.all(pages.map((p) => p.context().close()));
  }
});
