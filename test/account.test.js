import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(directory, check) {
  let value;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      value = await request(directory, 'status', {}, undefined, 500);
      if (check(value)) return value;
    } catch {}
    await delay(50);
  }
  throw Error(JSON.stringify(value));
}
test(
  'account policy: subscription priority, Keychain isolation, restart, logout barrier and no secret journal',
  { timeout: 45000, skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-account-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'workspace');
    await mkdir(workspace);
    const secret = 'fixture-key-never-journal-this';
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_AUTH_MANAGED: '1',
      SCH_ACCOUNT_WORKER: resolve('testing/account-worker.js'),
      SCH_WORKER: resolve('testing/scheduling-worker.js'),
      SCH_SCHEDULING_LOG: join(root, 'calls'),
    };
    const boot = () =>
      spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: 'ignore',
      });
    let daemon = boot();
    async function stop() {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return;
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await bounded(exited, 15000);
    }
    t.after(async () => {
      try {
        await request(directory, 'account/forgetKey');
      } catch {}
      await stop();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await until(directory, (s) => s.pid === daemon.pid);
    assert.equal((await request(directory, 'account/status')).authenticated, false);
    await assert.rejects(request(directory, 'start', { workspace }), /Sign in/);
    let auth = await request(directory, 'account/setKey', { apiKey: secret });
    assert.equal(auth.mode, 'apiKey');
    assert.equal(auth.authenticated, true);
    const id = (await request(directory, 'start', { workspace })).sessionId;
    const before = await request(directory, 'status');
    await assert.rejects(
      request(directory, 'account/setKey', { apiKey: 'bad\nkey' }),
      /Invalid API key/,
    );
    assert.equal(
      (await request(directory, 'status')).sessions[0].generation,
      before.sessions[0].generation,
    );
    await request(directory, 'account/login');
    auth = await request(directory, 'account/status');
    assert.equal(auth.mode, 'subscription');
    assert.equal(auth.keyConfigured, true);
    assert.equal(auth.authenticated, true);
    await until(
      directory,
      (s) =>
        s.sessions[0].generation > before.sessions[0].generation &&
        s.sessions[0].lifecycle === 'connected',
    );
    const generation = (await request(directory, 'status')).sessions[0].generation;
    await request(directory, 'account/setKey', { apiKey: secret });
    assert.equal((await request(directory, 'account/status')).mode, 'subscription');
    await assert.rejects(request(directory, 'account/useKey'), /Sign out of your subscription/);
    assert.equal(
      (await request(directory, 'status')).sessions[0].generation,
      generation,
      'saving an inactive key does not restart hosts',
    );
    await request(directory, 'turn', { sessionId: id, text: 'auth-failure' });
    for (let i = 0; i < 50; i++) {
      auth = await request(directory, 'account/status');
      if (auth.reconnectRequired) break;
      await delay(100);
    }
    assert.equal(auth.reconnectRequired, true);
    assert.equal(auth.authenticated, false);
    assert.equal(auth.mode, 'subscription');
    assert.equal(auth.keyConfigured, true);
    await assert.rejects(
      request(directory, 'turn', { sessionId: id, text: 'no silent fallback' }),
      /Sign in/,
    );
    await request(directory, 'account/login');
    assert.equal(
      (await request(directory, 'account/status')).authenticated,
      true,
      'fresh login clears old auth failure',
    );
    await stop();
    daemon = boot();
    await until(directory, (s) => s.pid === daemon.pid && s.sessions[0].lifecycle === 'connected');
    assert.equal((await request(directory, 'account/status')).mode, 'subscription');
    await writeFile(join(directory, 'account-config', 'fail-cancel'), '1');
    await assert.rejects(request(directory, 'account/logout'), /could not be confirmed/);
    auth = await request(directory, 'account/status');
    assert.equal(auth.authenticated, false);
    assert.equal(auth.logoutPending, true, 'failed host cleanup remains visibly pending');
    auth = await request(directory, 'account/logout');
    assert.equal(auth.authenticated, false);
    assert.equal(
      JSON.parse(await readFile(join(directory, 'account-config', 'fixture.json'), 'utf8'))
        .signedIn,
      true,
      'local logout retains shared Muse credential',
    );
    assert.equal(auth.keyConfigured, true);
    await assert.rejects(
      request(directory, 'turn', { sessionId: id, text: 'must not run' }),
      /Sign in/,
    );
    const after = await request(directory, 'status');
    await delay(1500);
    assert.equal(
      (await request(directory, 'status')).sessions[0].generation,
      after.sessions[0].generation,
      'logout suppresses recovery',
    );
    assert.ok(
      !(await readFile(join(directory, 'state.sqlite'))).includes(Buffer.from(secret)),
      'secret not in SQLite',
    );
    assert.ok(
      !(await readFile(join(root, 'calls'), 'utf8')).includes(secret),
      'secret not in worker protocol',
    );
    await stop();
    daemon = boot();
    await until(directory, (s) => s.pid === daemon.pid);
    assert.equal(
      (await request(directory, 'account/status')).authenticated,
      false,
      'logout survives restart despite saved key',
    );
    await writeFile(join(directory, 'account-config', 'hold-login'), '1');
    await request(directory, 'account/login');
    assert.equal(
      (await request(directory, 'account/status')).authenticated,
      false,
      'cached Muse login cannot grant a fresh pending flow',
    );
    await stop();
    daemon = boot();
    await until(directory, (s) => s.pid === daemon.pid);
    assert.equal(
      (await request(directory, 'account/status')).authenticated,
      false,
      'restart cannot bypass incomplete browser approval',
    );
    await request(directory, 'account/logout');
    await rm(join(directory, 'account-config', 'hold-login'));
    await request(directory, 'account/useKey');
    assert.equal((await request(directory, 'account/status')).mode, 'apiKey');
    await request(directory, 'account/forgetKey');
    auth = await request(directory, 'account/status');
    assert.equal(auth.keyConfigured, false);
    assert.equal(auth.authenticated, false);
  },
);
