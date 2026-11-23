import { expect, test, type Page } from '@playwright/test';
import { api, createWorkspace, loginUi, type Workspace } from './support/accounts';

// Screenshot regression (prompt Faz 6 acceptance: "açık/koyu tema ve mobil görünümde görsel bozulma yok").
// Runs only in the `visual` project, inside the pinned Playwright Linux image (scripts/e2e-visual.mjs) so that
// fonts and rendering match the committed baselines in CI and on every machine.

test.describe.configure({ mode: 'serial', timeout: 300_000 });

const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 375, height: 812 } } as const;
const THEMES = ['light', 'dark'] as const;

let ws: Workspace;
let workflowId = '';

test.beforeAll(async () => {
  ws = await createWorkspace('visual', 'Deniz Yönetici', 'Atlas Lojistik');
  // The dashboard baseline shows a workspace that is already set up (no onboarding card).
  await api('POST', '/v1/onboarding/skip', { token: ws.token });
  for (const [title, priority] of [['Teklif hazırla', 4], ['Sözleşme taslağını incele', 3], ['Müşteri toplantısı notları', 2], ['Fatura kontrolü', 1]] as const) {
    await api('POST', '/v1/tasks', { token: ws.token, body: { title, priority } });
  }
  const wfs = await api<{ data: { id: string; resourceType: string; isDefault: boolean }[] }>('GET', '/v1/workflows', { token: ws.token });
  workflowId = wfs.data.find((w) => w.resourceType === 'task' && w.isDefault)?.id ?? '';
});

/**
 * Waits for the page load and the web fonts. "networkidle" never comes (the live stream stays open);
 * toHaveScreenshot itself then waits until two consecutive frames match.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function shoot(page: Page, name: string): Promise<void> {
  await settle(page);
  // The workspace address is unique per run (sign-up needs a free slug).
  await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.01, mask: [page.getByTestId('tenant-slug')] });
}

for (const [vp, size] of Object.entries(VIEWPORTS)) {
  for (const theme of THEMES) {
    test(`${vp} ${theme}`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });

      await page.goto('/login');
      await expect(page.getByRole('button', { name: 'Giriş yap' })).toBeVisible();
      await shoot(page, `login-${vp}-${theme}`);

      // loginUi waits for the desktop sidebar; on phones it is a drawer, so log in wide and then narrow down.
      await page.setViewportSize(VIEWPORTS.desktop);
      await loginUi(page, ws.email);
      await page.setViewportSize(size);
      await expect(page.getByTestId('kpi-open')).toHaveText('4');
      await shoot(page, `dashboard-${vp}-${theme}`);

      await page.goto('/tasks?view=board');
      await expect(page.getByText('Fatura kontrolü')).toBeVisible();
      await shoot(page, `tasks-board-${vp}-${theme}`);

      await page.goto(`/settings/workflows/${workflowId}`);
      await expect(page.getByTestId('workflow-diagram')).toBeVisible();
      await shoot(page, `workflow-editor-${vp}-${theme}`);
    });
  }
}
