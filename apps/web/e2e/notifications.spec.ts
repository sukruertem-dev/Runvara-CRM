import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P8d acceptance (docs/p8-plan.md §17–21): live toast, deep links that focus the place, stable record links, quiet
// on this device, catching up after a lost connection, read state on two devices, personal settings.

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

const mention = (id: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bakar mısın ' }, { type: 'mention', attrs: { kind: 'user', id } }] }] });

async function setup(label: string) {
  const admin = await createWorkspace(label, 'Deniz Yönetici');
  await api('POST', '/v1/onboarding/skip', { token: admin.token });
  await api('POST', '/v1/modules/crm/enable', { token: admin.token });
  const ece = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  const acc = await api<{ id: string }>('POST', '/v1/accounts', { token: admin.token, body: { name: 'Anadolu Lojistik', segments: ['b2b'], ownerUserId: ece.userId } });
  const say = () => api<{ id: string }>('POST', `/v1/accounts/${acc.id}/comments`, { token: admin.token, body: { body: mention(ece.userId) } });
  return { admin, ece, acc, say };
}

test('derin bağlantı: uyarıdan ve zilden yoruma, nota odaklanır; okundu bilgisi ikinci cihaza yansır', async ({ browser }) => {
  const { admin, ece, acc, say } = await setup('dl');
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const [one, two] = await Promise.all(contexts.map((c) => c.newPage()));
  if (!one || !two) throw new Error('no page');
  try {
    await loginUi(one, ece.email);
    await loginUi(two, ece.email);
    await expect(two.getByTestId('notification-dot')).toBeVisible(); // the assignment
    const cm = await say();
    // Said once on screen; its action leads to the comment itself.
    await one.getByRole('button', { name: 'Aç', exact: true }).first().click({ timeout: 30_000 });
    await expect(one).toHaveURL(new RegExp(`/crm/account/${acc.id}#comment-${cm.id}$`), { timeout: 60_000 });
    await expect(one.locator(`#comment-${cm.id}`)).toBeFocused({ timeout: 30_000 });

    // Read on one device: the other shows only the assignment as unread.
    await two.getByTestId('notification-bell').click();
    await expect(two.getByTestId('notification-item')).toHaveCount(2);
    await expect(two.getByRole('img', { name: 'Yeni bildirim' })).toHaveCount(1, { timeout: 30_000 });
    await expectNoSeriousA11y(two, 'notification centre');

    // A note opens its tab and takes the focus; the stable record address works from anywhere.
    const note = await api<{ id: string }>('POST', '/v1/notes', { token: admin.token, body: { related: { type: 'account', id: acc.id }, bodyText: 'Bakar mısın', body: mention(ece.userId) } });
    await two.goto(`/r/account/${acc.id}#note-${note.id}`);
    await expect(two).toHaveURL(new RegExp(`/crm/account/${acc.id}#note-${note.id}$`), { timeout: 60_000 });
    await expect(two.locator(`#note-${note.id}`)).toBeFocused({ timeout: 30_000 });
    const list = await api<{ data: { id: string; source: { type: string } | null }[] }>('GET', '/v1/notifications', { token: ece.token });
    const n = list.data.find((x) => x.source?.type === 'note');
    await two.goto(`/n/${n?.id ?? ''}`);
    await expect(two).toHaveURL(new RegExp(`#note-${note.id}$`), { timeout: 60_000 });
    await two.goto('/n/00000000-0000-4000-8000-000000000000');
    await expect(two.getByText('Bu bildirim açılamıyor')).toBeVisible({ timeout: 30_000 });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('kopan bağlantı: yeniden bağlanınca kaçırılan bildirim gelir; ekran uyarısı kapalıyken yalnızca rozet', async ({ browser }) => {
  const { ece, say } = await setup('rc');
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await loginUi(page, ece.email);
    await page.getByTestId('notification-bell').click();
    await page.getByRole('button', { name: 'Tümünü okundu say' }).click();
    await expect(page.getByTestId('notification-dot')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await ctx.setOffline(true);
    await say();
    await ctx.setOffline(false);
    await expect(page.getByTestId('notification-dot')).toBeVisible({ timeout: 60_000 });

    await page.goto('/settings/notifications');
    await page.getByTestId('dnd').click();
    await say();
    await page.getByTestId('notification-bell').click();
    await expect(page.getByTestId('notification-item')).toHaveCount(3, { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Aç', exact: true })).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test('bildirim ayarları: kanallar, rahatsız etme saatleri ve bu cihaz; herkes kendi ayarını değiştirir', async ({ page }) => {
  const { ece } = await setup('ns');
  await loginUi(page, ece.email);
  await page.goto('/settings/notifications');
  const box = page.getByRole('checkbox', { name: 'Anılma: E-posta' });
  await expect(box).toBeVisible({ timeout: 60_000 });
  await box.click();
  await page.getByTestId('channels-save').click();
  await expect(page.getByTestId('channels-save')).toBeDisabled();
  await page.getByRole('switch', { name: 'Rahatsız etme saatlerini kullan' }).click();
  await page.getByLabel('Başlangıç').fill('21:30');
  await page.getByTestId('quiet-save').click();
  await expect(page.getByTestId('quiet-save')).toBeDisabled();
  await expect(page.getByTestId('push-device')).not.toContainText('Yükleniyor');
  await expectNoSeriousA11y(page, 'notification settings');
  await page.reload();
  await expect(box).toBeChecked({ timeout: 30_000 });
  await expect(page.getByLabel('Başlangıç')).toHaveValue('21:30');
  const prefs = await api<{ data: { kind: string; channels: string[] }[] }>('GET', '/v1/notifications/preferences', { token: ece.token });
  expect(prefs.data.find((x) => x.kind === 'mention')?.channels.sort()).toEqual(['email', 'in_app']);
});
