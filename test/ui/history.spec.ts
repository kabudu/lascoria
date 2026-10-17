import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

test('history search finds archived work and continuation starts once, linked both ways', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-history-'));
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
    const old = (
      await request(directory, 'start', { workspace, name: 'Retry planning' }, 'start-plan')
    ).sessionId;
    await expect
      .poll(async () => (await request(directory, 'status')).sessions[0]?.state.current)
      .toBe(true);
    await request(directory, 'turn', { sessionId: old, text: 'Plan the flaky retry loop' }, 'plan');
    await expect
      .poll(
        async () => (await request(directory, 'status')).sessions[0]?.state.turns?.at(-1)?.terminal,
      )
      .toBe('completed');
    await request(directory, 'session/archive', { sessionId: old }, 'archive-plan');
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Search history', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Search messages').fill('FLAKY retry');
    const results = dialog.getByRole('list', { name: 'Search results' });
    await expect(results.getByRole('button').first()).toBeVisible();
    await expect(results).toContainText('Archived');
    await expect(results).toContainText('flaky retry loop');
    await dialog.getByLabel('Search messages').fill('no such words anywhere');
    await expect(dialog.getByRole('status')).toContainText('No matching messages.');
    await dialog.getByLabel('Search messages').fill('flaky');
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await results.getByRole('button').first().click();
    await expect(page.getByRole('heading', { name: 'Retry planning', exact: true })).toBeVisible();
    const turns = (await request(directory, 'status')).commands.filter(
      (c: any) => c.operation === 'turn',
    ).length;
    await page.getByRole('button', { name: 'Continue in a new session', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Retry planning (continued)', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Continues archived work from Retry planning')).toBeVisible();
    const snapshot = await request(directory, 'status');
    const next = snapshot.sessions.find((s: any) => s.continuedFrom === old);
    expect(next.lifecycle).not.toBe('archived');
    expect(snapshot.sessions.find((s: any) => s.id === old).lifecycle).toBe('archived');
    // Continuing starts no model work by itself.
    expect(snapshot.commands.filter((c: any) => c.operation === 'turn')).toHaveLength(turns);
    await page.getByRole('button', { name: 'View archive', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Retry planning', exact: true })).toBeVisible();
    // A second continuation is not offered by accident.
    await expect(page.getByRole('button', { name: 'Continue in a new session' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Open continued session', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Retry planning (continued)', exact: true }),
    ).toBeVisible();
    await expect(
      request(directory, 'start', { workspace, continuedFrom: next.id }, 'continue-live'),
    ).rejects.toThrow(/Only archived sessions can be continued/);
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
