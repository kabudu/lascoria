import { test, expect } from '@playwright/test';

// R3: check, download and install are separate explicit steps; installing asks first and, where
// the installer must replace the running service, pauses work before installing. After an
// update the app offers to move the background service to the new version.
test('updates are checked, downloaded and installed only on request, with a safe handoff', async ({
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
      activeTurnId: 'turn-1',
      items: [],
      totalItems: 0,
      turns: [],
      approvals: [],
      userInputs: [],
    },
  };
  const status: any = {
    pid: 1,
    version: 'e1:1',
    appVersion: '0.1.0',
    features: [],
    commands: [],
    sessions: [session],
  };
  const calls: string[] = [];
  let update: any = {
    configured: true,
    currentVersion: '0.1.0',
    installStopsWork: true,
    available: null,
    downloaded: false,
    downloading: false,
    progress: null,
    lastCheckedAtMs: null,
    lastError: null,
  };
  let stopped = false;
  await page.exposeFunction('updatesBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') {
      stopped = false;
      return status;
    }
    if (command.startsWith('plugin:event|')) return 1;
    if (command.startsWith('update_')) {
      calls.push(command);
      if (command === 'update_check') {
        update = {
          ...update,
          lastCheckedAtMs: Date.now(),
          available: { version: '0.2.0', date: Date.now(), notes: 'Faster sessions' },
        };
        return update;
      }
      if (command === 'update_download') update = { ...update, downloaded: true };
      if (command === 'update_cancel' && args?.clearAvailable)
        update = {
          ...update,
          available: null,
          downloaded: false,
          downloading: false,
          lastCheckedAtMs: null,
        };
      if (command === 'update_install') return null;
      return update;
    }
    calls.push(args?.operation);
    switch (args?.operation) {
      case 'status':
        if (stopped) throw Error('Supervisor unavailable');
        return args.params?.since === status.version
          ? { unchanged: true, version: status.version, pid: 1 }
          : status;
      case 'stop':
        stopped = true;
        return { stopping: true, sessions: ['session-a'] };
      case 'presentation/get':
        return { revision: 0, value: { sessionId: 'session-a', updates: { automatic: false } } };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).updatesBridge(command, args),
      transformCallback: () => 1,
    };
  });
  await page.goto('/');
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Updates', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Update settings' });
  await expect(panel).toContainText('You have Lascoria 0.1.0');
  // Automatic checks are off in this layout, so nothing was checked on opening.
  expect(calls).not.toContain('update_check');
  await panel.getByRole('button', { name: 'Check for updates' }).click();
  await expect(panel.getByRole('heading', { name: 'Lascoria 0.2.0 is available' })).toBeVisible();
  expect(calls).not.toContain('update_download');
  await panel.getByRole('button', { name: 'Download' }).click();
  // Changing the channel retires the previous artifact even when it was downloaded.
  await panel.getByRole('radio', { name: /Beta releases/ }).check();
  await expect(panel.getByRole('button', { name: 'Install and restart…' })).toHaveCount(0);
  await expect(panel.getByText('Lascoria is up to date.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Check for updates' }).click();
  await panel.getByRole('button', { name: 'Download' }).click();
  await panel.getByRole('button', { name: 'Install and restart…' }).click();
  const confirm = panel.getByRole('group', { name: 'Confirm installation' });
  await expect(confirm).toContainText('pauses running work first');
  expect(calls).not.toContain('update_install');
  await confirm.getByRole('button', { name: 'Not now' }).click();
  await panel.getByRole('button', { name: 'Install and restart…' }).click();
  await confirm.getByRole('button', { name: 'Pause work, install and restart' }).click();
  await expect.poll(() => calls.includes('update_install')).toBe(true);
  // Work was paused and the service stopped before installing.
  expect(calls.indexOf('stop')).toBeGreaterThan(-1);
  expect(calls.indexOf('stop')).toBeLessThan(calls.indexOf('update_install'));
});

test('a background service from an older version is restarted only when safe', async ({ page }) => {
  const status: any = {
    pid: 1,
    version: 'e1:1',
    appVersion: '0.1.0',
    features: [],
    commands: [],
    sessions: [
      {
        id: 's',
        workspace: '/repo',
        generation: 1,
        lifecycle: 'connected',
        interruptions: [],
        state: {
          current: true,
          activeTurnId: 't',
          items: [],
          totalItems: 0,
          turns: [],
          approvals: [],
          userInputs: [],
        },
      },
    ],
  };
  let stopped = false;
  let stops = 0;
  await page.exposeFunction('handoffBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') {
      if (stopped) {
        stopped = false;
        status.appVersion = '0.2.0';
        status.version = 'e2:1';
      }
      return status;
    }
    if (command === 'update_status')
      return {
        configured: true,
        currentVersion: '0.2.0',
        installStopsWork: false,
        available: null,
      };
    switch (args?.operation) {
      case 'status':
        if (stopped) throw Error('Supervisor unavailable');
        return status;
      case 'stop':
        stops++;
        stopped = true;
        return { stopping: true, sessions: ['s'] };
      case 'presentation/get':
        return { revision: 0, value: { sessionId: 's', updates: { automatic: false } } };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).handoffBridge(command, args),
    };
  });
  await page.goto('/');
  const banner = page.getByRole('status', { name: 'Finish updating' });
  await expect(banner).toContainText('still 0.1.0');
  await banner.getByRole('button', { name: 'Restart when work finishes' }).click();
  await expect(banner).toContainText('will restart when running work finishes');
  await page.waitForTimeout(1500);
  expect(stops).toBe(0);
  // The task finishes: the service restarts on its own and the banner goes.
  status.sessions[0].state.activeTurnId = undefined;
  status.version = 'e1:2';
  await expect(banner).toHaveCount(0, { timeout: 15000 });
  expect(stops).toBe(1);
});
