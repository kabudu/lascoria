import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const project of [false, true])
  test(`session sequence and viewport discovery: ${project ? 'Project' : 'standalone'}`, async ({
    page,
  }) => {
    const state: any = {
      current: true,
      activeTurnId: 't2',
      approvals: [],
      userInputs: [],
      totalItems: 2,
      turns: [{ turnId: 't1', terminal: 'completed' }, { turnId: 't2' }],
      items: [
        {
          itemId: 'u1',
          kind: 'userMessage',
          turnId: 't1',
          text: 'Earlier work',
          status: 'completed',
        },
        {
          itemId: 'u2',
          kind: 'userMessage',
          turnId: 't2',
          text: 'Current work',
          status: 'completed',
        },
      ],
    };
    const row: any = {
      id: 's1',
      workspace: '/repo',
      displayName: 'Discovery trial',
      generation: 1,
      lifecycle: 'connected',
      interruptions: [],
      state,
    };
    if (project)
      row.projectContext = {
        name: 'Trial Project',
        revision: 1,
        folders: [{ id: 'root', path: '/repo', name: 'Repository' }],
      };
    const status: any = {
      pid: 1,
      appVersion: '0.1.7',
      version: 'e1:1',
      features: [],
      commands: [],
      sessions: [
        row,
        {
          ...row,
          id: 's2',
          displayName: 'Other session',
          projectContext: undefined,
          state: { ...state, activeTurnId: undefined, turns: [], items: [] },
        },
      ],
    };
    let presentation: any = {
      sessionId: 's1',
      selection: 's1:t1',
      zoom: project ? 0.6 : 1.2,
      canvasOffset: project ? { x: 600, y: 300 } : { x: -250, y: -80 },
      positions: { 's1:t1': { x: 400, y: 260 } },
      panels: {
        sessions: { x: 16, y: 150, collapsed: false },
        attention: { x: 16, y: 480, collapsed: true },
        inspector: { x: 1004, y: 150, collapsed: false },
      },
    };
    let revision = 0;
    let sequence = 1;
    const add = (label: string) => {
      const id = `t${state.turns.length + 1}`;
      state.turns.at(-1).terminal = 'completed';
      state.turns.push({ turnId: id });
      state.items.push({
        itemId: `u${id}`,
        kind: 'userMessage',
        turnId: id,
        text: label,
        status: 'completed',
      });
      state.activeTurnId = id;
      status.version = `e1:${++sequence}`;
      return id;
    };
    await page.exposeFunction('discoveryBridge', async (command: string, args: any) => {
      if (command === 'connect_supervisor' || args?.operation === 'status') return status;
      if (args?.operation === 'presentation/get') return { revision, value: presentation };
      if (args?.operation === 'presentation/save') {
        presentation = args.params.value;
        return { revision: ++revision, value: presentation };
      }
      if (args?.operation === 'review/list') return { artifacts: [], evidence: [] };
      if (args?.operation === 'turn')
        return { status: 'applied', result: { turnId: add(args.params.text) } };
      return {};
    });
    await page.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).discoveryBridge(c, a),
      };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    const current = page.locator('.task-node').filter({ hasText: 'Current work' });
    await expect(page.locator('.session-edge')).toHaveCount(1);
    await expect(page.getByRole('list', { name: 'Session task order' })).toContainText(
      'not a dependency',
    );
    await expect(
      page
        .getByRole('region', { name: 'Selected task inspector' })
        .getByRole('heading', { name: 'Current work', exact: true }),
    ).toBeVisible();
    const clear = async (locator: any) =>
      expect
        .poll(() =>
          locator.evaluate((node: HTMLElement) => {
            const r = node.getBoundingClientRect(),
              canvas = node.closest('.map-scroll')!.getBoundingClientRect();
            if (
              r.left < canvas.left ||
              r.top < canvas.top ||
              r.right > canvas.right ||
              r.bottom > canvas.bottom
            )
              return false;
            return [0.1, 0.5, 0.9].every((x) =>
              [0.1, 0.5, 0.9].every((y) =>
                node.contains(document.elementFromPoint(r.x + r.width * x, r.y + r.height * y)),
              ),
            );
          }),
        )
        .toBe(true);
    await clear(current);
    await expect(page.locator('.edges')).toHaveCSS('overflow', 'visible');
    await page.screenshot({
      path: `.dev/constellation-discovery-wide-${project ? 'project' : 'standalone'}.png`,
    });
    await expect.poll(() => presentation.positions?.['s1:t2']).toBeTruthy();
    expect(presentation.positions['s1:t1']).toEqual({ x: 400, y: 260 });
    const placed = structuredClone(presentation.positions['s1:t2']);
    await current.focus();
    await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => presentation.positions['s1:t2'].x).toBeCloseTo(placed.x + 20);
    const dragged = await current.boundingBox();
    await page.mouse.move(dragged!.x + 30, dragged!.y + 30);
    await page.mouse.down();
    await page.mouse.move(dragged!.x + 54, dragged!.y + 48, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => presentation.positions['s1:t2'].y).toBeGreaterThan(placed.y);
    const cameraBefore = await page.locator('.task-map').getAttribute('style');
    await page.mouse.move(700, 600);
    await page.mouse.wheel(120, 70);
    await expect.poll(() => page.locator('.task-map').getAttribute('style')).not.toBe(cameraBefore);
    await page.getByRole('button', { name: 'Show current task', exact: true }).click();
    await clear(current);
    // Deliberately inspect older work. A new external turn must not steal that selection.
    await page.getByRole('button', { name: 'Expand canvas controls', exact: true }).click();
    await page.getByRole('button', { name: 'List', exact: true }).click();
    await page.locator('.task-list button').filter({ hasText: 'Earlier work' }).click();
    add('External continuation');
    await expect(page.getByRole('region', { name: 'Canvas navigation' })).toContainText(
      'External continuation',
    );
    await expect(
      page
        .getByRole('region', { name: 'Selected task inspector' })
        .getByRole('heading', { name: 'Earlier work', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Show current task', exact: true }).focus();
    await page.keyboard.press('Enter');
    const external = page.locator('.task-node').filter({ hasText: 'External continuation' });
    await clear(external);
    await expect(page.locator('.session-edge')).toHaveCount(2);
    // Sending a new task reveals it, even after a deliberate pan/zoom and old selection.
    state.turns.at(-1).terminal = 'completed';
    state.activeTurnId = undefined;
    status.version = `e1:${++sequence}`;
    await expect(page.getByRole('button', { name: 'Start turn', exact: true })).toBeEnabled();
    await page.getByRole('textbox', { name: 'Search tasks', exact: true }).fill('Earlier');
    await page
      .getByRole('textbox', { name: 'New task for this session', exact: true })
      .fill('Sent continuation');
    await page.getByRole('button', { name: 'Start turn', exact: true }).click();
    const sent = page.locator('.task-node').filter({ hasText: 'Sent continuation' });
    await clear(sent);
    await expect(page.locator('.session-edge')).toHaveCount(3);
    await expect.poll(() => presentation.positions?.['s1:t4']).toBeTruthy();
    const saved = structuredClone(presentation.positions);
    await page.reload();
    await clear(sent);
    expect(presentation.positions).toEqual(saved);
    // Other sessions never acquire links or cards from this conversation.
    await page
      .getByRole('navigation', { name: 'Sessions', exact: true })
      .getByRole('button', { name: /Other session/ })
      .click();
    await expect(page.locator('.session-edge')).toHaveCount(0);
    await expect(page.locator('.task-node')).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Sessions', exact: true })
      .getByRole('button', { name: /Discovery trial/ })
      .click();
    await clear(sent);
    for (const width of [1100, 820]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole('button', { name: 'Show current task', exact: true }).click();
      await clear(sent);
    }
    expect(
      (await new AxeBuilder({ page }).include('.canvas-discovery').analyze()).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `.dev/constellation-discovery-${project ? 'project' : 'standalone'}.png`,
    });
    expect(presentation.positions).toEqual(saved);
  });

test('crowded viewport reports overflow, preserves positions and reveals after panels make room', async ({
  page,
}) => {
  const turns = Array.from({ length: 18 }, (_, i) => ({ turnId: `t${i}`, terminal: 'completed' }));
  const items = turns.map((t, i) => ({
    itemId: `u${i}`,
    kind: 'userMessage',
    turnId: t.turnId,
    text: `Crowded work ${i}`,
    status: 'completed',
  }));
  const status: any = {
    pid: 1,
    appVersion: '0.1.7',
    version: 'e1:1',
    features: [],
    commands: [],
    sessions: [
      {
        id: 'crowd',
        workspace: '/repo',
        generation: 1,
        lifecycle: 'connected',
        interruptions: [],
        state: { current: true, turns, items, approvals: [], userInputs: [] },
      },
    ],
  };
  let value: any = {
    sessionId: 'crowd',
    zoom: 1,
    panels: {
      sessions: { x: 16, y: 150, collapsed: false },
      attention: { x: 16, y: 470, collapsed: false },
      inspector: { x: 300, y: 150, collapsed: false },
    },
  };
  let rev = 0;
  await page.exposeFunction('crowdBridge', async (c: string, a: any) => {
    if (c === 'connect_supervisor' || a?.operation === 'status') return status;
    if (a?.operation === 'presentation/get') return { revision: rev, value };
    if (a?.operation === 'presentation/save') {
      value = a.params.value;
      return { revision: ++rev, value };
    }
    if (a?.operation === 'review/list') return { artifacts: [], evidence: [] };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (c: string, a: any) => (window as any).crowdBridge(c, a),
    };
  });
  await page.setViewportSize({ width: 800, height: 650 });
  await page.goto('/');
  await expect(page.locator('.task-node')).toHaveCount(18);
  const overflow = page.getByRole('button', { name: /tasks out of view · Reveal/ });
  await expect(overflow).toBeVisible();
  await expect.poll(() => Object.keys(value.positions ?? {}).length).toBe(18);
  const saved = structuredClone(value.positions);
  // Panel disclosure and a resize must never rearrange saved cards or silently pan.
  const camera = () =>
    page
      .locator('.task-map')
      .evaluate((e: HTMLElement) => [e.style.left, e.style.top, e.style.transform]);
  const before = await camera();
  await page.getByRole('button', { name: 'Collapse Task inspector panel', exact: true }).click();
  expect(await camera()).toEqual(before);
  expect(value.positions).toEqual(saved);
  await overflow.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => camera()).not.toEqual(before);
  const current = page.locator('.task-node.selected');
  await expect(current).toBeVisible();
  expect(
    await current.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(value.positions).toEqual(saved);
  await page.screenshot({ path: '.dev/constellation-discovery-crowded.png' });
});

test('automatic positions cannot exceed saved-layout capacity or block other preferences', async ({
  page,
}) => {
  const row = {
    id: 'capacity',
    workspace: '/repo',
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: {
      current: true,
      activeTurnId: 't1',
      turns: [{ turnId: 't1' }],
      items: [
        {
          itemId: 'u1',
          kind: 'userMessage',
          turnId: 't1',
          text: 'Capacity trial',
          status: 'completed',
        },
      ],
      approvals: [],
      userInputs: [],
    },
  };
  const status = {
    pid: 1,
    appVersion: '0.1.7',
    version: 'e1:1',
    features: [],
    commands: [],
    sessions: [
      row,
      {
        ...row,
        id: 'other',
        displayName: 'Other saved session',
        state: {
          ...row.state,
          activeTurnId: undefined,
          turns: [{ turnId: 't1', terminal: 'completed' }],
        },
      },
    ],
  };
  let value: any = {
    sessionId: 'capacity',
    annotations: { retained: 'x'.repeat(45000) },
    positions: { 'other:t1': { x: 500, y: 300 } },
    panels: { inspector: { x: 1000, y: 150, collapsed: true } },
  };
  let revision = 0,
    saves = 0;
  await page.exposeFunction('capacityBridge', async (c: string, a: any) => {
    if (c === 'connect_supervisor' || a?.operation === 'status') return status;
    if (a?.operation === 'presentation/get') return { revision, value };
    if (a?.operation === 'presentation/save') {
      expect(Buffer.byteLength(JSON.stringify(a.params.value))).toBeLessThanOrEqual(48000);
      value = a.params.value;
      saves++;
      return { revision: ++revision, value };
    }
    if (a?.operation === 'review/list') return { artifacts: [], evidence: [] };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (c: string, a: any) => (window as any).capacityBridge(c, a),
    };
  });
  await page.goto('/');
  await expect(
    page.getByText('New card positions are temporary: saved layout is full.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Show current task', exact: true }).click();
  const card = page.locator('.task-node');
  await expect(card).toBeInViewport();
  expect(value.positions['capacity:t1']).toBeUndefined();
  await page.getByLabel('Workspace menu').click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect.poll(() => value.theme).toBe('dark');
  expect(saves).toBeGreaterThan(0);
  await expect(card).toBeInViewport();
  await page.screenshot({ path: '.dev/constellation-discovery-dark-capacity.png' });
  await page
    .getByRole('navigation', { name: 'Sessions', exact: true })
    .getByRole('button', { name: /Other saved session/ })
    .click();
  await expect(
    page.getByText('New card positions are temporary: saved layout is full.'),
  ).toHaveCount(0);
});
