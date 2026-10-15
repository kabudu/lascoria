import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
test('Lascoria isolated task, context, direct tests, commit and archive through native bridge', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-ui-'));
  const source = join(root, 'source'),
    directory = join(root, 'state');
  await mkdir(source);
  await exec('git', ['init', '-q', source]);
  await exec('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  await exec('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(source, 'README.md'), 'Task context\n');
  await exec('git', ['-C', source, 'add', '.']);
  await exec('git', ['-C', source, 'commit', '-qm', 'Initial']);
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
    const bridge = resolve('src-tauri/target/debug/spatial-constellation-desktop');
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      const { stdout } = await exec(bridge, ['--bridge-json', JSON.stringify(input)], {
        env,
        timeout: 35000,
        maxBuffer: 40 * 1024 * 1024,
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
    const page = await context.newPage();
    await page.goto('/');
    await expect(page).toHaveTitle('Lascoria');
    await expect(page.getByRole('link', { name: 'Lascoria workspace' })).toBeVisible();
    await expect(page.locator('.wordmark')).toContainText('lascoria');
    await expect(
      page.getByRole('heading', { name: 'Give your agents room to work.' }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(
      await page
        .locator('.brand-mark')
        .evaluateAll((marks) =>
          marks.every(
            (mark) =>
              (mark as HTMLImageElement).complete && (mark as HTMLImageElement).naturalWidth > 0,
          ),
        ),
    ).toBe(true);
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.getByLabel('Workspace menu').click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.setViewportSize({ width: 800, height: 600 });
      await expect(
        page.getByRole('button', { name: 'Start your first session', exact: true }),
      ).toBeVisible();
      await expect(page.locator('.floating-panel')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: `test-results/lascoria-welcome-${theme}.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await page.getByRole('button', { name: 'Start your first session' }).click();
    await page.getByLabel('Existing repository path').fill(source);
    await expect(
      page.getByRole('checkbox', { name: 'Create an isolated task worktree' }),
    ).toBeChecked();
    await page.getByLabel('Initial task').fill('Describe this task');
    await page.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect
      .poll(
        async () => (await request(directory, 'status')).sessions[0]?.state.turns?.at(-1)?.terminal,
        { timeout: 25000 },
      )
      .toBe('completed');
    await expect(page.getByRole('heading', { name: 'source', exact: true })).toBeVisible();
    await page.getByText('Task label, notes and relationships', { exact: true }).click();
    await page.getByLabel('Session display label').fill('Lascoria interval planner');
    await expect(
      page.getByRole('heading', { name: 'Lascoria interval planner', exact: true }),
    ).toBeVisible();
    await page.getByText('Task label, notes and relationships', { exact: true }).click();
    await page.getByRole('tab', { name: 'workspace', exact: true }).click();
    await expect(page.getByRole('heading', { name: /lascoria\// })).toBeVisible();
    await page.getByRole('button', { name: 'README.md', exact: true }).click();
    await page.getByRole('button', { name: 'Add file to task draft' }).click();
    await expect(page.getByLabel('New task for this session')).toHaveValue(
      /Repository context: README.md/,
    );
    await page.getByRole('tab', { name: 'workspace', exact: true }).click();
    await page
      .getByLabel('Test command')
      .fill(`printf 'new file\n' > result.txt; printf 'PASS workspace\n'`);
    await page.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect(page.getByText('passed ·', { exact: false })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Refresh change preview' }).click();
    await expect(page.getByText('New files (1)', { exact: true })).toBeVisible();
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
    await page.getByRole('button', { name: 'Commit changes…', exact: true }).click();
    await page.getByLabel('Commit message').fill('Record task result');
    await page.getByRole('button', { name: 'Commit changes', exact: true }).click();
    await expect(page.getByText('New files (0)', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Archive session…', exact: true }).click();
    await page.getByRole('button', { name: 'Archive session', exact: true }).click();
    await expect(
      page.getByText('Archived. History is retained; execution is disabled.', { exact: true }),
    ).toBeVisible();
    await page.reload();
    await page.getByRole('tab', { name: 'workspace', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Run command', exact: true })).toBeDisabled();
    expect(await readFile(join(source, 'README.md'), 'utf8')).toBe('Task context\n');
  } finally {
    await context.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const done = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await done;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
