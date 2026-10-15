import { test, expect } from '@playwright/test';
import { stageCFixture } from '../../testing/stage-c-fixture';
import { writeFile } from 'node:fs/promises';
test('Stage C synthetic projection benchmark: 10 sessions, 50 nodes, paged 100000-item fixture', async ({
  page,
}, info) => {
  const { status, history } = stageCFixture();
  let revision = 0,
    value: any = {
      theme: 'light',
      sessionId: 'session-0',
      panels: {
        sessions: { x: 16, y: 150, collapsed: true },
        attention: { x: 16, y: 460, collapsed: true },
        inspector: { x: 1000, y: 150, collapsed: true },
      },
    };
  let updates = 0;
  const timer = setInterval(() => {
    updates++;
    status.sessions[0].state.items[0].revision++;
  }, 10);
  let largestPage = 0;
  await page.exposeFunction('benchmarkBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    switch (args.operation) {
      case 'status':
        return status;
      case 'presentation/get':
        return { revision, value };
      case 'presentation/save':
        revision++;
        value = args.params.value;
        return { revision, value };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      case 'transcript': {
        const offset = args.params.offset ?? 0;
        const items = history.slice(offset, offset + 100);
        largestPage = Math.max(largestPage, items.length);
        return {
          items,
          totalItems: history.length,
          nextOffset: offset + 100 < history.length ? offset + 100 : null,
          current: true,
        };
      }
      case 'diagnostics':
        return { fixture: true };
      default:
        throw Error(`Unexpected ${args.operation}`);
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).benchmarkBridge(command, args),
    };
  });
  try {
    await page.goto('/');
    await expect(page.locator('.task-node')).toHaveCount(50);
    // Native user actions, measured by production instrumentation through React commits.
    for (let n = 0; n < 40; n++)
      await page
        .locator('.task-node')
        .nth(n % 50)
        .press('Enter');
    // Open inspector with its collapse toggle after node clicks, and page history.
    const historyButton = page.getByRole('button', { name: 'Browse history', exact: true });
    await historyButton.click();
    await expect(page.getByRole('button', { name: 'Next / first page' })).toBeVisible();
    await page.getByRole('button', { name: 'Next / first page' }).click();
    expect(largestPage).toBe(100);
    await page.waitForTimeout(2000);
    await page.getByLabel('Workspace menu', { exact: true }).click();
    await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
    const report = JSON.parse(await page.getByLabel('Diagnostic report').inputValue());
    expect(report.ui.navigationCommit.samples).toBeGreaterThanOrEqual(30);
    expect(report.ui.warmAttachCommit.p95Ms).toBeLessThan(2000);
    expect(report.ui.navigationCommit.p95Ms).toBeLessThan(100);
    const result = {
      schemaVersion: 1,
      kind: 'synthetic-ui-projection',
      workload: {
        sessions: 10,
        visibleNodes: 50,
        storedFixtureItems: 100000,
        updates,
        targetUpdatesPerSecond: 100,
        largestPage,
      },
      timings: report.ui,
      reference: {
        browser: info.project.name || 'chromium',
        viewport: { width: 1440, height: 1000 },
      },
      limitations: [
        'Mock Tauri transport, no Rust supervisor or Muse in this test. Updates coalesce through normal 1-second polling; they are synthetic fixture mutations, not native Muse events. React commit latency is not paint latency.',
      ],
    };
    await writeFile(info.outputPath('benchmark.json'), JSON.stringify(result, null, 2));
    await page.getByRole('button', { name: 'Close dialog' }).click();
    status.features = [];
    await page.getByLabel('Workspace menu', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Diagnostics', exact: true })).toBeDisabled();
    await page.getByLabel('Workspace menu', { exact: true }).click();
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(page.getByLabel('Model', { exact: true })).toBeDisabled();
    await expect(
      page.getByText('This supervisor predates model selection.', { exact: false }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    status.sessions[0].state.current = false;
    status.sessions[0].lifecycle = 'interrupted';
    status.sessions[0].interruptions = [{ kind: 'crash', atMillis: 1 }];
    await page.getByRole('button', { name: 'Expand Attention panel', exact: true }).click();
    const attentionPanel = page.getByRole('region', { name: 'Attention panel', exact: true });
    await expect(
      attentionPanel.getByRole('button', { name: /Execution state unavailable/ }),
    ).toBeVisible();
    await expect(
      attentionPanel.getByRole('button', { name: /Runtime interruption: crash/ }),
    ).toHaveCount(0);
    await attentionPanel.locator('summary').filter({ hasText: 'Runtime history' }).click();
    await expect(
      attentionPanel.getByRole('button', { name: /Runtime interruption: crash/ }),
    ).toBeVisible();
  } finally {
    clearInterval(timer);
  }
});
