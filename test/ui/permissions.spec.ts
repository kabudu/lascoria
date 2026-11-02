import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
import { provider } from '../../testing/provider.js';
const exec = promisify(execFile);
test('session header permissions and model controls: native changes, cross-window stale review, defaults, reload and sandbox probe', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-permission-ui-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  const model = await provider(root, { permissionProbe: true, modelSettings: true });
  const env = {
    ...process.env,
    ...model.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'meta',
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
  let loseChangeReply = false;
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
      ).catch((e) => {
        if (e.code === 1 && e.stdout) return { stdout: e.stdout };
        throw e;
      });
      const data = JSON.parse(stdout);
      if (data.error) throw Error(data.error);
      if (input.operation === 'setPermissionProfile' && loseChangeReply) {
        loseChangeReply = false;
        throw Error('Synthetic reply loss after native commit');
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
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Permission profile', { exact: true })).toHaveValue(':ask-me');
    await dialog.getByLabel('Session name (optional)').fill('Permissions trial');
    await dialog.getByLabel('Existing repository path').fill(workspace);
    await dialog.getByRole('checkbox', { name: 'Create an isolated task worktree' }).uncheck();
    await dialog.getByLabel('Initial task').fill('Say ready');
    await dialog.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Session permissions', exact: true }),
    ).toContainText('Ask me');
    const status = () => request(directory, 'status');
    await expect
      .poll(async () => (await status()).sessions[0]?.state.turns?.at(-1)?.terminal)
      .toBe('completed');
    const sessionId = (await status()).sessions[0].id;
    // Both controls remain discoverable with the task inspector collapsed.
    const collapse = page.getByRole('button', {
      name: 'Collapse Task inspector panel',
      exact: true,
    });
    if (await collapse.count()) await collapse.click();
    await page.getByRole('button', { name: 'Session model and effort', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Session model and effort', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Session permissions', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('This session’s profile')).toBeEnabled();
    await dialog.getByLabel('This session’s profile').selectOption(':read-only');
    await dialog.getByRole('button', { name: 'Review profile change', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cancel change', exact: true }).click();
    expect(
      (await request(directory, 'permissions', { sessionId })).effective.permissionState.profileId,
    ).toBe(':ask-me');
    await dialog.getByRole('button', { name: 'Review profile change', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm permission change', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Session permissions', exact: true }),
    ).toContainText('Read-only');
    await expect(dialog.getByLabel('This session’s profile')).toBeEnabled();
    const a11y = await new AxeBuilder({ page })
      .include('dialog')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
    await page.screenshot({ path: '.dev/permissions-light-desktop.png' });
    // A change in another window invalidates a pending confirmation, including A-to-B-to-A transitions.
    await dialog.getByLabel('This session’s profile').selectOption(':ask-me');
    await dialog.getByRole('button', { name: 'Review profile change', exact: true }).click();
    let p = await request(directory, 'permissions', { sessionId });
    await request(
      directory,
      'setPermissionProfile',
      { sessionId, profileId: ':auto-review', expectedKey: p.effective.key, confirmed: true },
      'other-window-change',
    );
    await expect(
      dialog.getByRole('button', { name: 'Confirm permission change', exact: true }),
    ).toHaveCount(0);
    await expect(dialog).toContainText('Permissions changed while this panel was open');
    await expect(dialog.getByLabel('This session’s profile')).toHaveValue(':auto-review');
    await dialog.getByLabel('This session’s profile').selectOption(':ask-me');
    await dialog.getByRole('button', { name: 'Review profile change', exact: true }).click();
    loseChangeReply = true;
    await dialog.getByRole('button', { name: 'Confirm permission change', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Session permissions', exact: true }),
    ).toContainText('Ask me');
    await expect(dialog).toContainText('outcome is unknown');
    await expect(dialog.getByLabel('This session’s profile')).toBeEnabled();
    expect(
      (await status()).commands.filter(
        (c: any) => c.operation === 'setPermissionProfile' && c.params?.profileId === ':ask-me',
      ),
    ).toHaveLength(1);
    await dialog.getByText('Default for new sessions', { exact: true }).click();
    await dialog.getByLabel('Permission profile', { exact: true }).selectOption(':read-only');
    await dialog.getByRole('button', { name: 'Save new-session default', exact: true }).click();
    await expect(dialog).toContainText('Existing sessions keep their own permissions');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Session permissions', exact: true }),
    ).toContainText('Ask me');
    await page
      .getByRole('button', { name: 'Expand Sessions panel', exact: true })
      .click()
      .catch(() => {});
    await page.getByRole('button', { name: 'New session', exact: true }).click();
    await expect(
      page.getByRole('dialog').getByLabel('Permission profile', { exact: true }),
    ).toHaveValue(':read-only');
    await page.getByRole('button', { name: 'Project', exact: true }).click();
    await expect(
      page.getByRole('dialog').getByLabel('Permission profile', { exact: true }),
    ).toHaveValue(':read-only');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByRole('button', { name: 'Session permissions', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Review capability check', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: 'Review capability check', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('uses model allowance');
    await page.getByRole('button', { name: 'Run capability check', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const row = (await status()).sessions.find((r: any) => r.id === sessionId);
      for (const entry of row.state.approvals ?? []) {
        const choice = entry.requested.availableChoices.find(
          (c: any) => c.scope === 'once' && c.decision === 'approved',
        );
        expect(choice).toBeTruthy();
        await page.getByRole('button', { name: choice.label, exact: true }).click();
      }
      if (row.state.permissionProbe?.observed && !row.state.activeTurnId) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.getByRole('button', { name: 'Session permissions', exact: true }).click();
    await expect(
      page.getByRole('region', { name: 'Last capability check', exact: true }),
    ).toContainText('Inspect own process');
    await expect(
      page.getByRole('region', { name: 'Last capability check', exact: true }),
    ).not.toContainText('No matching completed');
    await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await page.getByLabel('Workspace menu', { exact: true }).click();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.setViewportSize({ width: 820, height: 900 });
    for (const name of ['Session model and effort', 'Session permissions']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toBeInViewport();
      await button.click({ trial: true });
    }
    await page.screenshot({ path: '.dev/permissions-header-narrow.png', fullPage: true });
    await page.getByRole('button', { name: 'Session permissions', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('This session’s profile')).toBeEnabled();
    await page.screenshot({ path: '.dev/permissions-dark-narrow.png', fullPage: true });
    const darkA11y = await new AxeBuilder({ page })
      .include('dialog')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(darkA11y.violations).toEqual([]);
    const bounds = await page
      .getByRole('dialog')
      .evaluate((e) => ({ client: e.clientWidth, scroll: e.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    expect((await status()).commands.some((c: any) => c.operation === 'workspace/run')).toBe(false);
  } finally {
    await context.close();
    if (daemon.exitCode === null) {
      const done = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await done;
    }
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
