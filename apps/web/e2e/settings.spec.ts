import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P6c acceptance (docs/p6-plan.md §10): every settings screen works against the real API, with the keyboard,
// without serious accessibility violations, and only for those allowed to change configuration.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

interface Wf { id: string; resourceType: string; isDefault: boolean; version: number; statuses: { id: string; key: string }[] }

test('iş akışı editörü: durum ekle, kaldır, kayıtları eşleyerek taşı', async ({ page }) => {
  const ws = await createWorkspace('wf');
  const busy = await api<{ id: string }>('POST', '/v1/tasks', { token: ws.token, body: { title: 'Sürmekte olan iş' } });
  await api('POST', `/v1/tasks/${busy.id}/transition`, { token: ws.token, body: { transitionKey: 'start' } });
  const wf = (await api<{ data: Wf[] }>('GET', '/v1/workflows', { token: ws.token })).data.find((w) => w.resourceType === 'task' && w.isDefault);
  if (!wf) throw new Error('default workflow missing');
  await loginUi(page, ws.email);

  await page.getByTestId('nav-settings').click();
  await page.getByRole('link', { name: 'İş akışları' }).first().click();
  await page.getByRole('link', { name: 'Görev akışı' }).click();
  await expect(page.getByTestId('workflow-node')).toHaveCount(4);
  await expect(page.getByTestId('workflow-edge').first()).toBeAttached();
  await expectNoSeriousA11y(page, 'workflow editor');

  // Add "İncelemede", wire todo → İncelemede → done, remove "Devam ediyor".
  await page.getByTestId('wf-add-status').click();
  const newRow = page.getByTestId('wf-status-row').last();
  await newRow.getByLabel('Durum adı').fill('İncelemede');
  const doing = page.locator('[data-testid=wf-status-row][data-key=in_progress]');
  await doing.getByRole('button', { name: 'Devam ediyor durumunu kaldır' }).click();
  await expect(page.getByTestId('wf-problems')).toContainText('ulaşmıyor');

  await page.getByTestId('wf-add-transition').click();
  const t1 = page.getByTestId('wf-transition-row').last();
  await t1.getByLabel('Geçiş adı').fill('İncelemeye gönder');
  await t1.getByLabel('Nereden').click();
  await page.getByRole('option', { name: 'Yapılacak' }).click();
  await t1.getByLabel('Nereye').click();
  await page.getByRole('option', { name: 'İncelemede' }).click();
  await page.getByTestId('wf-add-transition').click();
  const t2 = page.getByTestId('wf-transition-row').last();
  await t2.getByLabel('Geçiş adı').fill('Onayla');
  await t2.getByLabel('Nereden').click();
  await page.getByRole('option', { name: 'İncelemede' }).click();
  await t2.getByLabel('Nereye').click();
  await page.getByRole('option', { name: 'Tamamlandı' }).click();
  await expect(page.getByTestId('wf-problems')).toHaveCount(0);

  // The removed status still holds a task: the editor asks where it goes.
  await page.getByTestId('wf-save').click();
  const mapping = page.getByTestId('wf-mapping');
  await expect(mapping).toContainText('1 kayıt');
  await mapping.getByRole('combobox').click();
  await page.getByRole('option', { name: 'İncelemede' }).click();
  await page.getByTestId('wf-map-confirm').click();
  await expect(page.getByText('Kaydedildi').first()).toBeVisible();

  await expect.poll(async () => (await api<{ status: { label: Record<string, string> } }>('GET', `/v1/tasks/${busy.id}`, { token: ws.token })).status.label.tr).toBe('İncelemede');
  const after = (await api<{ data: Wf[] }>('GET', '/v1/workflows', { token: ws.token })).data.find((w) => w.id === wf.id);
  expect(after?.version).toBe(wf.version + 1);
  expect(after?.statuses.map((s) => s.key)).not.toContain('in_progress');
});

test('özel alanlar: oluştur, seçenekleri düzenle, arşivle ve geri al', async ({ page }) => {
  const ws = await createWorkspace('cf');
  await loginUi(page, ws.email);
  await page.goto('/settings/fields');
  await expect(page.getByText('Bu kayıt türünde özel alan yok')).toBeVisible();
  await expectNoSeriousA11y(page, 'fields');

  await page.getByTestId('cf-new').click();
  const dialog = page.getByTestId('cf-dialog');
  await dialog.getByLabel('Alan adı').fill('Proje türü');
  await dialog.getByLabel('Tür').click();
  await page.getByRole('option', { name: 'Seçim', exact: true }).click();
  await dialog.getByRole('button', { name: 'Seçenek ekle' }).click();
  await dialog.getByLabel('1. seçenek').fill('İç proje');
  await dialog.getByRole('button', { name: 'Seçenek ekle' }).click();
  await dialog.getByLabel('2. seçenek').fill('Müşteri projesi');
  await expectNoSeriousA11y(page, 'field dialog');
  await dialog.getByTestId('cf-save').click();
  const row = page.locator('[data-testid=cf-row][data-key=cf_proje_turu]');
  await expect(row).toContainText('2 seçenek');

  await row.getByRole('button', { name: 'Proje türü alanını düzenle' }).click();
  await page.getByTestId('cf-dialog').getByLabel('1. seçenek').fill('Kurum içi');
  await page.getByTestId('cf-dialog').getByTestId('cf-save').click();
  await expect(page.getByTestId('cf-dialog')).toHaveCount(0);
  const fields = await api<{ data: { key: string; options: { id: string; label: { tr: string } }[]; version: number }[] }>('GET', '/v1/custom-fields?resourceType=task', { token: ws.token });
  expect(fields.data[0]).toMatchObject({ key: 'cf_proje_turu', version: 2, options: [{ id: 'ic_proje', label: { tr: 'Kurum içi' } }, { id: 'musteri_projesi' }] });

  await row.getByRole('button', { name: 'Proje türü alanını arşivle' }).click();
  await page.getByRole('button', { name: 'Geri al' }).click();
  await expect(row).toBeVisible();
});

test('rol ve izin matrisi: önizle, uygula, sürüme geri dön', async ({ page }) => {
  const ws = await createWorkspace('matrix');
  await loginUi(page, ws.email);
  await page.goto('/settings/roles');
  await expect(page.getByTestId('matrix')).toBeVisible();
  await expectNoSeriousA11y(page, 'matrix');

  // Two changes, each applied as its own version: v1 takes dashboards.customize, v2 takes audit.read from the manager.
  for (const [n, permission] of [[1, 'dashboards.customize'], [2, 'audit.read']] as const) {
    await page.getByLabel('İzin veya modül ara').fill(permission);
    await page.locator(`[data-testid=matrix-cell][data-role=manager][data-permission="${permission}"]`).click();
    await page.getByRole('combobox', { name: 'Kip', exact: true }).click();
    await page.getByRole('option', { name: 'Yok' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByText('1 değişiklik kaydedilmedi')).toBeVisible();
    await page.getByTestId('matrix-review').click();
    await expect(page.getByTestId('matrix-diff')).toContainText(permission);
    await page.getByTestId('matrix-apply').click();
    await expect(page.getByText(`Sürüm ${String(n)}`)).toBeVisible();
  }
  type M = { version: number; cells: { roleKey: string; permission: string; grant: unknown; overridden: boolean }[] };
  const managerCell = async (permission: string) => (await api<M>('GET', '/v1/authz/matrix', { token: ws.token })).cells.find((c) => c.roleKey === 'manager' && c.permission === permission);
  expect(await managerCell('audit.read')).toMatchObject({ grant: null, overridden: true });

  // Back to v1: the second change is gone, the first stays.
  await page.getByRole('button', { name: 'Sürüm geçmişi' }).click();
  await page.getByRole('button', { name: 'Bu sürüme dön' }).first().click();
  await expect.poll(async () => (await managerCell('audit.read'))?.overridden).toBe(false);
  expect(await managerCell('dashboards.customize')).toMatchObject({ grant: null, overridden: true });
});

test('otomasyon kural oluşturucu: tetikleyici, koşul ve eylem', async ({ page }) => {
  const ws = await createWorkspace('rule');
  await api('POST', '/v1/modules/automation_sla/enable', { token: ws.token });
  await loginUi(page, ws.email);
  await page.goto('/settings/automation');
  await expect(page.getByText('Henüz kural yok')).toBeVisible();
  await page.getByTestId('rule-new').click();

  await page.getByTestId('rule-name').fill('Acil işleri bildir');
  const step1 = page.getByTestId('rule-step-1');
  await step1.getByLabel('Tetikleyici').click();
  await page.getByRole('option', { name: 'Alan değiştiğinde' }).click();
  await expect(step1.getByRole('checkbox', { name: 'priority' })).toBeChecked();
  const filter = page.getByTestId('rule-step-2').getByTestId('filter-input');
  await filter.fill('priority >= 3');
  await filter.press('Enter');
  await expect(page.getByText('Koşul uygulanır.')).toBeVisible();
  const action = page.getByTestId('rule-action').first();
  await action.getByLabel('Mesaj').fill('Acil bir iş var');
  await expectNoSeriousA11y(page, 'rule builder');
  await page.getByTestId('rule-save').click();
  await expect(page).toHaveURL(/\/settings\/automation\/[0-9a-f-]{36}$/);

  const rules = await api<{ data: { name: string; enabled: boolean; definition: { trigger: { type: string; fields?: string[] }; condition: string; actions: { type: string; message?: string }[] } }[] }>('GET', '/v1/automations/rules', { token: ws.token });
  expect(rules.data[0]).toMatchObject({ name: 'Acil işleri bildir', enabled: true, definition: { trigger: { type: 'field_changed', fields: ['priority'] }, condition: 'priority >= 3', actions: [{ type: 'notify', message: 'Acil bir iş var' }] } });

  await page.goto('/settings/automation');
  await page.getByRole('switch', { name: 'Acil işleri bildir kuralını aç veya kapat' }).click();
  await expect.poll(async () => (await api<typeof rules>('GET', '/v1/automations/rules', { token: ws.token })).data[0]?.enabled).toBe(false);
});

test('entegrasyonlar ve SLA: webhook, API anahtarı, takvim ve politika', async ({ page }) => {
  const ws = await createWorkspace('int');
  for (const m of ['crm', 'automation_sla', 'api_webhooks']) await api('POST', `/v1/modules/${m}/enable`, { token: ws.token });
  await loginUi(page, ws.email);

  await page.goto('/settings/integrations');
  await page.getByTestId('webhook-new').click();
  const hook = page.getByTestId('webhook-dialog');
  await hook.getByLabel('Ad', { exact: true }).fill('ERP');
  await hook.getByLabel('Adres (URL)').fill('https://example.com/flexa-hook');
  await hook.getByRole('checkbox', { name: 'case.*' }).click();
  await expectNoSeriousA11y(page, 'webhook dialog');
  await hook.getByTestId('webhook-save').click();
  await expect(page.getByTestId('one-time-secret')).toContainText('whsec_');
  await page.getByRole('button', { name: 'Kaydettim' }).click();
  await expect(page.getByTestId('webhook-row')).toContainText('ERP');

  await page.getByTestId('key-new').click();
  await page.getByTestId('key-dialog').getByLabel('Ad', { exact: true }).fill('Raporlama');
  await page.getByTestId('key-dialog').getByTestId('key-save').click();
  await expect(page.getByTestId('one-time-secret')).not.toBeEmpty();
  await page.getByRole('button', { name: 'Kaydettim' }).click();
  await page.getByTestId('key-row').getByRole('button', { name: 'İptal et' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'İptal et' }).click();
  await expect(page.getByTestId('key-row')).toContainText('İptal edildi');
  await expectNoSeriousA11y(page, 'integrations');

  await page.goto('/settings/sla');
  await page.getByTestId('calendar-new').click();
  const cal = page.getByTestId('calendar-dialog');
  await cal.getByLabel('Takvim adı').fill('Mesai');
  await cal.getByRole('switch', { name: 'Cumartesi çalışma günü' }).click();
  await expectNoSeriousA11y(page, 'calendar dialog');
  await cal.getByTestId('calendar-save').click();
  await expect(page.getByTestId('calendar-row')).toContainText('Pzt Sal Çar Per Cum Cmt');

  await page.getByTestId('policy-new').click();
  const pol = page.getByTestId('policy-dialog');
  await pol.getByLabel('Politika adı').fill('Standart talep');
  await pol.getByLabel('Çözüm hedefi (dakika)').fill('240');
  await pol.getByTestId('policy-save').click();
  await expect(page.getByTestId('policy-row')).toContainText('4 sa');
  await page.getByRole('switch', { name: 'Standart talep politikasını aç veya kapat' }).click();
  await expect.poll(async () => (await api<{ data: { enabled: boolean; version: number }[] }>('GET', '/v1/sla/policies', { token: ws.token })).data[0]).toMatchObject({ enabled: false, version: 2 });
  await expectNoSeriousA11y(page, 'sla');
});

test('yönetici ayarları görür ama değiştiremez; temsilci ayarlara giremez', async ({ page, browser }) => {
  const ws = await createWorkspace('ro');
  const manager = await addMember(ws, 'manager', 'Mert Yönetici');
  const rep = await addMember(ws, 'sales_rep', 'Selin Temsilci');
  await loginUi(page, manager.email);
  await page.goto('/settings/workflows');
  await expect(page.getByText('değiştirmek için Admin yetkisi gerekir')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yeni görev iş akışı' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Görev akışı' }).click();
  await expect(page.getByTestId('workflow-diagram')).toBeVisible();
  await expect(page.getByTestId('wf-save')).toHaveCount(0);

  const ctx = await browser.newContext();
  try {
    const other = await ctx.newPage();
    await loginUi(other, rep.email);
    await expect(other.getByTestId('nav-settings')).toHaveCount(0);
    await other.goto('/settings/workflows');
    await expect(other.getByText('Bu ayarı görme yetkiniz yok')).toBeVisible();
  } finally {
    await ctx.close();
  }
});
