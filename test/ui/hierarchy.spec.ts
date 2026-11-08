import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// The controlled echo provider cannot produce native subagents, so this renders the
// supervisor's status shape directly. Delivery and staging journeys use the real supervisor.
const SUBAGENTS = 150;

function session(id: string, name: string, turns: any[], items: any[]) {
  return {
    id,
    workspace: `/fixture/${id}`,
    displayName: name,
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: { current: true, turns, items, approvals: [], userInputs: [] },
  };
}
const prompt = (turnId: string, text: string) => ({
  itemId: `p-${turnId}`,
  kind: 'userMessage',
  turnId,
  text,
  status: 'completed',
  revision: 1,
});

test('A large map folds subtasks, keeps attention visible and jumps to what needs you', async ({
  page,
}) => {
  const helpers = Array.from({ length: SUBAGENTS }, (_, i) => ({
    itemId: `sub-${i}`,
    kind: 'subagent',
    turnId: 't1',
    objective: `Check module ${i}`,
    status: i === 77 ? 'failed' : 'completed',
    revision: 1,
  }));
  const status: any = {
    pid: 1,
    version: 'hierarchy:1',
    features: [],
    commands: [],
    sessions: [
      session(
        'a',
        'Audit',
        [{ turnId: 't1', terminal: 'completed' }],
        [prompt('t1', '## Audit every module\nThen report'), ...helpers],
      ),
      session(
        'b',
        'Login fix',
        [{ turnId: 't2', terminal: 'failed', error: { kind: 'other', message: 'Stopped' } }],
        [prompt('t2', 'Fix the login redirect')],
      ),
    ],
  };
  // Everything already seen except the failing subagent and the failed login task.
  const seen = [
    ...helpers
      .filter((h) => h.status === 'completed')
      .map((h) => JSON.stringify([`a:${h.itemId}`, 'completed', 1, 0, null])),
    JSON.stringify(['a:t1', 'completed', 0, 0, null]),
  ];
  let revision = 0;
  let value: any = {
    sessionId: 'a',
    selection: 'a:t1',
    acknowledgedTaskFacts: seen,
    positions: { 'a:t1': { x: 340, y: 120 } },
    panels: { inspector: { x: 1000, y: 150, collapsed: true } },
  };
  await page.exposeFunction('hierarchyBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor' || args?.operation === 'status') return status;
    if (args?.operation === 'presentation/get') return { revision, value };
    if (args?.operation === 'presentation/save') {
      value = args.params.value;
      return { revision: ++revision, value };
    }
    if (args?.operation === 'review/list') return { artifacts: [], evidence: [] };
    if (args?.operation === 'drafts/get') return { drafts: {} };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (c: string, a: any) => (window as any).hierarchyBridge(c, a),
    };
  });
  await page.goto('/');

  // Meaningful name from the prompt, and ownership from native provenance.
  const turn = page.locator('#node-a\\:t1');
  await expect(turn).toContainText('Audit every module');
  await expect(turn.locator('.node-owner')).toHaveText('Your task');
  const failing = page.locator('#node-a\\:sub-77');
  await expect(failing.locator('.node-owner')).toHaveText('Subagent of Audit every module');
  await expect(page.locator('.task-node')).toHaveCount(SUBAGENTS + 1);
  const before = await turn.boundingBox();

  // Fold with the keyboard: every helper folds into the card except the failing one.
  await turn.focus();
  const started = Date.now();
  await page.keyboard.press('f');
  await expect(page.locator('.task-node')).toHaveCount(2);
  const foldMs = Date.now() - started;
  await expect(turn.locator('.group-chip')).toHaveText(`+${SUBAGENTS - 1} folded`);
  await expect(turn).toHaveAttribute('aria-label', /subtasks folded/);
  await expect(failing).toBeVisible();
  // Folding and unfolding never moves a card the user placed.
  expect(await turn.boundingBox()).toEqual(before);
  expect(value.positions['a:t1']).toEqual({ x: 340, y: 120 });
  expect(
    (
      await new AxeBuilder({ page })
        .include('.map-scroll')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([]);
  console.log(`Fold of ${SUBAGENTS} subtasks rendered in ${foldMs} ms (one run, scripted).`);

  // The jump visits failures across sessions, then completions, and wraps around.
  const jump = page.getByRole('button', { name: /^Next to review/ });
  await expect(jump).toContainText('2');
  await page.keyboard.press('ControlOrMeta+j');
  await expect(page.locator('.task-node.selected')).toHaveAttribute('id', 'node-a:sub-77');
  // On a narrow window the inspector a jump opens is never covered by canvas tools.
  await page.setViewportSize({ width: 820, height: 900 });
  await page.keyboard.press('ControlOrMeta+j');
  await expect(page.locator('.task-node.selected')).toHaveAttribute('id', 'node-b:t2');
  await expect(page.getByRole('tab', { name: 'transcript', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('tab', { name: 'transcript', exact: true })).toBeFocused();
  expect(
    await page.evaluate(() => {
      const panel = document.querySelector('.inspector')!.closest('.floating-panel')!;
      const r = panel.getBoundingClientRect();
      const points = [];
      for (let x = r.x + 4; x < r.right - 4; x += 12)
        for (let y = r.y + 4; y < r.y + 120; y += 16) points.push([x, y]);
      return points.every(([x, y]) => panel.contains(document.elementFromPoint(x, y)));
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await jump.click();
  await expect(page.locator('.task-node.selected')).toHaveAttribute('id', 'node-a:sub-77');

  // Unfold from the inspector; every helper returns to where it was.
  await page.locator('#node-a\\:t1').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: `Show ${SUBAGENTS} subtasks on the map` }).click();
  await expect(page.locator('.task-node')).toHaveCount(SUBAGENTS + 1);
  // The camera moved to reveal attention; the card's scene position did not.
  await expect(page.locator('#node-a\\:t1')).toHaveCSS('left', '340px');
  await expect(page.locator('#node-a\\:t1')).toHaveCSS('top', '120px');
  expect(value.positions['a:t1']).toEqual({ x: 340, y: 120 });
});
