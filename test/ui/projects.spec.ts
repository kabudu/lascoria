import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

test('Projects: reorder, save, concurrent edits, native start and narrow layout', async ({
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
  const lostReplies = new Set(['project/save', 'start', 'turn']);
  let releaseSave = () => {};
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let releasePicker = () => {};
  const pickerGate = new Promise<void>((resolve) => {
    releasePicker = resolve;
  });
  let releaseLatePicker = () => {};
  const latePickerGate = new Promise<void>((resolve) => {
    releaseLatePicker = resolve;
  });
  let pickerCalls = 0;
  const second = join(root, 'api');
  await mkdir(second);
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
      // The OS chooser itself is native acceptance; the rest uses the real Rust bridge.
      if (command === 'pick_workspace_folder') {
        pickerCalls++;
        if (pickerCalls === 1) {
          await pickerGate;
          return null;
        }
        if (pickerCalls === 2) throw new Error('Synthetic picker unavailable');
        if (pickerCalls === 6) {
          await latePickerGate;
          return second;
        }
        return pickerCalls === 5 ? second : workspace;
      }
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      if (input.operation === 'project/save' && lostReplies.has('project/save')) await saveGate;
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
      if (lostReplies.delete(input.operation))
        throw new Error(`Synthetic lost ${input.operation} reply after commit`);
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
    await dialog.getByLabel('Existing repository path').fill('keep my typed path');
    await dialog.getByRole('button', { name: 'Browse for repository', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Start session', exact: true })).toBeDisabled();
    await expect(
      dialog.getByRole('button', { name: 'Browse for repository', exact: true }),
    ).toBeDisabled();
    releasePicker();
    await expect(dialog.getByLabel('Existing repository path')).toBeEnabled();
    await expect(dialog.getByLabel('Existing repository path')).toHaveValue('keep my typed path');
    await dialog.getByRole('button', { name: 'Browse for repository', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('enter the full path');
    await expect(dialog.getByLabel('Existing repository path')).toHaveValue('keep my typed path');
    await dialog.getByRole('button', { name: 'Browse for repository', exact: true }).click();
    await expect(dialog.getByLabel('Existing repository path')).toHaveValue(workspace);
    expect((await request(directory, 'status')).sessions).toHaveLength(0);
    expect((await request(directory, 'project/list')).projects).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Project', exact: true }).click();
    await expect(
      dialog.getByRole('button', { name: 'Reload saved project', exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByLabel('Saved project', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Project name', { exact: true }).fill('Cross-folder planner');
    await dialog.getByRole('button', { name: 'Browse for folder 1', exact: true }).click();
    await expect(dialog.getByLabel('Full folder path')).toHaveValue(workspace);
    await dialog.getByRole('button', { name: 'Add folder', exact: true }).click();
    await dialog.getByLabel('Folder name', { exact: true }).nth(1).fill('API');
    await dialog.getByRole('button', { name: 'Browse for folder 2', exact: true }).click();
    await expect(dialog.getByLabel('Full folder path').nth(1)).toHaveValue(second);
    expect((await request(directory, 'project/list')).projects).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Move API up', exact: true }).click();
    await expect(dialog.getByLabel('Folder name', { exact: true }).first()).toHaveValue('API');
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(dialog.getByText('Saving project…', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Retry exact request', exact: true }),
    ).toHaveCount(0);
    releaseSave();
    await expect(dialog.getByRole('alert')).toContainText('lost project/save reply');
    await dialog.getByRole('button', { name: 'Retry exact request', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('revision 1');
    const project = (await request(directory, 'project/list')).projects[0];
    await request(
      directory,
      'project/save',
      { id: project.id, name: 'Other window', expectedRevision: 1, folders: project.folders },
      'concurrent-project',
    );
    await dialog.getByLabel('Project name', { exact: true }).fill('My local edit');
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Project changed');
    await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('My local edit');
    await dialog.getByRole('button', { name: 'Review before editing', exact: true }).click();
    await dialog.getByRole('button', { name: 'Reload saved project', exact: true }).click();
    await expect(dialog.getByLabel('Project name', { exact: true })).toHaveValue('Other window');
    const longName = 'W'.repeat(100),
      longAlias = 'Z'.repeat(100);
    await dialog.getByLabel('Project name', { exact: true }).fill(longName);
    await dialog.getByLabel('Folder name', { exact: true }).first().fill(longAlias);
    await dialog.getByRole('button', { name: 'Save project', exact: true }).click();
    await expect(dialog.getByRole('status')).toContainText('revision 3');
    await page.setViewportSize({ width: 800, height: 700 });
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    const axe = await new AxeBuilder({ page }).include('dialog').analyze();
    expect(axe.violations).toEqual([]);
    await dialog.getByLabel('Project task', { exact: true }).fill('Confirm both roots');
    await dialog.getByRole('button', { name: 'Start project session', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('lost start reply');
    await dialog.getByRole('button', { name: 'Retry exact request', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('lost turn reply');
    await dialog.getByRole('button', { name: 'Retry exact request', exact: true }).click();
    await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
    await expect
      .poll(
        async () => (await request(directory, 'status')).sessions[0]?.state.turns?.at(-1)?.terminal,
      )
      .toBe('completed');
    await page.locator('.project-context summary').click();
    await expect(page.locator('.project-context')).toContainText(`${longAlias} (default)`);
    await expect(page.locator('.project-context')).toContainText('revision 3');
    expect(
      await page.locator('.project-context-popover').evaluate((e) => {
        const r = e.getBoundingClientRect();
        return e.scrollWidth <= e.clientWidth + 1 && r.left >= 0 && r.right <= innerWidth;
      }),
    ).toBe(true);
    expect(
      await page
        .locator('.project-context code')
        .first()
        .evaluate((el) => {
          const rect = el.getBoundingClientRect();
          return !!document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('.project-context');
        }),
    ).toBe(true);
    await page.getByRole('button', { name: 'Rename session', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Rename session', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.locator('.project-context summary').click();
    await page.getByRole('button', { name: 'Expand canvas controls', exact: true }).click();
    expect(
      await page.getByLabel('Search tasks', { exact: true }).evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return !!document
          .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          ?.closest('.surface-toolbar');
      }),
    ).toBe(true);
    // Expanded controls must never cover the session heading or its actions.
    for (const width of [1440, 1100, 1000, 800, 620, 480]) {
      await page.setViewportSize({ width, height: 800 });
      expect(
        await page.locator('.workspace-title').evaluate((heading) => {
          const b = document.querySelector('.surface-toolbar')!.getBoundingClientRect();
          return [...heading.children].every((child) => {
            const a = child.getBoundingClientRect();
            return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
          });
        }),
      ).toBe(true);
      for (const control of [
        page.getByRole('button', { name: 'New session', exact: true }),
        page.getByLabel('Search tasks', { exact: true }),
      ]) {
        expect(
          await control.evaluate((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.left >= 0 &&
              r.right <= innerWidth &&
              !!document
                .elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
                ?.closest(el.tagName.toLowerCase())
                ?.isSameNode(el)
            );
          }),
        ).toBe(true);
      }
    }
    await page.setViewportSize({ width: 800, height: 700 });
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse canvas controls', exact: true }).click();
    // The collapsed choice is saved before reloading, so the reload cannot race the save.
    await expect
      .poll(
        async () =>
          ((await request(directory, 'presentation/get')) as any)?.value?.canvasControlsCollapsed,
      )
      .toBe(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
    const final = await request(directory, 'status');
    expect(final.sessions).toHaveLength(1);
    expect(final.commands.filter((c: any) => c.operation === 'turn')).toHaveLength(1);
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await dialog.getByRole('button', { name: 'Project', exact: true }).click();
    await dialog.getByRole('button', { name: 'Browse for folder 1', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Save project', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Add folder', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Session', exact: true }).click();
    await dialog.getByRole('button', { name: 'Project', exact: true }).click();
    releaseLatePicker();
    await expect(dialog.getByLabel('Full folder path')).toHaveValue('');
    expect((await request(directory, 'status')).sessions).toHaveLength(1);
  } finally {
    releasePicker();
    releaseLatePicker();
    releaseSave();
    await context.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
