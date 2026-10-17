import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

test('data lifecycle: backup with lost reply, export/import, cleanup and restore after restart', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-data-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'workspace'),
    outside = join(root, 'exports');
  await mkdir(workspace);
  await mkdir(outside);
  const exported = join(outside, 'lascoria-backup.sqlite');
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  const boot = () =>
    spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env,
      stdio: 'ignore',
    });
  const ready = async (child: ChildProcess) =>
    expect
      .poll(async () => {
        try {
          return (await request(directory, 'status')).pid;
        } catch {
          return 0;
        }
      })
      .toBe(child.pid);
  const stop = async (child: ChildProcess) => {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      await stopped;
    }
  };
  let daemon = boot();
  const context = await browser.newContext();
  let loseBackupReply = false;
  try {
    await ready(daemon);
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      if (command === 'pick_backup_destination') return exported;
      if (command === 'pick_backup_file') return exported;
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
      if (input.operation === 'data/backup' && loseBackupReply) {
        loseBackupReply = false;
        throw new Error('Synthetic lost backup reply after commit');
      }
      return data.result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });

    const old = (await request(directory, 'start', { workspace, name: 'Old plan' }, 'start-old'))
      .sessionId;
    await expect
      .poll(async () => (await request(directory, 'status')).sessions[0]?.state.current)
      .toBe(true);
    await request(directory, 'session/archive', { sessionId: old }, 'archive-old');
    const live = (await request(directory, 'start', { workspace, name: 'Current' }, 'start-live'))
      .sessionId;

    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Data & backups', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const panel = dialog.getByRole('region', { name: 'Data and backups' });
    await expect(panel).toContainText('2 of 100');
    await expect(panel).toContainText('No backups yet.');

    // A lost reply after the backup committed: retry reuses the identity, one backup results.
    loseBackupReply = true;
    await panel.getByRole('button', { name: 'Back up now', exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('lost backup reply');
    await panel.getByRole('button', { name: 'Back up now', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Backup saved.');
    expect((await request(directory, 'data/summary')).backups).toHaveLength(1);

    await panel.getByRole('button', { name: /^Export backup from/ }).click();
    await expect(panel.getByRole('status')).toContainText('Exported to');
    expect((await stat(exported)).size).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Import backup…', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Backup imported');
    await expect(panel.getByRole('list', { name: 'Backups' }).getByRole('listitem')).toHaveCount(2);

    // Removing asks first, offers a safe way out and keeps the live session.
    await panel.getByRole('checkbox', { name: /Old plan/ }).check();
    await panel.getByRole('button', { name: 'Remove selected…', exact: true }).click();
    await expect(panel.getByRole('alertdialog')).toContainText(
      'Task folders on disk are not deleted',
    );
    await page.setViewportSize({ width: 800, height: 650 });
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await panel.getByRole('button', { name: 'Keep sessions', exact: true }).click();
    expect((await request(directory, 'status')).sessions).toHaveLength(2);
    await panel.getByRole('button', { name: 'Remove selected…', exact: true }).click();
    await panel.getByRole('button', { name: 'Remove sessions', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('Removed 1 session.');
    let snapshot = await request(directory, 'status');
    expect(snapshot.sessions.map((s: any) => s.id)).toEqual([live]);
    await expect(panel).toContainText('No archived sessions.');
    // A late retry against removed history is refused rather than replayed.
    await expect(
      request(directory, 'session/archive', { sessionId: old }, 'archive-old'),
    ).rejects.toThrow(/Unknown session|compacted history/);

    // Restore the automatic pre-cleanup backup; it applies on the next supervisor start.
    await panel
      .getByRole('button', { name: /^Restore backup from/ })
      .first()
      .click();
    await expect(panel.getByRole('alertdialog')).toContainText('billing choice stay');
    await panel.getByRole('button', { name: 'Prepare restore', exact: true }).click();
    await expect(panel).toContainText('Restore ready.');
    expect((await request(directory, 'status')).sessions).toHaveLength(1);
    await stop(daemon);
    daemon = boot();
    await ready(daemon);
    snapshot = await request(directory, 'status');
    expect(snapshot.sessions.map((s: any) => s.id).sort()).toEqual([old, live].sort());
    expect(snapshot.sessions.find((s: any) => s.id === old).lifecycle).toBe('archived');
    const summary = await request(directory, 'data/summary');
    expect(summary.lastRestore.status).toBe('restored');
    expect(summary.pendingRestore).toBeNull();
    expect(summary.backups.some((b: any) => b.reason === 'beforeRestore')).toBe(true);
    await page.reload();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Data & backups', exact: true }).click();
    await expect(panel).toContainText('Last restore completed');
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  } finally {
    await context.close();
    await stop(daemon);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
