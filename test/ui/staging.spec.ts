import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

const lines = (n: number, changed: number[] = []) =>
  Array.from({ length: n }, (_, i) =>
    changed.includes(i + 1) ? `line ${i + 1} edited\n` : `line ${i + 1}\n`,
  ).join('');
// `*` and `"` are not valid Windows file names; elsewhere they test literal pathspecs.
const unix = process.platform !== 'win32';

test('Selective file and hunk staging commits only the index, refuses stale views and keeps Project folders apart', async ({
  browser,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-staging-')));
  const directory = join(root, 'state');
  const [app, api] = ['app', 'api'].map((name) => join(root, name));
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout;
  for (const [dir, files] of [
    [
      app,
      {
        'a.txt': lines(30),
        'b.txt': 'b\n',
        'space name.txt': lines(12),
        '-dash.txt': 'dash\n',
        'x.txt': 'x\n',
        ...(unix ? { '*.txt': 'star\n' } : {}),
      },
    ],
    [api, { 'same.txt': lines(8) }],
  ] as const) {
    await mkdir(dir);
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.name', 'Fixture');
    await git(dir, 'config', 'user.email', 'fixture@example.invalid');
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'init');
  }
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
    const folders = [
      { id: randomUUID(), name: 'App', path: app },
      { id: randomUUID(), name: 'API', path: api },
    ];
    const project = { id: randomUUID(), name: 'Shop' };
    await request(
      directory,
      'project/save',
      { ...project, expectedRevision: 0, folders },
      'save-1',
    );
    const { sessionId } = await request(
      directory,
      'start',
      { projectId: project.id, projectRevision: 1, isolated: true, name: 'Staging work' },
      'start-1',
    );
    await request(directory, 'turn', { sessionId, text: 'First task' }, 'task-1');
    await expect
      .poll(async () => {
        const snapshot = await status();
        const s = snapshot.sessions[0];
        return (
          !s?.state.activeTurnId &&
          !snapshot.commands.some((c: any) => c.status === 'sending') &&
          s.state.turns?.some((t: any) => t.terminal === 'completed')
        );
      })
      .toBe(true);
    const managed = (await status()).sessions[0].managedWorkspaces;
    const appTree = managed.find((m: any) => m.folderId === folders[0].id).path;
    const apiTree = managed.find((m: any) => m.folderId === folders[1].id).path;
    const branch = managed[0].branch;

    // What Muse might leave behind: separate hunks, a pre-staged file with later edits, new
    // files and awkward names, plus an unrelated change in the other Project folder.
    await writeFile(join(appTree, 'a.txt'), lines(30, [2, 28]));
    await writeFile(join(appTree, 'b.txt'), 'b staged before\n');
    await git(appTree, 'add', 'b.txt');
    await writeFile(join(appTree, 'b.txt'), 'b staged before\nand edited after\n');
    await writeFile(join(appTree, 'space name.txt'), lines(12, [1, 11]));
    await writeFile(join(appTree, '-dash.txt'), 'dash edited\n');
    await writeFile(join(appTree, 'x.txt'), 'x edited\n');
    await writeFile(join(appTree, 'new file.txt'), 'brand new\n');
    if (unix) await writeFile(join(appTree, '*.txt'), 'star edited\n');
    await writeFile(join(apiTree, 'same.txt'), lines(8, [4]));

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
    await expect(page.getByRole('heading', { name: 'Staging work', exact: true })).toBeVisible();
    // The canvas stays quiet: nothing about staging appears until the Workspace tab opens.
    await expect(page.getByRole('heading', { name: 'Stage and commit' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'workspace', exact: true }).click();
    const staging = page.locator('section.staging');
    const notStaged = staging.getByRole('group', { name: /^Not staged/ });
    const staged = staging.getByRole('group', { name: /^Staged/ });
    const unstagedCount = unix ? 7 : 6;
    await expect(
      notStaged.getByRole('heading', { name: `Not staged (${unstagedCount})` }),
    ).toBeVisible();
    await expect(staged.getByRole('heading', { name: 'Staged (1)' })).toBeVisible();
    await expect(staged).toContainText('b.txt');
    await expect(notStaged).toContainText('b.txt');

    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.getByLabel('Workspace menu').click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const width of [1440, 820]) {
        await page.setViewportSize({ width, height: 1000 });
        await notStaged.getByText('2 hunks in a.txt').click();
        await expect(
          notStaged.getByRole('checkbox', { name: 'Stage hunk 2 of a.txt' }),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(
          (
            await new AxeBuilder({ page })
              .include('section.staging')
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        await page.screenshot({ path: `test-results/staging-${theme}-${width}.png` });
        await notStaged.getByText('2 hunks in a.txt').click();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();

    // One hunk of a.txt, one hunk of `space name.txt` and several whole files, in one go.
    await notStaged.getByText('2 hunks in a.txt').click();
    await expect(
      notStaged.locator('li', { hasText: '2 hunks in a.txt' }).locator('.staging-hunk').first(),
    ).toContainText('+line 2 edited');
    await notStaged.getByRole('checkbox', { name: 'Stage hunk 1 of a.txt' }).check();
    await notStaged.getByText('2 hunks in space name.txt').click();
    await notStaged.getByRole('checkbox', { name: 'Stage hunk 2 of space name.txt' }).check();
    await notStaged.getByRole('checkbox', { name: 'Stage all of new file.txt' }).check();
    // Keyboard: Space toggles a file, Enter on the action stages the selection.
    const dash = notStaged.getByRole('checkbox', { name: 'Stage all of -dash.txt' });
    await dash.focus();
    await page.keyboard.press('Space');
    await expect(dash).toBeChecked();
    if (unix) await notStaged.getByRole('checkbox', { name: 'Stage all of *.txt' }).check();
    const selectedCount = unix ? 5 : 4;
    const stageSelected = notStaged.getByRole('button', {
      name: `Stage selected (${selectedCount})`,
    });
    await stageSelected.focus();
    await page.keyboard.press('Enter');
    await expect(
      staged.getByRole('heading', { name: unix ? 'Staged (6)' : 'Staged (5)' }),
    ).toBeVisible();
    const cached = (await git(appTree, 'diff', '--cached', '--name-only', '-z')).split('\0');
    for (const name of ['a.txt', 'b.txt', 'space name.txt', '-dash.txt', 'new file.txt'])
      expect(cached).toContain(name);
    if (unix) expect(cached).toContain('*.txt');
    expect(cached).not.toContain('x.txt');
    const left = await git(appTree, 'diff', '--', 'a.txt');
    expect(left).toContain('+line 28 edited');
    expect(left).not.toContain('+line 2 edited');

    // Unstage a whole file again.
    await staged.getByRole('checkbox', { name: 'Unstage all of -dash.txt' }).check();
    await staged.getByRole('button', { name: 'Unstage selected (1)' }).click();
    await expect(notStaged).toContainText('-dash.txt');
    expect(await git(appTree, 'diff', '--cached', '--name-only')).not.toContain('-dash.txt');

    // An edit made after the view loaded: the action is refused and nothing is staged.
    await notStaged.getByRole('checkbox', { name: 'Stage all of -dash.txt' }).check();
    await writeFile(join(appTree, 'x.txt'), 'x edited again elsewhere\n');
    await notStaged.getByRole('button', { name: 'Stage selected (1)' }).click();
    await expect(staging.getByRole('alert')).toContainText('changed since this view was loaded');
    expect(await git(appTree, 'diff', '--cached', '--name-only')).not.toContain('-dash.txt');
    // The refreshed view keeps the selection; staging it now succeeds.
    await expect(notStaged.getByRole('checkbox', { name: 'Stage all of -dash.txt' })).toBeChecked();
    await notStaged.getByRole('button', { name: 'Stage selected (1)' }).click();
    await expect(staged).toContainText('-dash.txt');
    await expect(staging.getByRole('alert')).toHaveCount(0);

    // Commit preview shows the exact staged content; an index change from another Git
    // client makes it stale, and the commit is refused.
    await staging.getByRole('button', { name: 'Commit staged changes…' }).click();
    const form = staging.locator('form.decision');
    await expect(form.locator('pre')).toContainText('+line 2 edited');
    await expect(form.locator('pre')).not.toContainText('line 28 edited');
    await expect(form.locator('pre')).not.toContainText('x edited');
    await form.getByLabel('Commit message').fill('Selected work');
    await git(appTree, 'add', 'x.txt');
    const headBefore = (await git(appTree, 'rev-parse', 'HEAD')).trim();
    await form.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(staging.getByRole('alert')).toContainText('Nothing was committed');
    expect((await git(appTree, 'rev-parse', 'HEAD')).trim()).toBe(headBefore);
    await staged.getByRole('checkbox', { name: 'Unstage all of x.txt' }).check();
    await staged.getByRole('button', { name: 'Unstage selected (1)' }).click();
    await expect(staged).not.toContainText('x.txt');
    await staging.getByRole('button', { name: 'Commit staged changes…' }).click();
    await form.getByLabel('Commit message').fill('Selected work');
    await form.getByRole('button', { name: 'Commit staged changes', exact: true }).click();
    await expect(staged.getByRole('heading', { name: 'Staged (0)' })).toBeVisible();
    await expect(staged).toContainText('Nothing staged yet.');
    expect((await git(appTree, 'log', '-1', '--format=%s')).trim()).toBe('Selected work');
    expect(await git(appTree, 'show', 'HEAD:a.txt')).toBe(lines(30, [2]));
    expect(await git(appTree, 'show', 'HEAD:space name.txt')).toBe(lines(12, [11]));
    expect(await git(appTree, 'show', 'HEAD:b.txt')).toBe('b staged before\n');
    expect(await git(appTree, 'show', 'HEAD:x.txt')).toBe('x\n');
    // Every unselected edit is still in the worktree, unstaged.
    expect(await readFile(join(appTree, 'a.txt'), 'utf8')).toBe(lines(30, [2, 28]));
    expect(await readFile(join(appTree, 'b.txt'), 'utf8')).toBe(
      'b staged before\nand edited after\n',
    );
    expect(await readFile(join(appTree, 'x.txt'), 'utf8')).toBe('x edited again elsewhere\n');
    await expect(notStaged).toContainText('a.txt');
    await expect(notStaged).toContainText('x.txt');
    const receipts = (await status()).commands.filter((c: any) =>
      ['workspace/stage', 'workspace/commit'].includes(c.operation),
    );
    expect(receipts.map((c: any) => c.status).sort()).toEqual(
      ['applied', 'applied', 'applied', 'applied', 'applied', 'rejected', 'rejected'].sort(),
    );

    // The other Project folder was never touched; it has its own changes and branch.
    await page
      .locator('.developer-workspace .snapshot-folder select')
      .selectOption({ label: 'API' });
    await expect(notStaged.getByRole('heading', { name: 'Not staged (1)' })).toBeVisible();
    await expect(notStaged).toContainText('same.txt');
    await expect(staged.getByRole('heading', { name: 'Staged (0)' })).toBeVisible();
    expect((await git(apiTree, 'log', '-1', '--format=%s', branch)).trim()).toBe('init');
    expect((await git(app, 'log', '-1', '--format=%s', branch)).trim()).toBe('Selected work');
    // The original checkouts are unchanged.
    expect((await git(app, 'status', '--porcelain')).trim()).toBe('');
    expect((await git(api, 'status', '--porcelain')).trim()).toBe('');
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
