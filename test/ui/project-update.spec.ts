import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

// R15: an edited Project reaches an existing session only with a task the user starts.
test('Project folder changes are offered for the next task and applied through the native bridge', async ({
  browser,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-pupd-')));
  const directory = join(root, 'state');
  const [app, api, docs] = ['app', 'api', 'docs'].map((name) => join(root, name));
  for (const dir of [app, api, docs]) await mkdir(dir);
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
  const status = () => request(directory, 'status');
  // Settled: the expected number of tasks finished and no command is still being sent.
  const settled = (count: number) =>
    expect
      .poll(async () => {
        const snapshot = await status();
        const s = snapshot.sessions[0];
        return (
          !s?.state.activeTurnId &&
          !snapshot.commands.some((c: any) => c.status === 'sending') &&
          s.state.turns?.filter((t: any) => t.terminal === 'completed').length === count
        );
      })
      .toBe(true);
  try {
    await expect
      .poll(async () => {
        try {
          return (await status()).pid;
        } catch {
          return 0;
        }
      })
      .toBe(daemon.pid);
    const folders = {
      app: { id: randomUUID(), name: 'App', path: app },
      api: { id: randomUUID(), name: 'API', path: api },
      docs: { id: randomUUID(), name: 'Docs', path: docs },
    };
    const project = { id: randomUUID(), name: 'Shop' };
    const save = (expectedRevision: number, list: object[], id: string) =>
      request(directory, 'project/save', { ...project, expectedRevision, folders: list }, id);
    await save(0, [folders.app, folders.api], 'save-1');
    const { sessionId } = await request(
      directory,
      'start',
      { projectId: project.id, projectRevision: 1, name: 'Shop work' },
      'start-1',
    );
    await request(directory, 'turn', { sessionId, text: 'First task' }, 'task-1');
    await settled(1);

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
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Shop work', exact: true })).toBeVisible();
    const offer = page.getByRole('group', { name: 'Project folder changes' });
    await expect(offer).toHaveCount(0);

    // Saving elsewhere shows the change; nothing is applied yet.
    await save(1, [folders.app, folders.api, folders.docs], 'save-2');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(offer).toContainText('Shop changed');
    await expect(offer).toContainText('added Docs');
    expect((await status()).sessions[0].projectContext.revision).toBe(1);
    expect((await new AxeBuilder({ page }).include('form').analyze()).violations).toEqual([]);

    // An unticked task keeps the current folders.
    const composer = page.getByRole('textbox', { name: 'New task for this session', exact: true });
    await composer.fill('Plain task');
    await page.getByRole('button', { name: 'Start turn', exact: true }).click();
    await settled(2);
    expect((await status()).sessions[0].projectContext.revision).toBe(1);
    await expect(offer).toBeVisible();

    const use = offer.getByRole('checkbox', { name: /Use the updated folders/ });
    await use.check();
    await composer.fill('Include the docs');
    await page.getByRole('button', { name: 'Start turn', exact: true }).click();
    await settled(3);
    // The transcript shows what the user typed; Lascoria's note is only for Muse. (The echo
    // provider's own reply repeats the whole model input, so only the user item is checked.)
    await expect(
      page.locator('.transcript-item pre').filter({ hasText: /^Include the docs$/ }),
    ).toHaveCount(1);
    let session = (await status()).sessions[0];
    expect(session.projectContext.revision).toBe(2);
    expect(session.projectContext.folders.map((f: any) => f.name)).toEqual(['App', 'API', 'Docs']);
    expect(session.projectContextReceipt.appliedWith).toBe('turn');
    const applying = (await status()).commands.find(
      (c: any) => c.operation === 'turn' && c.params.projectRevision === 2,
    );
    expect(['applied', 'accepted']).toContain(applying?.status);
    expect(applying.params.text).toBe('Include the docs');
    await expect(offer).toHaveCount(0);
    await page.locator('.project-context summary').click();
    await expect(page.locator('.project-context')).toContainText('Applied with a later task');
    await expect(page.locator('.project-context')).toContainText('3 folders');
    await page.locator('.project-context summary').click();

    // Snapshots belong to one chosen folder: API's change is captured, App is not included.
    await exec('git', ['init', '-q'], { cwd: api });
    await writeFile(join(api, 'routes.txt'), 'api change\n');
    await exec('git', ['add', '.'], { cwd: api });
    await exec(
      'git',
      ['-c', 'user.name=QA', '-c', 'user.email=qa@example.test', 'commit', '-qm', 'init'],
      { cwd: api },
    );
    await writeFile(join(api, 'routes.txt'), 'api change, edited\n');
    await page.getByRole('tab', { name: /^diff$/i }).click();
    await page.locator('.snapshot-folder select').selectOption({ label: 'API' });
    await page.getByRole('button', { name: 'Save snapshot', exact: true }).click();
    await expect(page.locator('.revision-badge')).toContainText('Folder: API');
    await expect(page.locator('.diff-review')).toContainText('routes.txt');
    const snapshot = (await request(directory, 'review/list', {
      sessionId: (await status()).sessions[0].id,
    })) as any;
    expect(snapshot.artifacts.at(-1).folder.name).toBe('API');
    await page.getByRole('tab', { name: /^transcript$/i }).click();

    // A new default folder cannot be applied to this session.
    await save(2, [folders.api, folders.app, folders.docs], 'save-3');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(offer).toContainText('new order');
    await expect(offer).toContainText('can only be used by a new session');
    await expect(offer.getByRole('checkbox')).toHaveCount(0);
    await page.setViewportSize({ width: 800, height: 700 });
    expect(await offer.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    session = (await status()).sessions[0];
    expect(session.projectContext.revision).toBe(2);
    expect((await status()).commands.filter((c: any) => c.operation === 'turn')).toHaveLength(3);
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
