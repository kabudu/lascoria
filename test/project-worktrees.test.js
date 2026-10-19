import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { provider } from '../testing/provider.js';
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', args, { cwd })).stdout.trim();
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, predicate) {
  let value;
  for (let i = 0; i < 200; i++) {
    try {
      value = await fn();
      if (predicate(value)) return value;
    } catch (e) {
      value = String(e);
    }
    await delay(50);
  }
  throw new Error(`Project worktree convergence: ${JSON.stringify(value)}`);
}

// R15: an isolated Project session gives every folder its own worktree and task branch, and
// each Workspace or Diff action applies to the one repository the user chose.
test(
  'isolated Project sessions work in one worktree per repository and never touch the originals',
  { timeout: 60000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-pwt-')));
    const directory = join(root, 'state');
    const repos = { app: join(root, 'app'), api: join(root, 'api') };
    for (const [name, path] of Object.entries(repos)) {
      await mkdir(path);
      await git(path, 'init', '-q');
      await writeFile(join(path, `${name}.txt`), 'original\n');
      await git(path, 'add', '.');
      await git(
        path,
        '-c',
        'user.name=QA',
        '-c',
        'user.email=qa@example.test',
        'commit',
        '-qm',
        'init',
      );
    }
    const model = await provider(root, { responseDelayMs: 20 });
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        ...model.env,
        SCH_STATE_DIR: directory,
        SCH_PROVIDER: 'meta',
        SCH_AUTH_MANAGED: '0',
        GIT_AUTHOR_NAME: 'QA',
        GIT_AUTHOR_EMAIL: 'qa@example.test',
        GIT_COMMITTER_NAME: 'QA',
        GIT_COMMITTER_EMAIL: 'qa@example.test',
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
      stdio: 'ignore',
    });
    t.after(async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exit = new Promise((r) => daemon.once('exit', r));
        daemon.kill('SIGTERM');
        await bounded(exit, 10000).catch(() => {});
        if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      }
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const status = () => request(directory, 'status');
    await until(status, (s) => s.pid === daemon.pid);
    assert.ok((await status()).features.includes('projectWorktrees'));
    const folders = [
      { id: randomUUID(), name: 'App', path: repos.app },
      { id: randomUUID(), name: 'API', path: repos.api },
    ];
    const project = await request(
      directory,
      'project/save',
      { id: randomUUID(), name: 'Isolated pair', expectedRevision: 0, folders },
      'save',
    );
    const start = await request(
      directory,
      'start',
      { projectId: project.id, projectRevision: 1, isolated: true },
      'start-isolated',
    );
    assert.equal(start.status, 'applied', JSON.stringify(start));
    const sessionId = start.sessionId;
    const row = (await until(status, (s) => s.sessions[0]?.state.current === true)).sessions[0];
    assert.equal(row.managedWorkspaces.length, 2);
    const [appTree, apiTree] = row.managedWorkspaces.map((m) => m.path);
    assert.equal(row.workspace, appTree);
    for (const m of row.managedWorkspaces) {
      assert.ok(!Object.values(repos).includes(m.path), 'a worktree, not the original');
      assert.equal(m.branch, `lascoria/${sessionId}`);
      assert.equal(await git(m.path, 'branch', '--show-current'), m.branch);
    }

    // Muse's model context names the worktrees, not the original checkouts.
    await request(directory, 'turn', { sessionId, text: 'Confirm the folders' }, 'task');
    await until(status, (s) => s.sessions[0].state.turns?.at(-1)?.terminal === 'completed');
    assert.ok(
      model.requests.some((r) => r.includes(appTree) && r.includes(apiTree)),
      'both worktrees reach the model',
    );
    assert.ok(!model.requests.some((r) => r.includes(`${repos.api}"`)), 'originals are not roots');

    // A change in the API worktree: only API's preview, snapshot and commit see it.
    await writeFile(join(apiTree, 'api.txt'), 'changed in the task\n');
    const apiPreview = await request(directory, 'workspace/inspect', {
      sessionId,
      folderId: folders[1].id,
    });
    assert.match(apiPreview.patch, /api\.txt/);
    const appPreview = await request(directory, 'workspace/inspect', {
      sessionId,
      folderId: folders[0].id,
    });
    assert.equal(appPreview.patch, '');
    await assert.rejects(
      request(directory, 'workspace/inspect', { sessionId, folderId: 'elsewhere' }),
      /no longer part/,
    );
    const turnId = (await status()).sessions[0].state.turns.at(-1).turnId;
    const snapshot = await request(
      directory,
      'artifact/capture',
      { sessionId, taskId: turnId, folderId: folders[1].id },
      'capture-api',
    );
    assert.equal(snapshot.folder.path, apiTree);
    const committed = await request(
      directory,
      'workspace/commit',
      {
        sessionId,
        folderId: folders[1].id,
        fingerprint: apiPreview.fingerprint,
        message: 'Task change in API',
      },
      'commit-api',
    );
    assert.equal(committed.status, 'applied', JSON.stringify(committed));
    assert.equal(
      await git(repos.api, 'log', '-1', '--format=%s', `lascoria/${sessionId}`),
      'Task change in API',
    );
    assert.equal(await git(repos.app, 'log', '-1', '--format=%s', `lascoria/${sessionId}`), 'init');
    for (const [name, path] of Object.entries(repos)) {
      assert.equal(await git(path, 'status', '--porcelain'), '', `${name} checkout untouched`);
      assert.equal(await readFile(join(path, `${name}.txt`), 'utf8'), 'original\n');
    }

    // A changed Project cannot be applied to an isolated session.
    await request(
      directory,
      'project/save',
      { id: project.id, name: 'Isolated pair', expectedRevision: 1, folders: [folders[0]] },
      'save-2',
    );
    await assert.rejects(
      request(directory, 'turn', { sessionId, text: 'Use fewer', projectRevision: 2 }, 'apply-2'),
      /keeps the folders it started with/,
    );

    // Discard binds every folder's content, removes both worktrees and keeps both branches.
    const fingerprints = {};
    for (const f of folders)
      fingerprints[f.id] = (
        await request(directory, 'workspace/inspect', { sessionId, folderId: f.id })
      ).fingerprint;
    const stale = await request(
      directory,
      'workspace/discard',
      {
        sessionId,
        confirmation: sessionId,
        fingerprints: { ...fingerprints, [folders[0].id]: 'sha256:old' },
      },
      'discard-stale',
    ).catch((e) => String(e));
    assert.match(String(stale?.error?.message ?? stale), /Changes moved|Confirm/);
    const discarded = await request(
      directory,
      'workspace/discard',
      { sessionId, confirmation: sessionId, fingerprints },
      'discard',
    );
    assert.equal(discarded.status, 'applied', JSON.stringify(discarded));
    for (const path of [appTree, apiTree])
      await assert.rejects(access(path), /ENOENT/, 'worktree removed');
    assert.equal(
      await git(repos.api, 'log', '-1', '--format=%s', `lascoria/${sessionId}`),
      'Task change in API',
    );
  },
);
