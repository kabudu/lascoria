import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
test(
  'conditional status authenticates first, invalidates on writes and never reuses an epoch after restart',
  { timeout: 25000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-status-')),
      directory = join(root, 'state'),
      workspace = join(root, 'workspace');
    await mkdir(workspace);
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'echo',
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    const boot = () =>
      spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: 'ignore',
      });
    let daemon = boot();
    async function ready() {
      for (let i = 0; i < 100; i++) {
        try {
          const s = await request(directory, 'status');
          if (s.pid === daemon.pid) return s;
        } catch {}
        await delay(100);
      }
      throw Error('Not ready');
    }
    async function stop() {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return;
      const exit = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await bounded(exit, 10000);
    }
    t.after(async () => {
      await stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const first = await ready();
    assert.equal(typeof first.version, 'string');
    assert.deepEqual(await request(directory, 'status', { since: first.version }), {
      unchanged: true,
      version: first.version,
      pid: daemon.pid,
    });
    const rejected = await bounded(
      new Promise((resolve, reject) => {
        const socket = net.createConnection(join(directory, 'supervisor.sock'));
        let text = '';
        socket.on('error', reject);
        socket.on('connect', () =>
          socket.write(
            JSON.stringify({
              version: 1,
              token: 'wrong',
              operation: 'status',
              params: { since: first.version },
            }) + '\n',
          ),
        );
        socket.on('data', (data) => (text += data));
        socket.on('end', () => resolve(JSON.parse(text)));
      }),
      2000,
    );
    assert.match(rejected.error, /authentication/);
    assert.equal(rejected.result, undefined);
    const started = await request(directory, 'start', { workspace });
    await request(directory, 'turn', {
      sessionId: started.sessionId,
      text: 'Persist conditional-status fixture',
    });
    let changed;
    for (let i = 0; i < 100; i++) {
      changed = await request(directory, 'status', { since: first.version });
      if (changed.sessions[0].state.turns.at(-1)?.terminal === 'completed') break;
      await delay(100);
    }
    assert.equal(changed.unchanged, undefined);
    assert.notEqual(changed.version, first.version);
    assert.equal(changed.sessions[0].state.turns.at(-1).terminal, 'completed');
    // R8: before any host reports, account usage is unknown (null), never 0%. A session read
    // answers with the same account-scoped reading the supervisor serves without a host.
    assert.ok(changed.features.includes('usageLatest'));
    const read = await request(directory, 'usage', { sessionId: started.sessionId });
    assert.ok('usage' in read);
    assert.deepEqual(await request(directory, 'usage/latest'), read);
    const old = changed.version;
    await stop();
    daemon = boot();
    const restarted = await ready();
    assert.notEqual(restarted.version.split(':')[0], old.split(':')[0]);
    const fresh = await request(directory, 'status', { since: old });
    assert.equal(fresh.unchanged, undefined);
    assert.equal(fresh.sessions[0].id, started.sessionId);
  },
);
