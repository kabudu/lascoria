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
