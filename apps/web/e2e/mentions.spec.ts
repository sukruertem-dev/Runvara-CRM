import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addMember, api, createWorkspace, loginUi } from './support/accounts';

// P8c acceptance (docs/p8-plan.md §13–16): the `@` picker with the keyboard, only people with access, comments,
// notes and descriptions, a separate live notification, renames, "mentioning grants access".

test.describe.configure({ timeout: 300_000 });

async function expectNoSeriousA11y(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(blocking.map((v) => `${label} ${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')})`)).toEqual([]);
}

async function setup(label: string) {
  const admin = await createWorkspace(label, 'Deniz Yönetici');
  const token = admin.token;
  await api('POST', '/v1/onboarding/skip', { token });
  await api('POST', '/v1/modules/crm/enable', { token });
  const ece = await addMember(admin, 'sales_rep', 'Ece Temsilci');
  const efe = await addMember(admin, 'sales_rep', 'Efe Yabancı');
  const acc = await api<{ id: string }>('POST', '/v1/accounts', { token, body: { name: 'Anadolu Lojistik', segments: ['b2b'], ownerUserId: ece.userId } });
  return { admin, ece, efe, acc };
}

test('anma: klavyeyle seç, yorum, not ve açıklama; anılana canlı ve ayrı bildirim', async ({ browser }) => {
  const { admin, ece, acc } = await setup('men');
  const [ca, cb] = [await browser.newContext(), await browser.newContext()];
  const [a, b] = [await ca.newPage(), await cb.newPage()];
  try {
    await loginUi(b, ece.email);
    await b.getByTestId('notification-bell').click();
    await expect(b.getByTestId('notification-item')).toHaveCount(1); // the account was assigned
    await b.keyboard.press('Escape');

    await loginUi(a, admin.email);
    await a.goto(`/crm/account/${acc.id}`);
    const comment = a.getByRole('textbox', { name: 'Yorum yazın…' });
    await comment.click();
    await comment.pressSequentially('Bakar mısın @e');
    const list = a.getByRole('listbox', { name: 'Anılabilecek kişiler ve ekipler' });
    await expect(list.getByRole('option')).toHaveText([/Ece Temsilci/]); // Efe cannot see the record
    await expectNoSeriousA11y(a, 'mention picker');
    await a.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await comment.pressSequentially('c');
    await expect(list).toBeHidden(); // dismissed for this mention
    for (let i = 0; i < 3; i += 1) await a.keyboard.press('Backspace');
    await comment.pressSequentially('@ece');
    await expect(list.getByRole('option')).toHaveCount(1);
    await a.keyboard.press('Enter');
    await expect(comment.locator('.mention')).toHaveText('@Ece Temsilci');
    await comment.pressSequentially('teşekkürler');
    await a.getByRole('button', { name: 'Yorum ekle' }).click();
    await expect(a.getByTestId('comments').getByTestId('mention')).toHaveText('@Ece Temsilci');

    // Live, and one notice per mention.
    await expect(b.getByTestId('notification-dot')).toBeVisible();
    await b.getByTestId('notification-bell').click();
    await b.getByRole('tab', { name: 'Anıldım' }).click();
    await expect(b.getByTestId('notification-item')).toHaveCount(1);

    await a.getByRole('tab', { name: 'Notlar' }).click();
    const note = a.getByRole('textbox', { name: /^Not yazın/ });
    await note.click();
    await note.pressSequentially('Arandı @ece');
    await expect(list.getByRole('option')).toHaveCount(1);
    await a.keyboard.press('Tab');
    await a.getByRole('button', { name: 'Not ekle' }).click();
    await expect(a.getByTestId('notes').getByTestId('mention')).toHaveText('@Ece Temsilci');
    await expectNoSeriousA11y(a, 'notes');

    const description = a.getByRole('textbox', { name: 'Açıklama' });
    await description.click();
    await description.pressSequentially('Sorumlu: @ece');
    await list.getByRole('option').first().click();
    await expect(description.locator('.mention')).toHaveText('@Ece Temsilci');
    await a.getByRole('heading', { level: 1 }).click();
    await expect(b.getByTestId('notification-item')).toHaveCount(3, { timeout: 30_000 });

    await a.reload();
    await expect(a.getByRole('textbox', { name: 'Açıklama' }).locator('.mention')).toHaveText('@Ece Temsilci', { timeout: 30_000 });
    // A private note offers nobody.
    await a.getByRole('tab', { name: 'Notlar' }).click();
    await a.getByRole('checkbox', { name: /^Yalnızca ben/ }).click();
    await a.getByRole('textbox', { name: /^Not yazın/ }).click();
    await a.getByRole('textbox', { name: /^Not yazın/ }).pressSequentially('@ece');
    await expect(list).toBeHidden();
  } finally {
    await ca.close();
    await cb.close();
  }
});

test('anınca erişim ver: kapalıyken listelenmez, açıkken işaretli listelenir ve kişi kaydı görür', async ({ page }) => {
  const { admin, efe, acc } = await setup('meg');
  await loginUi(page, admin.email);
  await page.goto('/settings/general');
  await page.getByTestId('mentions-grant').click();
  await page.getByTestId('general-save').click();
  await page.getByRole('button', { name: 'Uygula' }).click();
  await expect(page.getByTestId('general-save')).toBeDisabled({ timeout: 30_000 });
  await page.goto(`/crm/account/${acc.id}`);
  const comment = page.getByRole('textbox', { name: 'Yorum yazın…' });
  await comment.click();
  await comment.pressSequentially('@efe');
  const option = page.getByRole('option', { name: /Efe Yabancı/ });
  await expect(option).toContainText('Anılınca bu kaydı görebilecek');
  await option.click();
  await page.getByRole('button', { name: 'Yorum ekle' }).click();
  await expect(page.getByTestId('comments').getByTestId('mention')).toHaveText('@Efe Yabancı');
  expect((await api<{ id: string }>('GET', `/v1/accounts/${acc.id}`, { token: efe.token })).id).toBe(acc.id);
});
