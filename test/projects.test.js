import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { provider } from '../testing/provider.js';
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
  throw new Error(`Project convergence: ${JSON.stringify(value)}`);
}

test(
  'saved Projects reach native Muse context, stay revision-bound and reject unsafe roots',
  { timeout: 40000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-projects-')));
    const directory = join(root, 'state'),
      app = join(root, 'app-root'),
      api = join(root, 'api-root');
    await mkdir(app);
    await mkdir(api);
    const model = await provider(root, { responseDelayMs: 20 });
    const boot = () =>
      spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env: {
          ...process.env,
          ...model.env,
          SCH_STATE_DIR: directory,
          SCH_PROVIDER: 'meta',
          SCH_AUTH_MANAGED: '0',
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_CACHE_HOME: join(root, 'cache'),
        },
        stdio: 'ignore',
      });
    let daemon = boot();
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
    await until(
      () => request(directory, 'status'),
      (s) => s.pid === daemon.pid,
    );
    const input = {
      id: randomUUID(),
      name: 'Two folders',
      expectedRevision: 0,
      folders: [
        { id: randomUUID(), name: 'App', path: app },
        { id: randomUUID(), name: 'API', path: api },
      ],
    };
    const project = await request(directory, 'project/save', input, 'save-project');
    assert.deepEqual(await request(directory, 'project/save', input, 'save-project'), project);
    assert.equal((await request(directory, 'project/list')).projects.length, 1);
    await assert.rejects(
      request(
        directory,
        'start',
        { projectId: project.id, projectRevision: 1, isolated: true },
        'bad-isolation',
      ),
      /App must be a Git repository root to be isolated/,
    );
    const start = await request(
      directory,
      'start',
      { projectId: project.id, projectRevision: 1, name: project.name },
      'project-start',
    );
    assert.equal(start.status, 'applied', JSON.stringify(start));
    const sessionId = start.sessionId;
    await request(
      directory,
      'turn',
      { sessionId, text: 'Confirm workspace context' },
      'project-task',
    );
    await until(
      () => request(directory, 'status'),
      (s) => s.sessions[0].state.turns?.at(-1)?.terminal === 'completed',
    );
    assert.ok(model.requests.length > 0);
    assert.ok(
      model.requests.some((r) => r.includes(app) && r.includes(api)),
      'Native model request must contain both workspace roots',
    );
    await request(
      directory,
      'project/save',
      {
        ...input,
        name: 'Renamed reusable project',
        expectedRevision: 1,
        folders: [...input.folders].reverse(),
      },
      'edit-project',
    );
    const row = (await request(directory, 'status')).sessions[0];
    assert.equal(row.workspace, app);
    assert.equal(row.projectContext.revision, 1);
    assert.equal(row.projectContextReceipt.status, 'applied');
    assert.equal(row.projectContextReceipt.requestId, 'project-start');
    assert.equal(row.projectContext.folders[0].path, app);
    await assert.rejects(
      request(directory, 'start', { projectId: project.id, projectRevision: 1 }, 'stale-project'),
      /Project changed/,
    );
    // A Project snapshot names one of the session's folders; a path cannot be supplied.
    await assert.rejects(
      request(directory, 'artifact/capture', { sessionId }, 'wrong-diff'),
      /Choose which Project folder/,
    );
    await assert.rejects(
      request(
        directory,
        'artifact/capture',
        { sessionId, folderId: 'not-a-folder', path: app },
        'wrong-folder',
      ),
      /no longer part/,
    );
    const stopped = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await bounded(stopped, 10000);
    daemon = boot();
    await until(
      () => request(directory, 'status'),
      (s) => s.pid === daemon.pid && s.sessions[0]?.lifecycle === 'connected',
    );
    const recovered = (await request(directory, 'status')).sessions[0];
    assert.equal(recovered.projectContext.revision, 1);
    assert.equal((await request(directory, 'project/list')).projects[0].revision, 2);
    await request(
      directory,
      'turn',
      { sessionId, text: 'Confirm retained native roots after recovery' },
      'project-recovered-task',
    );
    await until(
      () => request(directory, 'status'),
      (s) => s.sessions[0].state.turns?.at(-1)?.terminal === 'completed',
    );
    assert.ok(model.requests.at(-1).includes(app) && model.requests.at(-1).includes(api));
    await rm(api, { recursive: true });
    await assert.rejects(
      request(directory, 'turn', { sessionId, text: 'Do not run' }, 'missing-root'),
      /is no longer there: .*Put it back/,
    );
    const savedRetry = await request(
      directory,
      'project/save',
      {
        ...input,
        name: 'Renamed reusable project',
        expectedRevision: 1,
        folders: [...input.folders].reverse(),
      },
      'edit-project',
    );
    assert.equal(
      savedRetry.revision,
      2,
      'A committed save reconciles without probing a now-missing folder',
    );
    if (process.platform !== 'win32') {
      await symlink(app, api);
      await assert.rejects(
        request(
          directory,
          'turn',
          { sessionId, text: 'Do not follow rebound root' },
          'rebound-root',
        ),
        /folder moved|distinct/,
      );
    }
    const after = await request(directory, 'status');
    assert.equal(after.sessions.length, 1);
    assert.equal(after.commands.filter((c) => c.operation === 'turn').length, 2);
  },
);
