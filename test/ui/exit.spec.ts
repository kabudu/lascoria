import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

test('Log out offers keep-running, pause and remembered close behaviour without stopping work by surprise', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-exit-'));
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
  const context = await browser.newContext();
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
    await request(directory, 'start', { workspace, name: 'Background work' }, 'start-exit');
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Workspace menu').click();
    await expect(page.getByRole('button', { name: 'Quit & stop' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Log out…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Log out of Lascoria' })).toBeVisible();
    const choices = dialog.getByRole('group', { name: 'What should happen?' });
    await expect(choices.getByRole('radio')).toHaveCount(2);
    // Without a managed sign-in there is nothing to sign out of; no misleading option.
    await expect(choices).not.toContainText('Sign out of Muse');
    await page.setViewportSize({ width: 800, height: 650 });
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await dialog.getByRole('button', { name: 'Stay in Lascoria', exact: true }).click();
    expect((await request(directory, 'status')).pid).toBe(daemon.pid);

    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Log out…', exact: true }).click();
    await choices.getByRole('radio', { name: /Close Lascoria and keep work running/ }).check();
    await dialog.getByRole('checkbox', { name: 'Do this whenever I close the window' }).check();
    await dialog.getByRole('button', { name: 'Close Lascoria', exact: true }).click();
    await expect(page.getByText('Work continues in the background.')).toBeVisible();
    expect((await request(directory, 'status')).pid).toBe(daemon.pid);
    expect(daemon.exitCode).toBeNull();
    await expect
      .poll(
        async () =>
          (await request(directory, 'presentation/get', {}, 'read-ui'))?.value?.closeBehavior,
      )
      .toBe('keepRunning');

    await page.reload();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Log out…', exact: true }).click();
    await expect(
      choices.getByRole('radio', { name: /Close Lascoria and keep work running/ }),
    ).toBeChecked();
    await choices.getByRole('radio', { name: /Pause work and quit/ }).check();
    await dialog.getByRole('button', { name: 'Pause and quit', exact: true }).click();
    await expect.poll(() => daemon.exitCode, { timeout: 10000 }).toBe(0);
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
