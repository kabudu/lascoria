import { test, expect } from '@playwright/test';

// One Settings dialog: grouped sections, search, keyboard movement, and D2 editor hand-off that
// passes only the session, a relative path and the chosen editor to the native side.
test('settings are grouped and searchable, and Open in editor uses the chosen editor', async ({
  page,
}) => {
  const session = {
    id: 'session-a',
    workspace: '/repo',
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: { current: true, items: [], totalItems: 0, turns: [], approvals: [], userInputs: [] },
  };
  const status = {
    pid: 1,
    version: 'v1',
    features: ['usage', 'usageLatest', 'dataLifecycle', 'supportReport'],
    commands: [],
    sessions: [session],
  };
  const opened: any[] = [];
  let value: any = { sessionId: 'session-a' };
  let revision = 0;
  await page.exposeFunction('settingsBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (command === 'list_editors')
      return [
        { id: 'system', name: 'System default', available: true },
        { id: 'vscode', name: 'Visual Studio Code', available: true },
        { id: 'zed', name: 'Zed', available: false },
      ];
    if (command === 'open_in_editor') {
      opened.push(args);
      return null;
    }
    switch (args?.operation) {
      case 'status':
        return args.params?.since === status.version
          ? { unchanged: true, version: status.version, pid: 1 }
          : status;
      case 'presentation/get':
        return { revision, value };
      case 'presentation/save':
        revision++;
        value = args.params.value;
        return { revision, value };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      case 'usage/latest':
        return { usage: null };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).settingsBridge(command, args),
    };
  });
  await page.goto('/');
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
  const nav = dialog.getByRole('navigation', { name: 'Settings sections' });
  for (const group of ['Lascoria', 'Muse', 'Data & privacy'])
    await expect(nav.getByRole('group', { name: group })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'General' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Radio controls must not inherit the full-width text-input style.
  expect(
    await dialog
      .getByRole('radio', { name: 'Light' })
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThan(24);

  // Appearance applies at once and is saved with the layout.
  await dialog.getByRole('radio', { name: 'Dark' }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Search finds a section by what it controls, and Enter opens the first match.
  const search = nav.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('alerts');
  await expect(nav.getByRole('button')).toHaveText(['Notifications']);
  await search.press('Enter');
  await expect(
    dialog.getByRole('heading', { name: 'Desktop notifications', level: 3 }),
  ).toBeVisible();
  await search.fill('zzz');
  await expect(nav.getByText('No settings match.')).toBeVisible();
  await search.fill('');

  // Arrow keys move between sections.
  await nav.getByRole('button', { name: 'General' }).click();
  await nav.getByRole('button', { name: 'General' }).press('ArrowDown');
  await expect(nav.getByRole('button', { name: 'Editor' })).toBeFocused();
  // The list is one tab stop: Tab leaves it for the section's own controls.
  await page.keyboard.press('Tab');
  await expect(nav.locator(':focus')).toHaveCount(0);
  await expect(dialog.locator('.settings-section :focus')).toHaveCount(1);
  await expect(dialog.getByRole('radio', { name: 'Visual Studio Code' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Zed/ })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Visual Studio Code' }).check();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Open in editor' }).first().click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toEqual({ sessionId: 'session-a', path: '', editor: 'vscode' });
});
