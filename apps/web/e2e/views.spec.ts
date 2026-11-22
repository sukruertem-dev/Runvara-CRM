import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { api, createWorkspace, loginUi, type Workspace } from './support/accounts';

// P6b acceptance (docs/p6-plan.md §8): RQL filter bar with suggestions and saved/shareable views, calendar and
// Gantt with keyboard date changes and the critical path, CRM list + record page + pipeline, personal dashboard.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

interface TaskRow {
  id: string;
  title: string;
  version: number;
  dueAt: string | null;
  startAt: string | null;
}

const day = (offset: number, hour = 15): Date => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, hour, 0, 0);
};
const ymd = (d: Date): string => `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function task(ws: Workspace, body: Record<string, unknown>): Promise<TaskRow> {
  return api<TaskRow>('POST', '/v1/tasks', { token: ws.token, body });
}

test('RQL filtre çubuğu, öneriler, kayıtlı ve paylaşılabilir görünüm', async ({ page, browser }) => {
  const ws = await createWorkspace('rql');
  for (const [title, priority] of [['Acil sözleşme', 4], ['Yüksek teklif', 3], ['Düşük not', 1]] as const) await task(ws, { title, priority });
  await loginUi(page, ws.email);
  await page.goto('/tasks');
  await expect(page.getByTestId('task-row')).toHaveCount(3);

  const input = page.getByTestId('filter-input');
  await input.click();
  await input.fill('prio');
  await expect(page.getByRole('option', { name: /^priority/ })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(input).toHaveValue('priority ');
  await page.keyboard.type('>= 3');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('task-row')).toHaveCount(2);
  await expect(page).toHaveURL(/rql=priority/);

  // An invalid query is reported with its position and is not applied.
  await input.fill('priority >');
  await expect(page.getByText(/karakterde/)).toBeVisible();
  await expect(page.getByTestId('task-row')).toHaveCount(2);
  await input.fill('priority >= 3');

  await expectNoSeriousA11y(page, 'filter');

  await page.getByTestId('views-menu').click();
  await page.getByRole('menuitem', { name: 'Bu görünümü kaydet…' }).click();
  await page.getByLabel('Görünüm adı').fill('Önemli işler');
  await page.getByRole('button', { name: 'Kaydet' }).click();
  await expect(page).toHaveURL(/sv=/);
  await expect(page.getByTestId('views-menu')).toContainText('Önemli işler');

  // The URL is the shareable link: a fresh session of the same user sees the same filtered view.
  const url = page.url();
  const ctx = await browser.newContext();
  try {
    const other = await ctx.newPage();
    await loginUi(other, ws.email);
    await other.goto(url);
    await expect(other.getByTestId('task-row')).toHaveCount(2);
    await expect(other.getByTestId('filter-input')).toHaveValue('priority >= 3');
  } finally {
    await ctx.close();
  }
  const views = await api<{ data: { name: string; query: string }[] }>('GET', '/v1/views?resource=task', { token: ws.token });
  expect(views.data).toEqual([expect.objectContaining({ name: 'Önemli işler', query: 'priority >= 3' })]);
});

test('takvim ve Gantt: klavyeyle tarih değiştirme, bağımlılıklar ve kritik yol', async ({ page }) => {
  const ws = await createWorkspace('cal');
  const a = await task(ws, { title: 'Tasarım', startAt: day(0, 9).toISOString(), dueAt: day(1).toISOString() });
  const b = await task(ws, { title: 'Geliştirme', startAt: day(2, 9).toISOString(), dueAt: day(5).toISOString() });
  await task(ws, { title: 'Bağımsız iş', startAt: day(1, 9).toISOString(), dueAt: day(1).toISOString() });
  await api('POST', `/v1/tasks/${b.id}/dependencies`, { token: ws.token, body: { blockerId: a.id } });
  await loginUi(page, ws.email);

  // Calendar: Space lifts, → moves one day, Space drops; the due date moves by one day at the same hour.
  await page.goto('/tasks?view=calendar');
  const chip = page.locator(`[data-testid=calendar-chip][data-task-id="${a.id}"]`);
  await expect(page.locator(`[data-day="${ymd(day(1))}"]`).getByText('Tasarım')).toBeVisible();
  await expectNoSeriousA11y(page, 'calendar');
  await chip.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[aria-live]').filter({ hasText: 'Tasarım' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[aria-live]').filter({ hasText: /Tasarım .* taşındı/ })).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator(`[data-day="${ymd(day(2))}"]`).getByText('Tasarım')).toBeVisible();
  await expect
    .poll(async () => new Date((await api<TaskRow>('GET', `/v1/tasks/${a.id}`, { token: ws.token })).dueAt ?? 0).getTime())
    .toBe(day(2).getTime());

  // Gantt: bars, the dependency arrow on the critical path, keyboard shift by one day.
  await page.goto('/tasks?view=gantt');
  await expect(page.getByTestId('gantt-bar')).toHaveCount(3);
  await expect(page.getByTestId('critical-edge')).toHaveCount(1);
  await expect(page.locator(`[data-testid=gantt-bar][data-task-id="${b.id}"]`)).toHaveAttribute('data-critical', 'true');
  await expectNoSeriousA11y(page, 'gantt');
  const before = await api<TaskRow>('GET', `/v1/tasks/${b.id}`, { token: ws.token });
  await page.locator(`[data-testid=gantt-bar][data-task-id="${b.id}"]`).focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => {
      const now = await api<TaskRow>('GET', `/v1/tasks/${b.id}`, { token: ws.token });
      return [ymd(new Date(now.startAt ?? '')), ymd(new Date(now.dueAt ?? ''))];
    })
    .toEqual([ymd(new Date(new Date(before.startAt ?? '').getTime() + 86_400_000)), ymd(new Date(new Date(before.dueAt ?? '').getTime() + 86_400_000))]);
});

test('CRM: liste, kayıt sayfası ve pipeline', async ({ page }) => {
  const ws = await createWorkspace('crm');
  await api('POST', '/v1/modules/crm/enable', { token: ws.token });
  const acc = await api<{ id: string }>('POST', '/v1/accounts', { token: ws.token, body: { name: 'Atlas Lojistik', segments: ['b2b'] } });
  await api('POST', '/v1/contacts', { token: ws.token, body: { firstName: 'Elif', lastName: 'Kara', segments: ['b2b'], account: { id: acc.id } } });
  const opp = await api<{ id: string; status: { key: string } }>('POST', '/v1/opportunities', { token: ws.token, body: { name: 'Filo sözleşmesi', segment: 'b2b', amount: '125000', accountId: acc.id } });
  await loginUi(page, ws.email);

  await page.goto('/crm');
  await expect(page.getByTestId('crm-row')).toHaveCount(1);
  await expectNoSeriousA11y(page, 'crm list');
  await page.getByRole('link', { name: 'Atlas Lojistik' }).click();
  await expect(page.getByTestId('crm-title')).toHaveText('Atlas Lojistik');
  await expect(page.getByTestId('crm-related').getByRole('link', { name: 'Elif Kara' })).toBeVisible();
  await expect(page.getByTestId('crm-related').getByRole('link', { name: /Filo sözleşmesi/ })).toBeVisible();
  const industry = page.getByTestId('field-industry');
  await industry.fill('Lojistik');
  await industry.press('Enter');
  await expect.poll(async () => (await api<{ industry: string | null }>('GET', `/v1/accounts/${acc.id}`, { token: ws.token })).industry).toBe('Lojistik');
  await expectNoSeriousA11y(page, 'crm detail');

  // Pipeline: stage totals from the API; Space + → + Space moves the opportunity to the next stage.
  await page.goto('/crm?type=opportunity&view=pipeline');
  const first = page.getByTestId('pipeline-stage').first();
  await expect(first.getByTestId('stage-total')).toContainText('125.000');
  await expectNoSeriousA11y(page, 'pipeline');
  await page.locator(`[data-testid=pipeline-card][data-id="${opp.id}"]`).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[aria-live]').filter({ hasText: 'Filo sözleşmesi' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[aria-live]').filter({ hasText: /taşındı/ })).toBeVisible();
  await page.keyboard.press('Space');
  await expect.poll(async () => (await api<{ status: { key: string } }>('GET', `/v1/opportunities/${opp.id}`, { token: ws.token })).status.key).not.toBe(opp.status.key);
});

test('gösterge paneli: gerçek sayılar, düzenleme ve kalıcı yerleşim', async ({ page }) => {
  const ws = await createWorkspace('dash');
  await task(ws, { title: 'Açık 1', assigneeUserId: ws.userId });
  await task(ws, { title: 'Gecikmiş', dueAt: day(-2).toISOString() });
  await loginUi(page, ws.email);
  await expect(page.getByTestId('dashboard')).toBeVisible();
  await expect(page.getByTestId('kpi-open')).toHaveText('2');
  await expect(page.getByTestId('kpi-mine')).toHaveText('1');
  await expect(page.getByTestId('kpi-overdue')).toHaveText('1');
  await expectNoSeriousA11y(page, 'dashboard');

  await page.getByTestId('dash-edit').click();
  const before = await page.getByTestId('widget').count();
  await page.getByRole('button', { name: 'Önceliğe göre açık görevler bileşenini kaldır' }).click();
  await page.getByRole('button', { name: 'Duruma göre görevler genişliğini artır' }).click();
  await page.getByTestId('dash-done').click();
  await expect(page.getByTestId('widget')).toHaveCount(before - 1);
  await page.reload();
  await expect(page.getByTestId('widget')).toHaveCount(before - 1);
  await expect(page.locator('[data-testid=widget][data-kind=tasks_by_status]')).toHaveAttribute('data-w', '7');
});
