import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
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
  'edited Project folders apply to an existing session with its next task and survive recovery',
  { timeout: 60000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-pctx-')));
    const directory = join(root, 'state'),
      app = join(root, 'app-root'),
      api = join(root, 'api-root'),
      docs = join(root, 'docs-root');
    for (const dir of [app, api, docs]) await mkdir(dir);
    const model = await provider(root, { responseDelayMs: 800 });
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
    const status = () => request(directory, 'status');
    await until(status, (s) => s.pid === daemon.pid);
    assert.ok((await status()).features.includes('projectContextUpdates'));
    const folder = (name, path) => ({ id: randomUUID(), name, path });
    const [appFolder, apiFolder, docsFolder] = [
      folder('App', app),
      folder('API', api),
      folder('Docs', docs),
    ];
    appFolder.note = 'Web client';
    const input = {
      id: randomUUID(),
      name: 'Growing project',
      goal: 'Keep the public API stable',
      folders: [appFolder, apiFolder],
    };
    const save = (revision, folders, id) =>
      request(directory, 'project/save', { ...input, expectedRevision: revision, folders }, id);
    await save(0, [appFolder, apiFolder], 'save-1');
    const start = await request(
      directory,
      'start',
      { projectId: input.id, projectRevision: 1 },
      'context-start',
    );
    assert.equal(start.status, 'applied', JSON.stringify(start));
    const sessionId = start.sessionId;
    const finished = (count) =>
      until(
        status,
        (s) =>
          !s.sessions[0].state.activeTurnId &&
          s.sessions[0].state.turns?.filter((turn) => turn.terminal).length === count,
      );
    await request(directory, 'turn', { sessionId, text: 'First task' }, 'task-1');
    await finished(1);
    assert.ok(!model.requests.at(-1).includes(docs));
    // R15: the goal and folder notes reach the model once, with the first plain task, while the
    // transcript keeps the user's words.
    const occurrences = (text) => text.split('Project goal: Keep the public API stable').length - 1;
    assert.equal(occurrences(model.requests.at(-1)), 1, model.requests.at(-1));
    assert.ok(model.requests.at(-1).includes('Note: Web client'));
    assert.ok((await status()).sessions[0].state.items.some((i) => i.displayText === 'First task'));
    // T1: per-task token use is counted from Muse's session/tokenUsage, and Muse's cumulative
    // session total covers it.
    const tokenState = (await status()).sessions[0].state;
    const firstTurn = tokenState.turns[0].turnId;
    const perTask = tokenState.tokens.byTurn[firstTurn];
    assert.ok(perTask?.calls >= 1 && perTask.totalTokens > 0, JSON.stringify(tokenState.tokens));
    assert.ok(
      tokenState.sessionState['session/tokenUsage'].cumulative.totalTokens >= perTask.totalTokens,
    );

    // Only the supervisor attaches model-visible notes and roots; a caller cannot.
    for (const field of ['projectNote', 'workspaceRoots'])
      await assert.rejects(
        request(directory, 'turn', { sessionId, text: 'x', [field]: 'hidden' }, `forged-${field}`),
        /Unsupported task field/,
      );

    // Ordinary saves never touch the running session.
    await save(1, [apiFolder, appFolder], 'save-2');
    await save(2, [appFolder, apiFolder, docsFolder], 'save-3');
    assert.equal((await status()).sessions[0].projectContext.revision, 1);
    await assert.rejects(
      request(directory, 'turn', { sessionId, text: 'x', projectRevision: 1 }, 'already'),
      /already applied/,
    );
    await assert.rejects(
      request(directory, 'turn', { sessionId, text: 'x', projectRevision: 2 }, 'superseded'),
      /Project changed/,
    );
    await assert.rejects(
      request(directory, 'steer', { sessionId, text: 'x', projectRevision: 3 }, 'steer-roots'),
      /only with a new task/,
    );

    // A task already running keeps its folders.
    await request(directory, 'turn', { sessionId, text: 'Second task' }, 'task-2');
    await until(status, (s) => !!s.sessions[0].state.activeTurnId);
    await assert.rejects(
      request(directory, 'turn', { sessionId, text: 'x', projectRevision: 3 }, 'while-busy'),
      /Wait for Muse|Finish or stop/,
    );
    await finished(2);
    assert.equal((await status()).sessions[0].projectContextPending, undefined);
    assert.equal(occurrences(model.requests.at(-1)), 1, 'the brief is not repeated');

    const applyText = 'Use the Docs folder too';
    const applied = await request(
      directory,
      'turn',
      { sessionId, text: applyText, projectRevision: 3 },
      'apply-docs',
    );
    // A turn is admitted (`accepted`) and completes later; either is a native receipt.
    assert.ok(['applied', 'accepted'].includes(applied.status), JSON.stringify(applied));
    await finished(3);
    let row = (await status()).sessions[0];
    const evidence = () =>
      JSON.stringify({
        context: row.projectContext?.revision,
        receipt: row.projectContextReceipt,
        pending: row.projectContextPending,
        command: applied,
      });
    // Muse keeps describing the session-start folders to the model, so the change is also named
    // in a model-visible note; the transcript keeps the user's words.
    const last = model.requests.at(-1);
    assert.ok(last.includes('Lascoria note') && last.includes(docs), evidence());
    assert.ok(
      row.state.items.some((item) => item.displayText === applyText),
      `Transcript shows the user text: ${JSON.stringify(row.state.items.slice(-4))}`,
    );
    assert.equal(row.projectContext.revision, 3);
    assert.deepEqual(
      row.projectContext.folders.map((f) => f.name),
      ['App', 'API', 'Docs'],
    );
    assert.equal(row.projectContextReceipt.requestId, 'apply-docs');
    assert.equal(row.projectContextReceipt.status, 'applied');
    assert.equal(row.projectContextPending, undefined);
    assert.equal(row.workspace, app);
    // A lost reply retries without a second task.
    const retried = await request(
      directory,
      'turn',
      { sessionId, text: applyText, projectRevision: 3 },
      'apply-docs',
    );
    assert.equal(retried.commandId, applied.commandId);

    // The native replacement is durable across supervisor restart and recovery.
    const stopped = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await bounded(stopped, 10000);
    daemon = boot();
    await until(status, (s) => s.pid === daemon.pid && s.sessions[0]?.lifecycle === 'connected');
    row = (await status()).sessions[0];
    assert.equal(row.projectContext.revision, 3);
    await request(directory, 'turn', { sessionId, text: 'After recovery' }, 'task-after');
    await finished(4);
    assert.equal((await status()).sessions[0].projectContext.revision, 3);
    // The Docs folder is now checked before every task.
    await rm(docs, { recursive: true });
    await assert.rejects(
      request(directory, 'turn', { sessionId, text: 'Do not run' }, 'missing-docs'),
      /folder unavailable/,
    );
    const turns = (await status()).commands.filter((c) => c.operation === 'turn');
    assert.equal(turns.length, 4);
  },
);
