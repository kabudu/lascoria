import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

// D4: the UI asks the native side for one notification per new attention item, following the
// saved preferences. The native notifier itself (focus, de-duplication, burst limit) is covered
// by Rust tests; here it is the recorded boundary.
test('desktop notifications follow saved preferences, skip what was already waiting and never carry task text', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lsc-note-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env,
    stdio: 'ignore',
  });
  const notices: any[] = [];
  let tests = 0;
  let failNext = false;
  const context = await browser.newContext();
  const secret = 'Rotate the staging credentials';
  const finish = async (sessionId: string, text: string, id: string) => {
    const before =
      (await request(directory, 'status')).sessions.find((s: any) => s.id === sessionId).state.turns
        ?.length ?? 0;
    await request(directory, 'turn', { sessionId, text }, id);
    await expect
      .poll(async () => {
        const row = (await request(directory, 'status')).sessions.find(
          (s: any) => s.id === sessionId,
        );
        return row.state.turns?.length > before && row.state.turns.at(-1).terminal;
      })
      .toBe('completed');
  };
  try {
    await expect
      .poll(async () => {
        try {
          return (await request(directory, 'status')).pid;
        } catch {
          return 0;
        }
      })
      .toBe(daemon.pid);
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      if (command === 'notify_attention') {
        if (failNext) {
          failNext = false;
          throw new Error('No notification service is running');
        }
        notices.push(args.notice);
        return 'shown';
      }
      if (command === 'notify_test') {
        tests++;
        return null;
      }
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 35000, maxBuffer: 40 * 1024 * 1024 },
      ).catch((error) => {
        if (error.code === 1 && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      return data.result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });
    const sessionId = (
      await request(directory, 'start', { workspace, name: 'Release checks' }, 'start-note')
    ).sessionId;
    await expect
      .poll(async () => (await request(directory, 'status')).sessions[0]?.state.current)
      .toBe(true);
    // Waiting before the window opens: never announced later.
    await finish(sessionId, 'Earlier work', 'earlier');

    await request(
      directory,
      'start',
      {
        workspace,
        name: 'Review implementation across the desktop application and background services',
      },
      'start-long-note',
    );
    const page = await context.newPage();
    await page.goto('/');
    const attention = page.getByRole('region', { name: 'Attention' });
    await expect(
      attention.getByRole('button', { name: /Inspect completion: Earlier work/ }),
    ).toBeVisible();
    await attention.getByRole('button', { name: /Inspect completion: Earlier work/ }).click();
    await page.getByRole('tab', { name: 'transcript', exact: true }).click();
    const background = page.getByRole('switch', { name: /Background activity/ });
    await expect(background).not.toBeChecked();
    await background.focus();
    await page.keyboard.press('Space');
    await expect(background).toBeChecked();
    await expect
      .poll(
        async () =>
          (await request(directory, 'presentation/get', {}, 'read-background'))?.value
            ?.showRuntimeReminders,
      )
      .toBe(true);
    const backgroundBox = await background.boundingBox();
    const backgroundText = await background.locator('..').locator('span').boundingBox();
    expect(
      Math.abs(
        backgroundBox!.y +
          backgroundBox!.height / 2 -
          backgroundText!.y -
          backgroundText!.height / 2,
      ),
    ).toBeLessThan(1);
    await background.locator('..').screenshot({ path: '.dev/background-activity-toggle.png' });
    await background.uncheck();
    await expect
      .poll(
        async () =>
          (await request(directory, 'presentation/get', {}, 'read-background-off'))?.value
            ?.showRuntimeReminders,
      )
      .toBe(false);
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Settings…', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Notifications', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Desktop notifications' })).toBeVisible();
    const enabled = dialog.getByRole('switch', { name: 'Show desktop notifications' });
    const finished = dialog.getByRole('switch', { name: 'A task finishes' });
    const sessionToggle = dialog.getByRole('switch', { name: 'Release checks' });
    await expect(enabled).not.toBeChecked();
    await expect(finished).toBeDisabled();
    await page.setViewportSize({ width: 800, height: 650 });
    await dialog.screenshot({ path: '.dev/notification-toggles-disabled.png' });
    await enabled.focus();
    await page.keyboard.press('Space');
    await expect(finished).toBeChecked();
    await expect(sessionToggle).toBeChecked();
    await page.setViewportSize({ width: 800, height: 650 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      for (const width of [800, 520]) {
        await page.setViewportSize({ width, height: 720 });
        for (const toggle of await dialog.getByRole('switch').all()) {
          const control = await toggle.boundingBox();
          const text = await toggle.locator('..').locator('span').boundingBox();
          expect(control).not.toBeNull();
          expect(text).not.toBeNull();
          expect(
            Math.abs(control!.y + control!.height / 2 - text!.y - text!.height / 2),
          ).toBeLessThan(1);
          expect(control!.width).toBe(42);
        }
        await finished.scrollIntoViewIfNeeded();
        await dialog.screenshot({ path: `.dev/notification-toggles-${theme}-${width}.png` });
        await dialog
          .getByRole('switch', {
            name: 'Review implementation across the desktop application and background services',
          })
          .scrollIntoViewIfNeeded();
        await dialog.screenshot({ path: `.dev/notification-sessions-${theme}-${width}.png` });
      }
    }
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await page.setViewportSize({ width: 800, height: 650 });
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await dialog.getByRole('button', { name: 'Send a test notification', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('Test sent');
    expect(tests).toBe(1);
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    expect(notices).toEqual([]);

    // New completion while enabled: exactly one notice, naming the session only.
    await finish(sessionId, `${secret}\nand report back`, 'secret');
    await expect(
      attention.getByRole('button', { name: /Inspect completion: Rotate/ }),
    ).toBeVisible();
    await expect.poll(() => notices.length).toBe(1);
    expect(notices[0]).toMatchObject({ title: 'A task finished', body: 'Session: Release checks' });
    expect(JSON.stringify(notices)).not.toContain('Rotate');
    // Later status polls do not repeat it.
    await page.waitForTimeout(2500);
    expect(notices.length).toBe(1);

    // A native failure is reported in Settings, not as a page-level error.
    failNext = true;
    await finish(sessionId, 'Third task', 'third');
    await expect(
      attention.getByRole('button', { name: /Inspect completion: Third task/ }),
    ).toBeVisible();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Settings…', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Notifications', exact: true })
      .click();
    await expect(dialog).toContainText(
      'The last notification could not be shown: Error: No notification service is running',
    );
    // Muting the session stops its notices.
    await sessionToggle.uncheck();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await expect
      .poll(
        async () =>
          (await request(directory, 'presentation/get', {}, 'read-note'))?.value?.notifications
            ?.mutedSessions,
      )
      .toEqual([sessionId]);
    await finish(sessionId, 'Fourth task', 'fourth');
    await expect(
      attention.getByRole('button', { name: /Inspect completion: Fourth task/ }),
    ).toBeVisible();
    await page.waitForTimeout(2500);
    expect(notices.length).toBe(1);

    // Preferences survive a reload, and reopening announces nothing already waiting.
    await sessionToggle.page().reload();
    await expect(
      attention.getByRole('button', { name: /Inspect completion: Fourth task/ }),
    ).toBeVisible();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Settings…', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('button', { name: 'Notifications', exact: true })
      .click();
    await expect(enabled).toBeChecked();
    await expect(sessionToggle).not.toBeChecked();
    await sessionToggle.check();
    await finished.uncheck();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page.waitForTimeout(2500);
    expect(notices.length).toBe(1);
    // With finished tasks turned off, a completion stays quiet.
    await finish(sessionId, 'Fifth task', 'fifth');
    await expect(
      attention.getByRole('button', { name: /Inspect completion: Fifth task/ }),
    ).toBeVisible();
    await page.waitForTimeout(2500);
    expect(notices.length).toBe(1);
  } finally {
    await context.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
