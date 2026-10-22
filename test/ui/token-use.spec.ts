import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

test('token use separates totals, context and optional breakdown without overflow', async ({
  page,
}) => {
  const state: any = {
    current: true,
    approvals: [],
    userInputs: [],
    totalItems: 2,
    turns: [{ turnId: 't1', terminal: 'completed', state: 'settled' }],
    items: [
      {
        itemId: 'u1',
        kind: 'userMessage',
        text: 'Review token layout',
        status: 'completed',
        revision: 1,
        turnId: 't1',
      },
      {
        itemId: 'child',
        kind: 'subagent',
        turnId: 't1',
        status: 'completed',
        revision: 1,
        usage: { inputTokens: 80, outputTokens: 20 },
      },
    ],
    sessionState: {
      'session/tokenUsage': {
        cumulative: {
          totalTokens: 515476,
          promptTokens: 508757,
          outputTokens: 6719,
          cacheReadTokens: 104019,
          cost: { usd: 1.25, partial: true },
        },
      },
      'session/contextUsage': { usedTokens: 42566, windowTokens: 1007997, pressure: 'normal' },
    },
    tokens: {
      byModel: { 'model-one': { totalTokens: 500000 }, 'model-two': { totalTokens: 15476 } },
    },
  };
  const status: any = {
    pid: 1,
    version: 'v1',
    features: [],
    commands: [],
    sessions: [
      {
        id: 's1',
        workspace: '/repo',
        generation: 1,
        lifecycle: 'connected',
        interruptions: [],
        state,
      },
    ],
  };
  let selected = 's1:t1';
  await page.exposeFunction('tokenBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor' || args?.operation === 'status') return status;
    if (args?.operation === 'presentation/get')
      return { revision: 0, value: { sessionId: 's1', selection: selected } };
    if (args?.operation === 'review/list') return { artifacts: [], evidence: [] };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).tokenBridge(command, args),
    };
  });
  await page.goto('/');
  const panel = page.locator('.token-use');
  await panel.locator(':scope > summary').click();
  await expect(panel.locator('.token-metrics')).toContainText('515,476');
  await expect(panel.locator('.token-metrics')).toContainText('No task usage from Muse yet');
  await expect(panel.getByRole('progressbar', { name: 'Context used' })).toHaveAttribute(
    'value',
    '4',
  );
  const breakdown = panel.getByText('Token breakdown', { exact: true });
  await expect(panel.getByText('104,019', { exact: true })).toBeHidden();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const width of [1440, 820, 520]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      expect(
        await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await panel.screenshot({ path: `.dev/token-use-${theme}-${width}.png` });
    }
  }
  await breakdown.click();
  await expect(panel.getByText('104,019', { exact: true })).toBeVisible();
  await expect(panel).toContainText('100 tokens across 1 subagent');
  await expect(panel).toContainText('model-two');
  await expect(panel).toContainText('$1.25 (partial estimate)');
  expect((await new AxeBuilder({ page }).include('.token-use').analyze()).violations).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  selected = 's1:child';
  await page.reload();
  const owning = page.getByRole('button', { name: 'Open owning turn', exact: true });
  await expect(owning).toBeVisible();
  const inspector = page.getByRole('region', { name: 'Selected task inspector' });
  const actionBox = await owning.boundingBox();
  const inspectorBox = await inspector.boundingBox();
  expect(actionBox!.x - inspectorBox!.x).toBeGreaterThanOrEqual(20);
  await expect(panel).toHaveCSS('border-top-width', '0px');
  await panel.locator(':scope > summary').click();
  await inspector.screenshot({ path: '.dev/native-task-inspector-layout.png' });
  await owning.click();
  await expect(owning).toBeHidden();
  selected = 's1:t1';
  // Old hosts cannot advertise archiving. Keep the direct action discoverable with guidance.
  await expect(page.getByRole('button', { name: 'Archive selected session…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Archive selected session…' })).toHaveAttribute(
    'title',
    /Update Lascoria/,
  );

  state.tokens.byTurn = { t1: { totalTokens: 75000, calls: 3, reasoningTokens: 1000 } };
  state.sessionState['session/contextUsage'] = { usedTokens: 125000, pressure: 'blocked' };
  status.version = 'v2';
  await page.reload();
  await panel.locator(':scope > summary').click();
  await expect(panel.locator('.token-metrics')).toContainText('75,000');
  await expect(panel).toContainText('Context is full');
  await expect(panel).toContainText('limit not reported');
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await breakdown.click();
  await expect(panel).toContainText('1,000 tokens');
  await page.setViewportSize({ width: 1440, height: 1000 });
  status.features = ['taskWorkspaces'];
  status.version = 'v3';
  state.activeTurnId = 't1';
  await page.reload();
  const archive = page.getByRole('button', { name: 'Archive selected session…' });
  await archive.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Archive session', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Wait for the current task to finish');
  await dialog.getByRole('button', { name: 'Keep session' }).click();
  state.activeTurnId = undefined;
  status.version = 'v4';
  await page.reload();
  await archive.click();
  await dialog.getByRole('button', { name: 'Archive session', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Archiving was not confirmed');
  await dialog.getByRole('button', { name: 'Keep session' }).click();
});
