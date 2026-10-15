import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
test('local session sharing and explicit Muse delivery through native Rust bridge', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-relay-ui-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'work');
  await mkdir(workspace);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
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
    const a = (await request(directory, 'start', { workspace }, 'start-a')).sessionId;
    const b = (await request(directory, 'start', { workspace }, 'start-b')).sessionId;
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 35000, maxBuffer: 40 * 1024 * 1024 },
      );
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      return data.result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Local messages', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Other session').selectOption(b);
    await modal.getByRole('button', { name: 'Connect sessions', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Disconnect sessions' })).toBeVisible();
    await modal.getByLabel('Message', { exact: true }).fill('UI selected finding for B');
    await modal.getByRole('button', { name: 'Share message', exact: true }).click();
    await expect(modal.getByText('UI selected finding for B', { exact: true })).toBeVisible();
    expect(
      (await request(directory, 'status')).commands.filter((c: any) => c.operation === 'turn'),
    ).toHaveLength(0);
    await page.setViewportSize({ width: 800, height: 650 });
    expect(await modal.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    // Read the same durable exchange from the recipient's actual UI, not a fixture.
    const prefs = await request(directory, 'presentation/get');
    await request(directory, 'presentation/save', {
      expectedRevision: prefs.revision,
      value: { ...prefs.value, sessionId: b },
    });
    await page.reload();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Local messages', exact: true }).click();
    await expect(modal.getByText('UI selected finding for B', { exact: true })).toBeVisible();
    await modal.getByRole('button', { name: 'Ask Muse about this' }).click();
    await expect
      .poll(
        async () =>
          (await request(directory, 'status')).commands.find((c: any) => c.id.startsWith('relay_'))
            ?.status,
      )
      .toBe('applied');
    await modal.getByRole('button', { name: 'Refresh messages' }).click();
    await expect(modal.getByRole('button', { name: 'Check delivery' })).toBeVisible();
    await modal.getByLabel('Other session').selectOption(a);
    await modal.getByLabel('Message', { exact: true }).fill('B replies from its own session');
    await modal.getByRole('button', { name: 'Share message', exact: true }).click();
    await expect(
      modal.locator('.relay-messages').getByText('B replies from its own session', { exact: true }),
    ).toBeVisible();
    expect((await request(directory, 'relay/get', { sessionId: a })).messages).toHaveLength(2);
    await modal.getByRole('button', { name: 'Disconnect sessions' }).click();
    await expect(
      modal.getByRole('button', { name: 'Connect sessions', exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    const done = new Promise((r) => daemon.once('exit', r));
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      await done;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
