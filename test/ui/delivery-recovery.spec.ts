import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

// The remote wrappers below are POSIX shell scripts run by Git's local transport.
test.skip(process.platform === 'win32', 'POSIX receive-pack wrappers');

test('Delivery pauses on conflicts, recovers an unconfirmed push without repeating it, and keeps concurrent sessions apart', async ({
  browser,
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-recovery-')));
  const directory = join(root, 'state');
  const git = async (cwd: string, ...args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout;
  const bare: Record<string, string> = {};
  for (const name of ['app', 'api']) {
    const dir = join(root, name);
    bare[name] = join(root, `${name}.git`);
    await mkdir(dir);
    await mkdir(bare[name]);
    await git(bare[name], 'init', '-q', '--bare');
    await git(dir, 'init', '-q', '-b', 'main');
    await git(dir, 'config', 'user.name', 'Fixture');
    await git(dir, 'config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(dir, 'a.txt'), 'original\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-qm', 'init');
    await git(dir, 'remote', 'add', 'origin', bare[name]);
    await git(dir, 'push', '-q', 'origin', 'main');
  }
  // App's remote is slow to accept (so two sessions push at once) and, while `away` exists,
  // moves itself out of reach right after accepting, as a dropped connection would look.
  const receive = join(root, 'receive-pack.sh');
  await writeFile(
    receive,
    `#!/bin/sh\nsleep 3\ngit receive-pack "$1"\ns=$?\nif [ -e '${join(root, 'away')}' ]; then mv "$1" "$1.away"; fi\nexit $s\n`,
  );
  await chmod(receive, 0o755);
  await git(join(root, 'app'), 'config', 'remote.origin.receivepack', receive);

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
    const sessions: Record<string, { id: string; tree: string; branch: string }> = {};
    for (const name of ['app', 'api']) {
      const { sessionId } = await request(
        directory,
        'start',
        { workspace: join(root, name), isolated: true, name: `Deliver ${name}` },
        `start-${name}`,
      );
      await request(directory, 'turn', { sessionId, text: `Change ${name}` }, `turn-${name}`);
      await expect
        .poll(async () => {
          const s = (await status()).sessions.find((x: any) => x.id === sessionId);
          return !s?.state.activeTurnId && s?.state.turns?.some((t: any) => t.terminal);
        })
        .toBe(true);
      const managed = (await status()).sessions.find(
        (x: any) => x.id === sessionId,
      ).managedWorkspace;
      sessions[name] = { id: sessionId, tree: managed.path, branch: managed.branch };
    }

    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 70000, maxBuffer: 40 * 1024 * 1024 },
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
    const sessionsList = page.getByRole('navigation', { name: 'Sessions', exact: true });
    const open = async (name: string) => {
      await sessionsList.getByRole('button', { name: new RegExp(`Deliver ${name}`) }).click();
      await page.getByRole('tab', { name: 'workspace', exact: true }).click();
    };
    const delivery = page.locator('section.delivery');
    const step = delivery.locator('.delivery-step');
    const primary = delivery.locator('button.primary');

    // 1. A merge conflict pauses delivery: no primary action, plain guidance.
    const app = sessions.app;
    await git(app.tree, 'checkout', '-q', '-b', 'side', 'HEAD');
    await writeFile(join(app.tree, 'a.txt'), 'side\n');
    await git(
      app.tree,
      '-c',
      'user.name=F',
      '-c',
      'user.email=f@x.invalid',
      'commit',
      '-qam',
      'side',
    );
    await git(app.tree, 'checkout', '-q', app.branch);
    await writeFile(join(app.tree, 'a.txt'), 'task\n');
    await git(
      app.tree,
      '-c',
      'user.name=F',
      '-c',
      'user.email=f@x.invalid',
      'commit',
      '-qam',
      'Task change',
    );
    await exec('git', ['-C', app.tree, 'merge', 'side']).catch(() => undefined);
    await open('app');
    await expect(step).toContainText('Resolve merge conflicts first');
    await expect(step).toContainText('1 file with conflicts');
    await expect(primary).toHaveCount(0);
    await git(app.tree, 'merge', '--abort');
    await git(app.tree, 'branch', '-D', 'side');
    await delivery.getByRole('button', { name: 'Check again' }).click();
    await expect(step).toContainText('Ready to push');

    // 2. The remote accepts the push, then cannot be reached to confirm it.
    await writeFile(join(root, 'away'), '');
    await primary.click();
    await delivery.locator('form.decision').getByRole('button', { name: 'Push to origin' }).click();
    await expect(step).toContainText('could not confirm the last delivery step', {
      timeout: 30000,
    });
    await expect(step).toContainText('Check the remote before trying again');
    await expect(primary).toHaveText('Check the remote');
    // The connection comes back: checking shows the commit already arrived, so nothing is
    // pushed again.
    await rm(join(root, 'away'));
    await rename(`${bare.app}.away`, bare.app);
    await primary.click();
    await expect(step).toContainText('Pushed to origin', { timeout: 20000 });
    await expect(step).toContainText('Open a pull request on your Git host.');
    const head = (await git(app.tree, 'rev-parse', 'HEAD')).trim();
    expect((await git(bare.app, 'rev-parse', app.branch)).trim()).toBe(head);
    const pushes = (await status()).commands.filter(
      (c: any) => c.operation === 'workspace/push' && c.sessionId === app.id,
    );
    expect(pushes.map((c: any) => c.status)).toEqual(['outcomeUnknown']);

    // 3. Two sessions deliver at once: each to its own remote and branch. A second push in
    // a session that is already pushing is refused before anything is sent.
    await writeFile(join(app.tree, 'b.txt'), 'more\n');
    await git(app.tree, 'add', 'b.txt');
    await git(
      app.tree,
      '-c',
      'user.name=F',
      '-c',
      'user.email=f@x.invalid',
      'commit',
      '-qm',
      'More',
    );
    await writeFile(join(sessions.api.tree, 'a.txt'), 'api change\n');
    await git(
      sessions.api.tree,
      '-c',
      'user.name=F',
      '-c',
      'user.email=f@x.invalid',
      'commit',
      '-qam',
      'Api change',
    );
    await delivery.getByRole('button', { name: 'Check again' }).click();
    await expect(step).toContainText('Ready to push');
    await primary.click();
    await delivery.locator('form.decision').getByRole('button', { name: 'Push to origin' }).click();
    await expect(step).toContainText('Pushing to origin');
    const view = await request(directory, 'workspace/delivery', { sessionId: app.id });
    await expect(
      request(
        directory,
        'workspace/push',
        { sessionId: app.id, revision: view.revision, head: view.head, remote: 'origin' },
        'second-push',
      ),
    ).rejects.toThrow('Wait for the current push');
    await open('api');
    await expect(step).toContainText('Ready to push');
    await primary.click();
    await delivery.locator('form.decision').getByRole('button', { name: 'Push to origin' }).click();
    await expect(step).toContainText('Pushed to origin', { timeout: 20000 });
    await open('app');
    await expect(step).toContainText('Pushed to origin', { timeout: 20000 });
    expect((await git(bare.app, 'rev-parse', app.branch)).trim()).toBe(
      (await git(app.tree, 'rev-parse', 'HEAD')).trim(),
    );
    expect((await git(bare.api, 'rev-parse', sessions.api.branch)).trim()).toBe(
      (await git(sessions.api.tree, 'rev-parse', 'HEAD')).trim(),
    );
    await expect(git(bare.api, 'rev-parse', '--verify', app.branch)).rejects.toThrow();
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
