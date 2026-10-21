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
  let failEditor = false;
  let value: any = { sessionId: 'session-a' };
  let revision = 0;
  await page.exposeFunction('settingsBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (command === 'list_editors')
      return [
        { id: 'system', name: 'File manager (folders only)', available: true },
        { id: 'vscode', name: 'Visual Studio Code', available: true },
        { id: 'zed', name: 'Zed', available: false },
      ];
    if (command === 'open_in_editor') {
      opened.push(args);
      if (failEditor) throw new Error('Choose an editor in Settings to open files');
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
  await expect(dialog.getByRole('radio', { name: 'File manager (folders only)' })).toBeChecked();
  await expect(dialog.getByText(/With File manager selected, only folders open/)).toBeVisible();
  await expect(dialog.getByRole('radio', { name: 'Visual Studio Code' })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Zed/ })).toBeDisabled();
  await dialog.getByRole('radio', { name: 'Visual Studio Code' }).check();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Open in editor' }).first().click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toEqual({ sessionId: 'session-a', path: '', editor: 'vscode' });
  failEditor = true;
  await page.getByRole('button', { name: 'Open in editor' }).first().click();
  const failure = page.getByRole('alert').filter({ hasText: 'Could not open in your editor' });
  await expect(failure).toBeVisible();
  await expect(failure.getByRole('button', { name: 'Reconnect' })).toHaveCount(0);
  await failure.getByRole('button', { name: 'Choose editor', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Editor', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Dismiss editor error' }).click();
  await expect(failure).toHaveCount(0);
});

test('Project editor handoff keeps the selected folder with identical file names', async ({
  page,
}) => {
  const session = {
    id: 'project-session',
    workspace: '/repo/web',
    generation: 1,
    lifecycle: 'connected',
    projectContext: {
      id: 'project',
      name: 'Two repositories',
      revision: 1,
      folders: [
        { id: 'web', name: 'Web', path: '/repo/web' },
        { id: 'api', name: 'API', path: '/repo/api' },
      ],
    },
    interruptions: [],
    state: { current: true, items: [], totalItems: 0, turns: [], approvals: [], userInputs: [] },
  };
  const status = {
    pid: 1,
    version: 'v1',
    features: ['taskWorkspaces'],
    commands: [],
    sessions: [session],
  };
  const opened: any[] = [];
  let finishOldRead: (() => void) | undefined;
  let holdRead = false;
  await page.exposeFunction('projectEditorBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (command === 'open_in_editor') {
      opened.push(args);
      return null;
    }
    switch (args?.operation) {
      case 'status':
        return args.params?.since === status.version
          ? { unchanged: true, version: status.version }
          : status;
      case 'presentation/get':
        return { revision: 1, value: { sessionId: session.id, editor: 'vscode' } };
      case 'presentation/save':
        return { revision: 2, value: args.params.value };
      case 'workspace/files':
        return { paths: ['same.txt'] };
      case 'workspace/file': {
        const revision = session.projectContext.revision;
        if (holdRead) {
          holdRead = false;
          await new Promise<void>((resolve) => {
            finishOldRead = resolve;
          });
        }
        return {
          path: 'same.txt',
          text: `Content from ${args.params.folderId} revision ${revision}`,
        };
      }
      case 'workspace/inspect':
        return {
          branch: 'task',
          head: 'abc',
          patch: '',
          fingerprint: 'fixture',
          untracked: [{ path: 'new.txt', text: 'new' }],
        };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (c: string, a: any) => (window as any).projectEditorBridge(c, a),
    };
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('api');
  await page.getByRole('button', { name: 'same.txt', exact: true }).click();
  const file = page
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^same.txt$/ }) });
  await expect(file).toContainText('Content from api');
  await file.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toEqual({
    sessionId: session.id,
    path: 'same.txt',
    editor: 'vscode',
    folderId: 'api',
    projectRevision: 1,
  });
  await file.getByRole('button', { name: 'Add file to task draft' }).click();
  await expect(page.getByRole('textbox', { name: 'New task for this session' })).toHaveValue(
    /Repository context \(API\): same.txt/,
  );
  await expect(page.getByRole('textbox', { name: 'New task for this session' })).toHaveValue(
    /Folder: \/repo\/api/,
  );
  await page.getByRole('tab', { name: 'workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('api');
  await page.getByRole('button', { name: 'Refresh change preview' }).click();
  await page.getByText('New files (1)', { exact: true }).click();
  const newFile = page.getByText('new.txt', { exact: true }).locator('..');
  await page.getByText('new.txt', { exact: true }).click();
  await newFile.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect.poll(() => opened.length).toBe(2);
  expect(opened[1]).toEqual({
    sessionId: session.id,
    path: 'new.txt',
    editor: 'vscode',
    folderId: 'api',
    projectRevision: 1,
  });

  // A Project change must retire both cached previews and replies already in flight.
  holdRead = true;
  await page.getByRole('button', { name: 'same.txt', exact: true }).click();
  await expect.poll(() => Boolean(finishOldRead)).toBe(true);
  session.projectContext.revision = 2;
  session.projectContext.folders[1].path = '/repo/api-next';
  status.version = 'v2';
  await expect(page.getByRole('combobox', { name: 'Folder', exact: true })).toHaveValue('web');
  finishOldRead!();
  await page.getByRole('combobox', { name: 'Folder', exact: true }).selectOption('api');
  await expect(page.getByText('Content from api revision 1', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'same.txt', exact: true }).click();
  await expect(file).toContainText('Content from api revision 2');
  await file.getByRole('button', { name: 'Open in editor', exact: true }).click();
  await expect.poll(() => opened.length).toBe(3);
  expect(opened[2]).toMatchObject({ folderId: 'api', projectRevision: 2 });
});
