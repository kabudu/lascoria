import { test, expect } from '@playwright/test';

test('node activity is visible while working, quiet when waiting or stale, and respects reduced motion', async ({
  page,
}) => {
  const state: any = {
    current: true,
    activeTurnId: 'turn',
    turns: [{ turnId: 'turn' }],
    items: [
      {
        itemId: 'prompt',
        kind: 'userMessage',
        turnId: 'turn',
        text: 'Visible activity while running a long task across several repositories and checking meaningful native output',
        status: 'completed',
        revision: 1,
      },
    ],
    approvals: [],
    userInputs: [],
  };
  const status: any = {
    pid: 1,
    version: 'activity:1',
    features: [],
    commands: [],
    sessions: [
      {
        id: 's',
        workspace: '/fixture',
        generation: 1,
        lifecycle: 'connected',
        interruptions: [],
        state,
      },
    ],
  };
  let revision = 0;
  let value: any = {
    sessionId: 's',
    selection: 's:turn',
    panels: { inspector: { x: 1000, y: 150, collapsed: true } },
  };
  await page.exposeFunction('activityBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor' || args?.operation === 'status') return status;
    if (args?.operation === 'presentation/get') return { revision, value };
    if (args?.operation === 'presentation/save') {
      value = args.params.value;
      return { revision: ++revision, value };
    }
    if (args?.operation === 'review/list') return { artifacts: [], evidence: [] };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (c: string, a: any) => (window as any).activityBridge(c, a),
    };
  });
  await page.goto('/');
  const node = page.locator('#node-s\\:turn');
  const rail = node.locator('.node-activity-rail');
  await expect(node).toHaveAttribute('aria-busy', 'true');
  await expect(rail).toBeVisible();
  await expect(rail).toHaveAttribute('aria-hidden', 'true');
  const titleBounds = await node.locator('strong').evaluate((e) => ({
    height: e.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(e).lineHeight),
    clamp: getComputedStyle(e).webkitLineClamp,
  }));
  expect(titleBounds.clamp).toBe('2');
  expect(titleBounds.height).toBeLessThanOrEqual(titleBounds.lineHeight * 2 + 1);

  expect(await rail.locator('span').evaluate((e) => getComputedStyle(e).animationName)).toBe(
    'node-activity-sweep',
  );
  const bounds = await rail.boundingBox();
  expect(bounds!.width).toBeGreaterThan(100);
  expect(bounds!.height).toBe(3);
  await node.screenshot({ path: '.dev/node-working-light.png' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await node.screenshot({ path: '.dev/node-working-dark.png' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(rail).toBeVisible();
  expect(await rail.locator('span').evaluate((e) => getComputedStyle(e).animationName)).toBe(
    'none',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  state.items.push({
    itemId: 'tool',
    kind: 'toolCall',
    turnId: 'turn',
    status: 'inProgress',
    revision: 1,
    displayLabel: { active: 'Running tests' },
  });
  status.version = 'activity:2';
  await expect(node.locator('.node-activity-label')).toHaveText('Running tests');
  await expect(rail).toBeVisible();
  state.userInputs = [{ userInputId: 'question', turnId: 'turn', questions: [] }];
  status.version = 'activity:3';
  await expect(node).toHaveAttribute('aria-busy', 'false');
  await expect(node.locator('.node-activity-label')).toHaveText('Answer needed');
  await expect(rail).toHaveCount(0);
  state.userInputs = [];
  state.approvals = [
    {
      requested: {
        approvalId: 'approval',
        turnId: 'turn',
        availableChoices: [],
        rawArgs: '{}',
        toolName: 'bash',
      },
    },
  ];
  status.version = 'activity:4';
  await expect(node.locator('.node-activity-label')).toHaveText('Permission needed');
  await expect(rail).toHaveCount(0);
  state.approvals = [];
  state.current = false;
  status.version = 'activity:5';
  await expect(node.locator('.node-activity-label')).toHaveText('Reconnecting');
  await expect(node).toHaveAttribute('aria-busy', 'false');
  await expect(rail).toHaveCount(0);
  state.current = true;
  status.version = 'activity:6';
  await expect(rail).toBeVisible();
  state.activeTurnId = undefined;
  state.turns[0].terminal = 'completed';
  state.items.push({
    itemId: 'child',
    kind: 'subagent',
    turnId: 'turn',
    label: 'Independent helper',
    status: 'inProgress',
    revision: 1,
  });
  status.version = 'activity:7';
  await expect(node).toHaveAttribute('aria-busy', 'false');
  await expect(rail).toHaveCount(0);
  const child = page.locator('.task-node').filter({ hasText: 'Independent helper' });
  await expect(child).toHaveAttribute('aria-busy', 'true');
  await expect(child.locator('.node-activity-rail')).toBeVisible();
  state.items.at(-1).status = 'pending';
  status.version = 'activity:8';
  await expect(child.locator('.node-activity-label')).toHaveText('Queued');
  await expect(child.locator('.node-activity-rail')).toHaveCount(0);
  state.items.at(-1).status = 'completed';
  status.version = 'activity:9';
  await expect(child.locator('.node-activity-label')).toHaveText('completed');
  await expect(page.locator('.node-activity-rail')).toHaveCount(0);
});
