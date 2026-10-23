import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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
  let downloads = 0;
  let installs = 0;
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
      if (command === 'update_download') {
        downloads++;
        update =
          downloads === 1
            ? {
                ...update,
                downloaded: false,
                lastError: 'The update did not pass its signature check, so it was not used',
              }
            : { ...update, downloaded: true, lastError: null };
      }
      if (command === 'update_cancel' && args?.clearAvailable)
        update = {
          ...update,
          available: null,
          downloaded: false,
          downloading: false,
          lastCheckedAtMs: null,
        };
      if (command === 'update_install') {
        installs++;
        if (installs === 1) throw Error('Installation failed; retry the downloaded update');
        return null;
      }
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
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
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
  // A background download error arrives through status, not a rejected invoke promise.
  await expect(panel.getByRole('alert')).toHaveText(
    'The update did not pass its signature check, so it was not used',
  );
  await expect(panel.getByRole('button', { name: 'Install and restart…' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Download' }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
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
  await expect(panel.getByRole('alert')).toHaveText(
    'Installation failed; retry the downloaded update',
  );
  // Leaving Updates remounts its local state; the app still remembers the stopped service.
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  await sections.getByRole('button', { name: 'General', exact: true }).click();
  await sections.getByRole('button', { name: 'Updates', exact: true }).click();
  await panel.getByRole('button', { name: 'Install and restart…' }).click();
  await confirm.getByRole('button', { name: 'Pause work, install and restart' }).click();
  await expect.poll(() => installs).toBe(2);
  expect(calls.filter((call) => call === 'stop')).toHaveLength(1);
  expect(calls.indexOf('presentation/save')).toBeLessThan(calls.indexOf('stop'));
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

// A native listener can be installed before its asynchronous registration reply reaches the
// WebView. Leaving Updates during that gap must dispose it, not retain it for the window's life.
test('late update listener registration is disposed after leaving Settings', async ({ page }) => {
  const status = {
    pid: 1,
    version: 'v1',
    features: [],
    commands: [],
    sessions: [],
  };
  let reads = 0;
  let nextListener = 100;
  let globalProgressRegistered = false;
  let pending: { id: number; callback: number; resolve: (id: number) => void } | undefined;
  const unlistened: number[] = [];
  await page.exposeFunction('listenerBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (command === 'plugin:event|listen' && args.event === 'update-progress') {
      if (!globalProgressRegistered) {
        globalProgressRegistered = true;
        return 99;
      }
      const id = ++nextListener;
      return new Promise<number>((resolve) => {
        pending = { id, callback: args.handler, resolve };
      });
    }
    if (command === 'plugin:event|unlisten') {
      unlistened.push(args.eventId);
      return null;
    }
    if (command.startsWith('plugin:event|')) return 1;
    if (command === 'listener_barrier') return reads;
    if (command === 'update_status') {
      reads++;
      return {
        configured: true,
        currentVersion: '0.1.0',
        installStopsWork: true,
        available: null,
        downloaded: false,
        downloading: false,
        progress: null,
      };
    }
    if (args?.operation === 'status') return status;
    if (args?.operation === 'presentation/get')
      return { revision: 0, value: { updates: { automatic: false } } };
    return {};
  });
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    let next = 0;
    (window as any).__updateCallbacks = callbacks;
    // Keep the callback reference available to model an event already queued at disposal.
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).listenerBridge(command, args),
      transformCallback: (callback: (event: unknown) => void) => {
        callbacks.set(++next, callback);
        return next;
      },
    };
  });
  await page.goto('/');
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  const sections = page.getByRole('navigation', { name: 'Settings sections' });
  for (let i = 0; i < 2; i++) {
    await sections.getByRole('button', { name: 'Updates', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Update settings' })).toBeVisible();
    await expect.poll(() => pending?.id).toBe(101 + i);
    const registration = pending!;
    await sections.getByRole('button', { name: 'General', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Update settings' })).toHaveCount(0);
    registration.resolve(registration.id);
    await expect.poll(() => unlistened.includes(registration.id)).toBe(true);
    const before = reads;
    // The bridge barrier is ordered after the callback's possible invoke; no timing sleep.
    const after = await page.evaluate(
      async ({ callback, id }) => {
        (window as any).__updateCallbacks.get(callback)({
          event: 'update-progress',
          id,
          payload: {},
        });
        return (window as any).__TAURI_INTERNALS__.invoke('listener_barrier', {});
      },
      { callback: registration.callback, id: registration.id },
    );
    expect(after).toBe(before);
  }
  expect(unlistened.filter((id) => id >= 101)).toEqual([101, 102]);
});

test('native update action, six-hour discovery and deferred update stay connected', async ({
  page,
}) => {
  const status = {
    pid: 1,
    version: 'e1:1',
    appVersion: '0.1.3',
    features: [],
    commands: [],
    sessions: [],
  };
  let checks = 0;
  let fail = false;
  let downloads = 0;
  let update: any = {
    configured: true,
    currentVersion: '0.1.3',
    installStopsWork: true,
    available: null,
    downloaded: false,
    downloading: false,
    progress: null,
    lastCheckedAtMs: null,
    lastError: null,
  };
  await page.exposeFunction('discoveryBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (command.startsWith('plugin:event|')) return 1;
    if (command === 'update_status') return update;
    if (command === 'update_check') {
      checks++;
      update.lastCheckedAtMs = Date.now();
      if (fail) {
        update.lastError = 'Could not reach the update server. Check your connection and try again';
        throw Error(update.lastError);
      }
      update = {
        ...update,
        lastError: null,
        available: { version: '0.1.4', notes: 'Clearer update controls', date: Date.now() },
      };
      return update;
    }
    if (command === 'update_download') {
      downloads++;
      update.downloaded = true;
      return null;
    }
    if (args?.operation === 'status') return status;
    if (args?.operation === 'presentation/get')
      return { revision: 0, value: { theme: 'light', updates: { automatic: true } } };
    return {};
  });
  await page.addInitScript(() => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const events = new Map<string, number>();
    let next = 0;
    (window as any).__updateEvent = (name: string) => {
      const id = events.get(name);
      if (!id) throw Error(`No native listener: ${name}`);
      callbacks.get(id)!({ event: name, id, payload: {} });
    };
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: (callback: (event: unknown) => void) => {
        callbacks.set(++next, callback);
        return next;
      },
      invoke: (command: string, args: any) => {
        if (command === 'plugin:event|listen') events.set(args.event, args.handler);
        return (window as any).discoveryBridge(command, args);
      },
    };
  });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByLabel('Workspace menu', { exact: true })).toBeVisible();
  await page.clock.fastForward(21_000);
  await expect.poll(() => checks).toBe(1);
  const indicator = page.getByRole('button', { name: 'Update to 0.1.4', exact: true });
  await expect(indicator).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(downloads).toBe(0);
  await page.clock.fastForward(5 * 3_600_000);
  expect(checks).toBe(1);
  await page.clock.fastForward(3_600_000 + 60_000);
  await expect.poll(() => checks).toBe(2);
  await page.evaluate(() => (window as any).__updateEvent('lascoria-check-updates'));
  const dialog = page.getByRole('dialog', { name: 'Update Lascoria', exact: true });
  await expect(dialog).toBeVisible();
  await expect.poll(() => checks).toBe(3);
  await expect(dialog.getByRole('heading', { name: 'Lascoria 0.1.4 is available' })).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Settings sections' })).toHaveCount(0);
  await dialog.getByText("What's new", { exact: true }).click();
  await expect(dialog).toContainText('Clearer update controls');
  for (const width of [1440, 820]) {
    await page.setViewportSize({ width, height: 940 });
    await expect
      .poll(() => dialog.evaluate((node) => node.scrollWidth <= node.clientWidth))
      .toBe(true);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
      await page.screenshot({ path: `.dev/update-dialog-${width}-${theme}.png` });
    }
  }
  await dialog.getByRole('button', { name: 'Done for now' }).click();
  await expect(indicator).toBeVisible();
  expect(downloads).toBe(0);
  await indicator.click();
  expect(checks).toBe(3);
  await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Install and restart…' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done for now' }).click();
  await expect(page.getByRole('button', { name: 'Restart to update', exact: true })).toBeVisible();
  expect(downloads).toBe(1);
  fail = true;
  await page.evaluate(() => (window as any).__updateEvent('lascoria-check-updates'));
  await expect(dialog.getByRole('alert')).toContainText('Could not reach the update server');
  await expect(dialog.getByText('Lascoria is up to date.', { exact: true })).toHaveCount(0);
  // A failed recheck retains the verified download and the persistent action.
  await expect(dialog.getByRole('button', { name: 'Install and restart…' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done for now' }).click();
  await page.clock.fastForward(6 * 3_600_000 + 60_000);
  await expect.poll(() => checks).toBe(5);
  await page.clock.fastForward(5 * 3_600_000);
  expect(checks).toBe(5);
  fail = false;
  await page.clock.fastForward(3_600_000 + 60_000);
  await expect.poll(() => checks).toBe(6);
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart to update', exact: true })).toBeVisible();
});
