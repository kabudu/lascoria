import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { request } from '../src/client.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(directory, predicate) {
  for (let i = 0; i < 100; i++) {
    try {
      const result = await request(directory, 'status');
      if (predicate(result)) return result;
    } catch {}
    await delay(100);
  }
  throw new Error('Journal test did not converge');
}
async function stop(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  await exited;
}
test(
  'Rust IPC/journal: uncertain action survives SIGKILL without retransmission',
  { timeout: 30000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-journal-'));
    const directory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const actions = join(root, 'actions');
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_WORKER: resolve('testing/uncertain-worker.js'),
      SCH_FIXTURE_ACTIONS: actions,
    };
    const boot = () =>
      spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: 'ignore',
      });
    let daemon = boot();
    t.after(async () => {
      await stop(daemon, 'SIGTERM');
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await poll(directory, (v) => v.pid === daemon.pid);
    const unauthorized = await new Promise((resolve, reject) => {
      const socket = net.createConnection(join(directory, 'supervisor.sock'));
      let result = '';
      socket.on('error', reject);
      socket.on('connect', () =>
        socket.write(JSON.stringify({ version: 1, token: 'wrong', operation: 'status' }) + '\n'),
      );
      socket.on('data', (chunk) => (result += chunk));
      socket.on('end', () => resolve(JSON.parse(result)));
    });
    assert.match(unauthorized.error, /authentication/);
    const started = await request(directory, 'start', { workspace }, 'start');
    const sessionId = started.sessionId;
    const params = { sessionId, text: 'action with lost ack' };
    const uncertain = request(directory, 'turn', params, 'uncertain').catch(() => {});
    for (let i = 0; i < 100; i++) {
      try {
        await readFile(actions);
        break;
      } catch {}
      await delay(20);
    }
    assert.equal((await readFile(actions, 'utf8')).trim().split('\n').length, 1);
    await stop(daemon, 'SIGKILL');
    await uncertain;
    daemon = boot();
    const state = await poll(directory, (v) => v.sessions[0]?.lifecycle === 'connected');
    const before = state.commands.find((c) => c.id === 'uncertain');
    assert.equal(before.status, 'outcomeUnknown');
    const duplicate = await request(directory, 'turn', params, 'uncertain');
    assert.equal(duplicate.status, 'outcomeUnknown');
    assert.equal(duplicate.commandId, before.commandId);
    assert.equal((await readFile(actions, 'utf8')).trim().split('\n').length, 1);
    await assert.rejects(
      request(directory, 'turn', { ...params, text: 'changed' }, 'uncertain'),
      /different payload/,
    );
    await assert.rejects(request(directory, 'stop', { sessions: [] }), /Affected sessions/);
    await assert.rejects(
      request(directory, 'stop', { sessions: [sessionId, null] }),
      /must be strings/,
    );
    const beforeResume = (await request(directory, 'status')).sessions[0].interruptions.length;
    await request(directory, 'resume', { sessionId }, 'explicit-resume');
    const afterResume = (await request(directory, 'status')).sessions[0];
    assert.ok(
      afterResume.interruptions.length > beforeResume,
      'old worker drain interruption is retained',
    );
    assert.equal(afterResume.lifecycle, 'connected');
    assert.equal((await request(directory, 'stop', { sessions: [sessionId] })).stopping, true);
    await new Promise((resolve) => {
      if (daemon.exitCode !== null) resolve();
      else daemon.once('exit', resolve);
    });
  },
);

test(
  'Rust recovery: two refused attempts stop, unfamiliar durability cannot resume',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-retry-'));
    const directory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const actions = join(root, 'attempts');
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_WORKER: resolve('testing/uncertain-worker.js'),
      SCH_FIXTURE_ACTIONS: actions,
      SCH_FIXTURE_REJECT_RESUME: '1',
    };
    const boot = () =>
      spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: 'ignore',
      });
    let daemon = boot();
    t.after(async () => {
      await stop(daemon, 'SIGTERM');
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await poll(directory, (v) => v.pid === daemon.pid);
    const started = await request(directory, 'start', { workspace }, 'start');
    await stop(daemon, 'SIGKILL');
    daemon = boot();
    const exhausted = await poll(
      directory,
      (v) => v.sessions[0]?.attempts === 2 && v.sessions[0].lifecycle === 'interrupted',
    );
    assert.equal(exhausted.sessions[0].state.current, false);
    assert.match(exhausted.sessions[0].recoveryError, /Resume failed/);
    await delay(1500);
    assert.equal((await readFile(actions, 'utf8')).trim().split('\n').length, 2);
    await stop(daemon, 'SIGTERM');
    env.SCH_FIXTURE_DURABILITY = 'unfamiliar';
    daemon = boot();
    await poll(directory, (v) => v.sessions[0]?.durability === 'unfamiliar');
    await assert.rejects(
      request(directory, 'resume', { sessionId: started.sessionId }, 'unsupported'),
      /ephemeral or unfamiliar/,
    );
    assert.equal(
      (await readFile(actions, 'utf8')).trim().split('\n').length,
      2,
      'no resume command reaches an unfamiliar host',
    );
  },
);

test(
  'diagnostic up: service outlives client and empty-session stop is acknowledged',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-up-'));
    const directory = join(root, 'state');
    const env = { ...process.env, SCH_STATE_DIR: directory };
    let pid;
    t.after(async () => {
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const cli = (...args) =>
      execFileSync(process.execPath, ['src/cli.js', ...args], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      });
    assert.match(cli('up'), /running independently/);
    const first = JSON.parse(cli('status'));
    pid = first.pid;
    assert.match(cli('up'), /already running/);
    assert.equal(JSON.parse(cli('status')).pid, pid);
    assert.equal(JSON.parse(cli('stop', '{"sessions":[]}')).stopping, true);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        pid = undefined;
        break;
      }
      await delay(50);
    }
    assert.equal(pid, undefined, 'stop finishes after acknowledgement');
  },
);
