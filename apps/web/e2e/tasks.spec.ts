import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi, seedTasksSql, type Workspace } from './support/accounts';

// P6a acceptance (docs/p6-plan.md §6): module- and role-aware shell, keyboard-only task flow, optimistic
// Kanban (< 100 ms), virtualised 10 000-row list, dark theme and mobile layout, no serious axe violations.

// Each test walks several pages; a dev server compiles each on first visit.
test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

async function createTasks(ws: Workspace, titles: string[]): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = [];
  for (const title of titles) out.push(await api<{ id: string; title: string }>('POST', '/v1/tasks', { token: ws.token, body: { title } }));
  return out;
}

test('kabuk: menü modüle ve role göre; komut paleti klavyeyle gezinir', async ({ browser }) => {
  const admin = await createWorkspace('shell');
  const rep = await addMember(admin, 'sales_rep', 'Selin Temsilci');

  const adminCtx = await browser.newContext();
  const repCtx = await browser.newContext();
  try {
    const page = await adminCtx.newPage();
    await loginUi(page, admin.email);
    await expect(page.getByTestId('tenant-heading')).toHaveText(admin.tenantName);
    const nav = page.getByRole('navigation', { name: 'Ana menü' });
    await expect(nav.getByRole('link', { name: 'Görevler' })).toBeVisible();
    // Modules that are off never reach the menu.
    await expect(nav.getByRole('link', { name: 'Müşteriler' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Davetler' })).toBeVisible();
    await expectNoSeriousA11y(page, 'home');

    // Turning the CRM module on adds its entry (server-decided navigation).
    await api('POST', '/v1/modules/crm/enable', { token: admin.token });
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Müşteriler' })).toBeVisible();

    // Ctrl+K → type → Enter navigates.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Komut paleti' });
    await expect(palette).toBeVisible();
    await expectNoSeriousA11y(page, 'palette');
    await page.keyboard.type('Görevler');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/tasks$/);

    const repPage = await repCtx.newPage();
    await loginUi(repPage, rep.email);
    await expect(repPage.getByRole('navigation', { name: 'Ana menü' }).getByRole('link', { name: 'Görevler' })).toBeVisible();
    // Admin-only settings are not shown to a sales rep.
    await expect(repPage.getByRole('link', { name: 'Davetler' })).toHaveCount(0);
    await expect(repPage.getByRole('link', { name: 'Modül yönetimi' })).toHaveCount(0);
  } finally {
    await adminCtx.close();
    await repCtx.close();
  }
});

test('görev akışı yalnızca klavyeyle: oluştur → Kanban’da taşı (iyimser) → detayda düzenle → sil ve geri al', async ({ page }) => {
  const admin = await createWorkspace('flow');
  await createTasks(admin, ['Sözleşmeyi incele', 'Demo planla']);
  await loginUi(page, admin.email);
  await page.goto('/tasks');
  await expect(page.getByTestId('task-row')).toHaveCount(2);
  await expectNoSeriousA11y(page, 'list');

  // C → new task dialog, type, Enter.
  await page.locator('body').press('c');
  const dialog = page.getByRole('dialog', { name: 'Yeni görev' });
  await expect(dialog).toBeVisible();
  await page.keyboard.type('Teklifi gönder');
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('task-row').filter({ hasText: 'Teklifi gönder' })).toBeVisible();

  // Board: the drop updates the UI before the server answers (the move request is held for 1.5 s).
  await page.locator('body').press('2');
  await expect(page.getByTestId('task-board')).toBeVisible();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/tasks/*/move', async (route) => {
    await held;
    await route.continue();
  });
  const card = page.locator('[data-testid=board-column][data-status-key=todo] [data-testid=board-card]').filter({ hasText: 'Teklifi gönder' });
  const announcer = page.locator('[aria-live]').filter({ hasText: 'Teklifi gönder şimdi' });
  await card.focus();
  await page.keyboard.press('Space');
  // dnd-kit binds the arrow keys right after the lift; wait for its announcement like a screen-reader user would.
  await expect(announcer).toContainText('Yapılacak');
  await page.keyboard.press('ArrowRight');
  await expect(announcer).toContainText('Devam ediyor');
  // Time from the browser receiving the dropping Space key to the card rendering in the new column.
  await page.evaluate((title) => {
    const w = window as unknown as { __t0?: number; __elapsed?: number };
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') w.__t0 = performance.now();
    }, { capture: true, once: true });
    const obs = new MutationObserver(() => {
      const moved = [...document.querySelectorAll('[data-testid=board-column][data-status-key=in_progress] [data-testid=board-card]')].some((n) => n.textContent.includes(title));
      if (moved && w.__t0 !== undefined) {
        w.__elapsed = performance.now() - w.__t0;
        obs.disconnect();
      }
    });
    obs.observe(document.body, { subtree: true, childList: true });
  }, 'Teklifi gönder');
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __elapsed?: number }).__elapsed ?? null)).not.toBeNull();
  const elapsed = (await page.evaluate(() => (window as unknown as { __elapsed?: number }).__elapsed)) ?? Infinity;
  expect(elapsed).toBeLessThan(100);
  release();
  await expect(page.locator('[data-testid=board-column][data-status-key=in_progress] [data-testid=board-card]').filter({ hasText: 'Teklifi gönder' })).toBeVisible();
  await page.unroute('**/api/v1/tasks/*/move');
  await expectNoSeriousA11y(page, 'board');

  // The move persisted on the server.
  const listed = await api<{ data: { id: string; title: string; status: { key: string } }[] }>('GET', `/v1/tasks?q=${encodeURIComponent('title = "Teklifi gönder"')}`, { token: admin.token });
  expect(listed.data[0]?.status.key).toBe('in_progress');
  const id = listed.data[0]!.id;

  // Enter on the focused card opens the detail page; edit the title from the keyboard.
  await page.locator(`[data-task-id="${id}"]`).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/tasks/${id}$`));
  const title = page.getByTestId('task-detail-title');
  await title.focus();
  await title.fill('Teklifi bugün gönder');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await api<{ title: string }>('GET', `/v1/tasks/${id}`, { token: admin.token })).title).toBe('Teklifi bugün gönder');
  await expectNoSeriousA11y(page, 'detail');

  // Delete → undo restores it.
  await page.getByRole('button', { name: 'Sil' }).click();
  await page.getByRole('dialog', { name: 'Görev silinsin mi?' }).getByRole('button', { name: 'Sil' }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.getByRole('button', { name: 'Geri al' }).click();
  // 404 while the restore is still committing counts as "not yet".
  await expect
    .poll(async () => api<{ deletedAt: string | null }>('GET', `/v1/tasks/${id}`, { token: admin.token }).then((x) => x.deletedAt ?? 'restored', () => 'deleted'))
    .toBe('restored');
});

test('başka kullanıcının değişikliği ekrana yansır', async ({ page }) => {
  const admin = await createWorkspace('live');
  const rep = await addMember(admin, 'sales_rep', 'Selin Temsilci');
  // The rep owns the task, so the rep may edit it; the admin (all scope) watches it.
  const task = await api<{ id: string }>('POST', '/v1/tasks', { token: admin.token, body: { title: 'Canlı görev', owner: { type: 'user', id: rep.userId } } });
  await loginUi(page, admin.email);
  await page.goto(`/tasks/${task.id}`);
  await expect(page.getByTestId('task-detail-title')).toHaveValue('Canlı görev');
  const v = await api<{ version: number }>('GET', `/v1/tasks/${task.id}`, { token: rep.token });
  await api('PATCH', `/v1/tasks/${task.id}`, { token: rep.token, ifMatch: v.version, body: { title: 'Temsilci güncelledi' } });
  await expect(page.getByText('Bu görev başka bir kullanıcı tarafından güncellendi.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('task-detail-title')).toHaveValue('Temsilci güncelledi');
});

test('10 000 görevlik liste sanal kaydırılır', async ({ page }) => {
  test.setTimeout(900_000);
  const admin = await createWorkspace('big');
  await seedTasksSql(admin, 10_000);
  await loginUi(page, admin.email);
  await page.goto('/tasks');
  await expect(page.getByTestId('task-count')).toHaveText('10.000 görev', { timeout: 30_000 });
  const list = page.getByTestId('task-list');
  for (let i = 0; i < 6; i++) {
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
  }
  // Pages keep loading while only the visible window of rows is in the DOM.
  const loaded = await list.evaluate((el) => Number(el.getAttribute('data-count')));
  expect(loaded).toBeGreaterThan(400);
  expect(await page.getByTestId('task-row').count()).toBeLessThan(80);
});

test('koyu tema ve mobil görünümde taşma yok', async ({ page }) => {
  const admin = await createWorkspace('theme');
  await createTasks(admin, ['Uzun başlıklı bir görev: müşteriyle sözleşme yenileme ve fiyat görüşmesi', 'Kısa görev']);
  await loginUi(page, admin.email);
  await page.getByRole('button', { name: /^Kullanıcı menüsü/ }).click();
  await page.getByRole('menuitemradio', { name: 'Koyu' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Every full load rotates the refresh cookie; navigating away mid-rotation would drop it (assumptions B52).
  await expect(page.getByTestId('sidebar')).toBeAttached();
  await page.goto('/tasks');
  await expect(page.getByTestId('sidebar')).toBeAttached();
  await expectNoSeriousA11y(page, 'dark list');

  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/', '/tasks', '/tasks?view=board', '/tasks?view=table']) {
    await page.goto(path);
    await expect(page.getByTestId('sidebar')).toBeAttached();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(0);
  }
  // The sidebar becomes a drawer on phones.
  await page.getByRole('button', { name: 'Menüyü aç' }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: 'Görevler' })).toBeVisible();
});
