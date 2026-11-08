import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

// The controlled GitHub CLI is a POSIX shell script; Windows covers the push journey.
const unix = process.platform !== 'win32';

test('Review to delivery: validate, fix, commit, push and open one pull request with explicit review', async ({
  browser,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-delivery-')));
  const directory = join(root, 'state');
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout;
  const remotes: Record<string, string> = {};
  for (const name of ['app', 'api']) {
    const dir = join(root, name);
    const bare = join(root, `${name}.git`);
    await mkdir(dir);
    await mkdir(bare);
    await git(bare, 'init', '-q', '--bare');
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Fixture');
    await git(dir, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(dir, 'a.txt'), 'original\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'init');
    // GitHub names the repository; pushes land in the local bare repository.
    await git(dir, 'remote', 'add', 'origin', `https://github.com/fixture/${name}.git`);
    await git(dir, 'config', 'remote.origin.pushurl', bare);
    await git(dir, 'push', '-q', bare, 'main');
    remotes[name] = bare;
  }
  const gh = join(root, 'gh');
  const calls = join(root, 'gh-calls.log');
  const prs = join(root, 'prs.json');
  await writeFile(prs, '[]');
  await writeFile(
    gh,
    `#!/bin/sh
echo "$*" >> '${calls}'
case "$1 $2" in
  'pr list') cat '${prs}' ;;
  'pr create') cat > /dev/null
    printf '[{"number":12,"url":"https://github.com/fixture/app/pull/12","state":"OPEN","isDraft":true,"title":"Fix a","headRefName":"%s","headRefOid":"x","baseRefName":"main"}]' "$(echo "$*" | sed 's/.*--head \\([^ ]*\\).*/\\1/')" > '${prs}'
    echo https://github.com/fixture/app/pull/12 ;;
esac
`,
  );
  await chmod(gh, 0o755);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    ...(unix ? { SCH_GH_BIN: gh } : {}),
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
      { id: randomUUID(), name: 'App', path: join(root, 'app') },
      { id: randomUUID(), name: 'API', path: join(root, 'api') },
    ];
    const project = { id: randomUUID(), name: 'Shop' };
    await request(directory, 'project/save', { ...project, expectedRevision: 0, folders }, 's1');
    const { sessionId } = await request(
      directory,
      'start',
      { projectId: project.id, projectRevision: 1, isolated: true, name: 'Delivery work' },
      'start-1',
    );
    await request(directory, 'turn', { sessionId, text: 'Change a.txt' }, 'task-1');
    await expect
      .poll(async () => {
        const s = (await status()).sessions[0];
        return !s?.state.activeTurnId && s.state.turns?.some((t: any) => t.terminal);
      })
      .toBe(true);
    const managed = (await status()).sessions[0].managedWorkspaces;
    const appTree = managed.find((m: any) => m.folderId === folders[0].id).path;
    const branch = managed[0].branch;
    await writeFile(join(appTree, 'a.txt'), 'changed by Muse\n');

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
    await expect(page.getByRole('heading', { name: 'Delivery work', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Deliver this work' })).toHaveCount(0);
    await page.getByRole('tab', { name: 'workspace', exact: true }).click();
    const delivery = page.locator('section.delivery');
    const step = delivery.locator('.delivery-step');
    const primary = delivery.locator('button.primary');

    // Scripted phase timings (controlled provider, local bare remote). Not a user trial.
    const phases: [string, number][] = [];
    let mark = Date.now();
    const phase = (name: string) => {
      phases.push([name, Date.now() - mark]);
      mark = Date.now();
    };
    // 1. Nothing has checked these files: the one next step is to choose a test command.
    await expect(step).toContainText('Check these changes');
    await expect(step).toContainText('No test has run on these files.');
    await expect(primary).toHaveCount(1);
    // One primary action in the whole Workspace tab.
    await expect(page.locator('.developer-workspace button.primary:visible')).toHaveCount(1);
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(page.getByLabel('Test command')).toBeFocused();
    await page.keyboard.type('grep -q fixed a.txt');
    await page.keyboard.press('Enter');

    phase('run first check');
    // 2. A failing check becomes the finding to resolve, sent to Muse with its output.
    await expect(step).toContainText('Tests fail on these changes', { timeout: 20000 });
    await primary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { name: 'transcript', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByLabel('New task for this session')).toHaveValue(
      /Please fix the failing check below[\s\S]*grep -q fixed a\.txt` failed/,
    );
    await page.getByRole('tab', { name: 'workspace', exact: true }).click();

    phase('send failure to Muse');
    // 3. The fix (an external edit) makes the failure stale; rerun the same command.
    await writeFile(join(appTree, 'a.txt'), 'changed by Muse and fixed\n');
    await delivery.getByRole('button', { name: 'Check again' }).click();
    await expect(step).toContainText('failed earlier, but the files have changed since');
    await expect(primary).toHaveText('Run grep -q fixed a.txt');
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(step).toContainText('Ready to commit', { timeout: 20000 });
    await expect(step).toContainText('passed on these exact files');

    phase('recheck after fix');
    // 4. Stage all, then commit; the message field takes focus and Enter commits.
    await expect(primary).toHaveText('Stage all changes');
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(primary).toHaveText('Commit staged changes…');
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(page.getByLabel('Commit message')).toBeFocused();
    await page.keyboard.type('Fix a');
    await page.keyboard.press('Enter');
    await expect(step).toContainText('Ready to push', { timeout: 15000 });
    // Committing the tested files keeps the result current.
    await expect(step).toContainText('passed on these exact files');
    phase('stage and commit');

    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') {
        await page.getByLabel('Workspace menu').click();
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
      }
      for (const width of [1440, 820]) {
        await page.setViewportSize({ width, height: 1000 });
        await delivery.getByText('Details', { exact: true }).click();
        expect(
          (
            await new AxeBuilder({ page })
              .include('section.delivery')
              .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
              .analyze()
          ).violations,
        ).toEqual([]);
        expect(
          await delivery.evaluate((section) => {
            const body = section.closest('.inspector-body') ?? section.parentElement!;
            return body.scrollWidth <= body.clientWidth + 1;
          }),
        ).toBe(true);
        await page.screenshot({ path: `test-results/delivery-${theme}-${width}.png` });
        await delivery.getByText('Details', { exact: true }).click();
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();

    mark = Date.now();
    // 5. Push shows the actual destination, branch and outgoing commits before anything leaves.
    await expect(primary).toBeEnabled();
    await primary.click();
    const confirmPush = delivery.locator('form.decision');
    await expect(confirmPush.getByRole('heading')).toHaveText('Push 1 commit to origin?');
    await expect(confirmPush.getByRole('heading')).toBeFocused();
    await expect(confirmPush).toContainText(remotes.app);
    await expect(confirmPush).toContainText(`${branch}New branch`);
    await expect(confirmPush).toContainText('Fix a');
    // A commit made elsewhere after review: the reviewed push is refused, nothing leaves.
    await writeFile(join(appTree, 'b.txt'), 'late\n');
    await git(appTree, 'add', 'b.txt');
    await git(appTree, 'commit', '-qm', 'Late commit');
    await confirmPush.getByRole('button', { name: 'Push to origin' }).click();
    await expect(delivery.getByRole('alert')).toContainText('changed since you reviewed it', {
      timeout: 20000,
    });
    await expect(git(remotes.app, 'rev-parse', '--verify', branch)).rejects.toThrow();
    await expect(primary).toHaveText('Push to origin…');
    await expect(primary).toBeEnabled();
    await primary.click();
    await expect(confirmPush.getByRole('heading')).toHaveText('Push 2 commits to origin?');
    await expect(confirmPush).toContainText('Late commit');
    await confirmPush.screenshot({ path: 'test-results/delivery-push-review.png' });
    await confirmPush.getByRole('button', { name: 'Push to origin' }).click();
    const head = (await git(appTree, 'rev-parse', 'HEAD')).trim();
    await expect
      .poll(async () => (await git(remotes.app, 'rev-parse', branch).catch(() => '')).trim(), {
        timeout: 20000,
      })
      .toBe(head);

    phase('review and push (including one refused stale review)');
    if (unix) {
      // 6. Pull request: defaults from the branch, created once, then shown instead of repeated.
      await expect(step).toContainText('Pushed. Ready for review', { timeout: 20000 });
      await expect(primary).toBeEnabled();
      await primary.click();
      const form = delivery.locator('form.decision');
      await expect(form.getByRole('heading')).toHaveText('Open a pull request on fixture/app?');
      await expect(form.getByLabel('Title')).toHaveValue('Late commit');
      await expect(form.getByLabel('Into branch')).toHaveValue('main');
      await expect(form.getByLabel('Open as a draft')).toBeChecked();
      await form.screenshot({ path: 'test-results/delivery-pr-review.png' });
      await form.getByLabel('Title').fill('Fix a');
      await form.getByRole('button', { name: 'Open pull request' }).click();
      await expect(step).toContainText('Pull request #12 is open', { timeout: 20000 });
      await expect(primary).toHaveText('Open pull request');
      const log = await readFile(calls, 'utf8');
      expect(log.match(/pr create/g)).toHaveLength(1);
      expect(log).toContain(`--head ${branch} --base main --title Fix a --body-file - --draft`);
      phase('open pull request');
    } else {
      await expect(step).toContainText('Pushed to origin', { timeout: 20000 });
    }

    console.log(`SCRIPTED-TIMINGS ${JSON.stringify(Object.fromEntries(phases))}`);
    // 7. Project ownership: the other folder has its own, untouched delivery state.
    await page.locator('.snapshot-folder select').selectOption({ label: 'API' });
    await expect(step).toContainText('No changes to deliver yet');
    await expect(git(remotes.api, 'rev-parse', '--verify', branch)).rejects.toThrow();
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
