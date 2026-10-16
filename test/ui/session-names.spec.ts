import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

test('named standalone session lifecycle: creation, conflicting rename, lost reply and reload', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-names-'));
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
  let loseNameReply = false;
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
        // The diagnostic CLI exits 1 for a structured bridge rejection.
        if (error.code === 1 && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      if (input.operation === 'session/rename' && loseNameReply) {
        loseNameReply = false;
        throw new Error('Synthetic lost rename reply after commit');
      }
      return data.result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Start your first session', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Session name (optional)').fill('  Interval planner  ');
    await dialog.getByLabel('Existing repository path').fill(workspace);
    await dialog.getByRole('checkbox', { name: 'Create an isolated task worktree' }).uncheck();
    await dialog.getByLabel('Initial task').fill('Say ready');
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Interval planner', exact: true }),
    ).toBeVisible();
    await expect
      .poll(
        async () => (await request(directory, 'status')).sessions[0]?.state.turns?.at(-1)?.terminal,
      )
      .toBe('completed');
    let snapshot = await request(directory, 'status');
    const id = snapshot.sessions[0].id;
    const originalWorkspace = snapshot.sessions[0].workspace;
    const duplicate = (
      await request(directory, 'start', { workspace, name: 'Interval planner' }, 'duplicate')
    ).sessionId;
    await expect
      .poll(async () => (await request(directory, 'status')).sessions[0].state.activeTurnId ?? null)
      .toBeNull();
    const turns = (await request(directory, 'status')).commands.filter(
      (c: any) => c.operation === 'turn',
    ).length;
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    await dialog.getByLabel('Session name', { exact: true }).fill('My retained edit');
    const other = await context.newPage();
    await other.goto('/');
    await other.getByRole('button', { name: 'Rename session', exact: true }).click();
    await other
      .getByRole('dialog')
      .getByLabel('Session name', { exact: true })
      .fill('Other window name');
    await other.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(other.getByRole('dialog')).not.toBeVisible();
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog.getByRole('region', { name: 'Session name conflict' })).toContainText(
      'Other window name',
    );
    await expect(dialog.getByLabel('Session name', { exact: true })).toHaveValue(
      'My retained edit',
    );
    await dialog.getByRole('button', { name: 'Keep my edit', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'My retained edit', exact: true }),
    ).toBeVisible();
    await other.close();
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    await dialog.getByLabel('Session name', { exact: true }).fill('Final name');
    loseNameReply = true;
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('lost rename reply');
    await dialog.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    snapshot = await request(directory, 'status');
    expect(snapshot.sessions.find((s: any) => s.id === id)).toMatchObject({
      displayName: 'Final name',
      nameRevision: 3,
      workspace: originalWorkspace,
    });
    expect(snapshot.commands.filter((c: any) => c.operation === 'turn')).toHaveLength(turns);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Final name', exact: true })).toBeVisible();
    if (await page.getByRole('button', { name: 'Expand Sessions panel', exact: true }).count())
      await page.getByRole('button', { name: 'Expand Sessions panel', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button')
      .filter({ hasText: duplicate.slice(-8) })
      .click();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Local messages', exact: true }).click();
    await expect(
      dialog.getByLabel('Other session').locator('option').filter({ hasText: 'Final name' }),
    ).toHaveCount(1);
    await expect(
      dialog.getByLabel('Other session').locator('option').filter({ hasText: 'Final name' }),
    ).toContainText(id.slice(-8));
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await page
      .getByRole('navigation', { name: 'Sessions' })
      .getByRole('button')
      .filter({ hasText: id.slice(-8) })
      .click();
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    await dialog.getByLabel('Session name', { exact: true }).fill('Cancelled edit');
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    expect(
      (await request(directory, 'status')).sessions.find((s: any) => s.id === id).displayName,
    ).toBe('Final name');
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    await expect(dialog.getByLabel('Session name', { exact: true })).toHaveValue('Final name');
    await page.setViewportSize({ width: 800, height: 650 });
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await dialog.getByLabel('Session name', { exact: true }).fill('');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'workspace', exact: true })).toBeVisible();
    expect(
      (await request(directory, 'status')).sessions.find((s: any) => s.id === id).displayName,
    ).toBe('');
    const longName = 'W'.repeat(100);
    await request(
      directory,
      'session/rename',
      { sessionId: id, name: longName, expectedRevision: 4 },
      'long-name',
    );
    await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
    const titleBox = await page
      .locator('.workspace-title')
      .getByRole('button', { name: 'New session', exact: true })
      .boundingBox();
    expect(titleBox!.x + titleBox!.width).toBeLessThanOrEqual(800);
    expect(
      await page
        .getByRole('navigation', { name: 'Sessions' })
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    expect(
      await page
        .locator('.attention-row')
        .evaluateAll((rows) => rows.every((e) => e.scrollWidth <= e.clientWidth + 1)),
    ).toBe(true);
    await expect(page.locator('.session-target')).toContainText(longName);
    expect(
      await page.locator('.session-target').evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
    await page.getByRole('button', { name: 'Session model & effort', exact: true }).click();
    await expect(dialog.locator('.settings-summary')).toContainText(longName);
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
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
