import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, predicate, label) {
  let value;
  for (let i = 0; i < 150; i++) {
    try {
      value = await fn();
      if (predicate(value)) return value;
    } catch (e) {
      value = e.message;
    }
    await delay(50);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
test(
  'session lanes: slow commands and recovery isolate peers, preserve order and bound admission',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-scheduling-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'workspace'),
      log = join(root, 'calls');
    await mkdir(workspace);
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        SCH_STATE_DIR: directory,
        SCH_WORKER: resolve('testing/scheduling-worker.js'),
        SCH_SCHEDULING_LOG: log,
      },
      stdio: 'ignore',
    });
    t.after(async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise((resolve) => daemon.once('exit', resolve));
        daemon.kill('SIGTERM');
        await bounded(exited, 10000).catch(() => daemon.kill('SIGKILL'));
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const status = () => request(directory, 'status');
    const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    await until(status, (s) => s.pid === daemon.pid, 'ready');
    const a = (await request(directory, 'start', { workspace }, 'start-a')).sessionId;
    const b = (await request(directory, 'start', { workspace }, 'start-b')).sessionId;
    const slow = request(directory, 'turn', { sessionId: a, text: 'slow' }, 'slow');
    await until(calls, (c) => c.some((v) => v.params.text === 'slow'), 'slow dispatched');
    await assert.rejects(
      request(directory, 'turn', { sessionId: b, text: 'collision' }, 'slow'),
      /in flight/,
    );
    const ordered = request(
      directory,
      'setEffort',
      { sessionId: a, reasoningEffort: 'low' },
      'ordered',
    );
    const queued = [
      request(directory, 'setEffort', { sessionId: a, reasoningEffort: 'medium' }, 'queue-1'),
    ];
    await delay(50);
    queued.push(
      request(directory, 'setEffort', { sessionId: a, reasoningEffort: 'high' }, 'queue-2'),
    );
    await delay(100);
    await assert.rejects(request(directory, 'models', { sessionId: a }, 'overflow'), /queue full/);
    const began = performance.now();
    const peer = await request(
      directory,
      'setEffort',
      { sessionId: b, reasoningEffort: 'high' },
      'peer',
    );
    assert.equal(peer.status, 'applied');
    assert.ok(performance.now() - began < 1500, 'peer command bypasses slow session');
    assert.ok(
      !(await calls()).some((v) => v.params.reasoningEffort === 'low'),
      'same-session command waits',
    );
    assert.equal((await status()).sessions.length, 2, 'snapshots remain responsive');
    await Promise.all([slow, ordered, ...queued]);
    assert.deepEqual(
      (await calls())
        .filter((c) => c.operation === 'setEffort' && c.params.sessionId === a)
        .map((c) => c.params.reasoningEffort),
      ['low', 'medium', 'high'],
      'queued commands retain receive order',
    );
    assert.equal(
      (await request(directory, 'turn', { sessionId: a, text: 'slow' }, 'slow')).status,
      'applied',
      'completed ID is not replayed',
    );
    assert.equal((await calls()).filter((v) => v.params.text === 'slow').length, 1);
    const recovery = request(directory, 'resume', { sessionId: a }, 'recover-a');
    await until(calls, (c) => c.some((v) => v.operation === 'resume'), 'resume dispatched');
    const recoveryStart = performance.now();
    assert.equal(
      (
        await request(
          directory,
          'setEffort',
          { sessionId: b, reasoningEffort: 'low' },
          'during-recovery',
        )
      ).status,
      'applied',
    );
    assert.ok(performance.now() - recoveryStart < 1500, 'peer stays responsive during recovery');
    await recovery;
    await until(
      status,
      (s) => s.sessions.every((r) => r.lifecycle === 'connected'),
      'both connected',
    );
    const draining = request(directory, 'turn', { sessionId: a, text: 'slow' }, 'draining');
    await until(
      calls,
      (c) => c.filter((v) => v.params.text === 'slow').length === 2,
      'shutdown work dispatched',
    );
    const stopping = request(directory, 'stop', { sessions: [a, b] });
    assert.equal((await draining).status, 'applied', 'shutdown drains the admitted command');
    const stopped = await stopping;
    assert.equal(stopped.stopping, true);
  },
);

test(
  'review snapshots remain available while a new session is being admitted',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-admission-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'workspace');
    await mkdir(workspace);
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        SCH_STATE_DIR: directory,
        SCH_WORKER: resolve('testing/scheduling-worker.js'),
        SCH_SCHEDULING_LOG: join(root, 'calls'),
        SCH_DELAY_START: '1',
      },
      stdio: 'ignore',
    });
    t.after(async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise((r) => daemon.once('exit', r));
        daemon.kill('SIGTERM');
        await bounded(exited, 10000).catch(() => daemon.kill('SIGKILL'));
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await until(
      () => request(directory, 'status'),
      (s) => s.pid === daemon.pid,
      'ready',
    );
    const starting = request(directory, 'start', { workspace }, 'admitting').then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const snapshot = await until(
      () => request(directory, 'status'),
      (s) => s.sessions.length === 1,
      'registered',
    );
    const sessionId = snapshot.sessions[0].id;
    const began = performance.now();
    const review = await request(directory, 'review/list', { sessionId }, 'during-admission');
    assert.deepEqual(review.artifacts, []);
    assert.deepEqual(review.evidence, []);
    assert.ok(
      performance.now() - began < 1500,
      'journal reads do not wait for slow session admission',
    );
    await assert.rejects(
      request(directory, 'review/list', { sessionId: 'unregistered' }),
      /Unknown session/,
    );
    const result = await starting;
    assert.equal(result.value?.status, 'applied', String(result.error));
  },
);
