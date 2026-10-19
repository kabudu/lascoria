import { test, expect } from '@playwright/test';

// R9: the skill catalog is read once per session host and reused while typing; Muse's
// skill/changed (skillsRevision) or a host restart (generation) invalidates it. Lascoria's own
// commands are listed apart from Muse skills, and a skill hidden by a local command is explained.
test('skill picker caches per session, invalidates on skill changes and explains conflicts', async ({
  page,
}) => {
  const session = {
    id: 'session-a',
    workspace: '/repo',
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: {
      current: true,
      skillsRevision: 0,
      items: [],
      totalItems: 0,
      turns: [],
      approvals: [],
      userInputs: [],
    },
  };
  const status = {
    pid: 1,
    version: 'v1',
    features: ['skills', 'usage'],
    commands: [],
    sessions: [session],
  };
  let skillReads = 0;
  let catalog = [
    { selector: 'review', displayName: 'Review', description: 'Review changes', source: 'user' },
    {
      selector: 'acme:review',
      displayName: 'Review',
      description: 'Acme review',
      source: 'plugin',
    },
    {
      selector: 'usage',
      displayName: 'Usage report',
      description: 'Report usage',
      source: 'project',
    },
  ];
  await page.exposeFunction('skillsBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    switch (args.operation) {
      case 'status':
        return args.params?.since === status.version
          ? { unchanged: true, version: status.version, pid: 1 }
          : status;
      case 'presentation/get':
        return { revision: 0, value: { sessionId: 'session-a' } };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      case 'skills':
        skillReads++;
        return { skills: catalog };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).skillsBridge(command, args),
    };
  });
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New task for this session', exact: true });
  const picker = page.getByRole('region', { name: 'Muse shortcuts' });
  await composer.fill('/');
  const skills = picker.getByRole('group', { name: 'Muse skills' });
  await expect(skills.getByRole('button', { name: /\/acme:review/ })).toBeVisible();
  await expect(
    picker
      .getByRole('group', { name: 'Lascoria commands' })
      .getByRole('button', { name: /\/usage/ }),
  ).toBeVisible();
  // The project skill named "usage" is not offered and the reason is given.
  await expect(skills.getByRole('button', { name: /Usage report/ })).toHaveCount(0);
  await expect(skills.getByText(/project skill \/usage is not shown/)).toBeVisible();
  // Same display name from two sources: both rows show their source.
  await expect(skills.getByRole('button', { name: /\/review · Review user/ })).toBeVisible();
  await expect(skills.getByRole('button', { name: /\/acme:review · Review plugin/ })).toBeVisible();
  await expect(skills.getByRole('status')).toHaveText('2 Muse skills');
  // Typing filters locally; closing and reopening reuses the catalog.
  for (const text of ['/r', '/re', '/acme', '', '/']) await composer.fill(text);
  await expect(skills.getByRole('button', { name: / · Review / })).toHaveCount(2);
  await page.waitForTimeout(400);
  expect(skillReads).toBe(1);

  // Muse reports skill/changed: the next opening reads the new catalog.
  await composer.fill('');
  catalog = [{ selector: 'deploy', displayName: 'Deploy', description: 'Ship it', source: 'user' }];
  session.state.skillsRevision = 1;
  status.version = 'v2';
  // Let the next status poll deliver the new revision, then reopen the picker.
  await page.waitForTimeout(2500);
  await composer.fill('/');
  await expect(skills.getByRole('button', { name: /\/deploy/ })).toBeVisible();
  expect(skillReads).toBe(2);
  await expect(skills.getByRole('button', { name: / · Review / })).toHaveCount(0);
});

// R9: the transcript names the skill a task asked for and, separately, what Muse reported
// about loading it; without a `skillRead` report the outcome is shown as unknown.
test('transcript separates the requested skill from observed skill loading', async ({ page }) => {
  const turn = (turnId: string) => ({
    turnId,
    commandId: `c-${turnId}`,
    state: 'settled',
    terminal: 'completed',
  });
  const items = (turnId: string, selector: string, loaded: boolean) => [
    {
      itemId: `${turnId}-ask`,
      kind: 'userMessage',
      status: 'completed',
      revision: 1,
      turnId,
      text: `/${selector} for 1.0`,
    },
    ...(loaded
      ? [
          {
            itemId: `${turnId}-read`,
            kind: 'skillRead',
            status: 'completed',
            revision: 1,
            turnId,
            selector,
            source: 'user',
          },
        ]
      : []),
    {
      itemId: `${turnId}-reply`,
      kind: 'agentMessage',
      status: 'completed',
      revision: 1,
      turnId,
      text: 'Notes written.',
    },
  ];
  const session = {
    id: 'session-a',
    workspace: '/repo',
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    handshake: { experimentalApi: true },
    state: {
      current: true,
      items: items('t1', 'release-notes', true),
      totalItems: 3,
      turns: [turn('t1')],
      approvals: [],
      userInputs: [],
    },
  };
  const status = { pid: 1, version: 'v1', features: ['skills'], commands: [], sessions: [session] };
  await page.exposeFunction('skillAttributionBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (args.operation === 'status')
      return args.params?.since === status.version
        ? { unchanged: true, version: status.version, pid: 1 }
        : status;
    if (args.operation === 'presentation/get')
      return { revision: 0, value: { sessionId: 'session-a' } };
    if (args.operation === 'review/list') return { artifacts: [], evidence: [] };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).skillAttributionBridge(command, args),
    };
  });
  await page.goto('/');
  const label = page.locator('.transcript-skill');
  await expect(label).toHaveText(
    'Requested skill /release-notes · Muse reported loading it from user',
  );
  await expect(page.locator('.transcript-item[data-kind="skillRead"] pre').first()).toHaveText(
    'release-notes (user) · loaded',
  );

  // The same request with no load report: unknown, not "skipped".
  session.state.items = items('t1', 'release-notes', false);
  status.version = 'v2';
  await expect(label).toHaveText(
    'Requested skill /release-notes · Muse did not report loading it; that does not show whether it ran',
    { timeout: 6000 },
  );
  await expect(page.locator('.transcript-item[data-kind="skillRead"]')).toHaveCount(0);
});

// Muse 1.4.10 sends no skill/changed for a skill installed outside the session, although its
// skill/list includes it; a catalog older than 30 seconds is re-read when the picker opens.
test('an older skill catalog is re-read on opening, showing skills added outside Muse', async ({
  page,
}) => {
  await page.clock.install();
  const session = {
    id: 'session-a',
    workspace: '/repo',
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: {
      current: true,
      skillsRevision: 0,
      items: [],
      turns: [],
      approvals: [],
      userInputs: [],
    },
  };
  const status = { pid: 1, version: 'v1', features: ['skills'], commands: [], sessions: [session] };
  let reads = 0;
  let catalog = [
    { selector: 'review', displayName: 'Review', description: 'Review', source: 'user' },
  ];
  await page.exposeFunction('freshBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (args.operation === 'status')
      return args.params?.since === status.version
        ? { unchanged: true, version: status.version, pid: 1 }
        : status;
    if (args.operation === 'presentation/get')
      return { revision: 0, value: { sessionId: 'session-a' } };
    if (args.operation === 'review/list') return { artifacts: [], evidence: [] };
    if (args.operation === 'skills') {
      reads++;
      return { skills: catalog };
    }
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).freshBridge(command, args),
    };
  });
  await page.goto('/');
  const composer = page.getByRole('textbox', { name: 'New task for this session', exact: true });
  const skills = page.getByRole('region', { name: 'Muse shortcuts' }).getByRole('group', {
    name: 'Muse skills',
  });
  await composer.fill('/');
  await page.clock.runFor(500);
  await expect(skills.getByRole('button', { name: /\/review/ })).toBeVisible();
  expect(reads).toBe(1);
  // Within 30 seconds, reopening reuses the catalog.
  await composer.fill('');
  catalog = [
    ...catalog,
    { selector: 'deploy', displayName: 'Deploy', description: 'Ship', source: 'user' },
  ];
  await page.clock.runFor(5000);
  await composer.fill('/');
  await page.clock.runFor(500);
  expect(reads).toBe(1);
  await expect(skills.getByRole('button', { name: /\/deploy/ })).toHaveCount(0);
  // Later, the cached list shows at once and the re-read adds the new skill.
  await composer.fill('');
  await page.clock.runFor(31_000);
  await composer.fill('/');
  await expect(skills.getByRole('button', { name: /\/review/ })).toBeVisible();
  await page.clock.runFor(500);
  await expect(skills.getByRole('button', { name: /\/deploy/ })).toBeVisible();
  expect(reads).toBe(2);
});
