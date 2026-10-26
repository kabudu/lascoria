import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('archive stays in the Sessions header and archived selections obey the list filter', async ({
  page,
}) => {
  const sessions = Array.from({ length: 21 }, (_, i) => ({
    id: `session-${i}`,
    displayName: i === 19 ? 'Archive target' : `Session ${i}`,
    workspace: '/repo',
    generation: 1,
    lifecycle: i === 20 ? 'archived' : 'connected',
    interruptions: [],
    state: {
      current: i !== 20,
      items: [
        {
          itemId: `prompt-${i}`,
          kind: 'userMessage',
          turnId: `turn-${i}`,
          text: `Canvas task ${i}`,
        },
      ],
      turns: [{ turnId: `turn-${i}`, terminal: 'completed' }],
      totalItems: 0,
      approvals: [],
      userInputs: [],
    },
  }));
  const status = {
    pid: 1,
    appVersion: '0.1.5',
    version: 'e1:1',
    features: ['taskWorkspaces'],
    commands: [],
    sessions,
  };
  let presentation: any = {
    sessionId: 'session-19',
    panels: { sessions: { x: 16, y: 100, collapsed: false } },
  };
  let archives = 0;
  await page.exposeFunction('archiveBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor' || args?.operation === 'status') return status;
    if (command === 'update_status') return { configured: false, currentVersion: '0.1.5' };
    if (args?.operation === 'presentation/get') return { revision: 0, value: presentation };
    if (args?.operation === 'presentation/save') {
      presentation = args.params.value;
      return { revision: args.params.expectedRevision + 1, value: presentation };
    }
    if (args?.operation === 'review/list') return { artifacts: [], evidence: [] };
    if (args?.operation === 'session/archive') {
      expect(args.params.sessionId).toBe('session-19');
      archives++;
      sessions[19].lifecycle = 'archived';
      sessions[19].state.current = false;
      status.version = 'e1:2';
      return { status: 'applied' };
    }
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).archiveBridge(command, args),
    };
  });
  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Sessions panel', exact: true });
  const list = panel.getByRole('navigation', { name: 'Sessions', exact: true });
  const archive = panel.getByRole('button', { name: 'Archive selected session…', exact: true });
  await expect(list.getByRole('button')).toHaveCount(20);
  await expect(
    panel
      .locator('.panel-heading')
      .getByRole('button', { name: 'Archive selected session…', exact: true }),
  ).toBeVisible();
  const before = await archive.boundingBox();
  await panel.locator('.panel-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect((await archive.boundingBox())!.y).toBe(before!.y);
  await expect(archive).toBeInViewport();
  await panel.getByRole('button', { name: 'Collapse Sessions panel', exact: true }).click();
  await expect(archive).toBeVisible();
  await archive.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Archive target');
  await page.getByRole('button', { name: 'Keep session', exact: true }).click();
  expect(archives).toBe(0);
  await panel.getByRole('button', { name: 'Expand Sessions panel', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 820]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await panel.boundingBox();
      const action = await archive.boundingBox();
      expect(action!.x).toBeGreaterThanOrEqual(bounds!.x + 8);
      expect(action!.x + action!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width - 8);
      expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(
        await panel.locator('.panel-heading').evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [0.25, 0.5, 0.75].every((x) =>
            [0.25, 0.5, 0.75].every((y) =>
              el.contains(document.elementFromPoint(r.x + r.width * x, r.y + r.height * y)),
            ),
          );
        }),
      ).toBe(true);
      await panel.screenshot({ path: `.dev/archive-header-${theme}-${width}.png` });
    }
  }
  expect(
    (await new AxeBuilder({ page }).include('[aria-label="Sessions panel"]').analyze()).violations,
  ).toEqual([]);
  await archive.click();
  await page.getByRole('button', { name: 'Archive session', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(list.getByRole('button')).toHaveCount(19);
  await expect(list.getByRole('button', { name: /Archive target/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Session 0', exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Constellation canvas', exact: true })
      .getByText('Canvas task 19', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Constellation canvas', exact: true })
      .getByText('Canvas task 0', { exact: true }),
  ).toBeVisible();
  const filter = panel.getByRole('switch', { name: 'Show archived sessions', exact: true });
  await filter.check();
  await expect(list.getByRole('button')).toHaveCount(21);
  await list.getByRole('button', { name: /SESSION.*Session 20/ }).click();
  await filter.uncheck();
  await expect(list.getByRole('button')).toHaveCount(19);
  await expect(page.getByRole('heading', { name: 'Session 0', exact: true })).toBeVisible();
  await page.reload();
  await expect(list.getByRole('button')).toHaveCount(19);
  // With only retained history, clear the canvas and keep archive discovery available.
  sessions.forEach((s) => {
    s.lifecycle = 'archived';
    s.state.current = false;
  });
  status.version = 'e1:3';
  await page.reload();
  await expect(list.getByRole('button')).toHaveCount(0);
  await expect(panel.getByText(/No active sessions/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Constellation canvas', exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('heading', { name: 'All sessions are archived.', exact: true }),
  ).toBeVisible();
  await filter.check();
  await expect(list.getByRole('button')).toHaveCount(21);
  await list.getByRole('button', { name: /SESSION.*Session 20/ }).click();
  await expect(
    page
      .getByRole('region', { name: 'Constellation canvas', exact: true })
      .getByText('Canvas task 20', { exact: true }),
  ).toBeVisible();
  expect(archives).toBe(1);
});
