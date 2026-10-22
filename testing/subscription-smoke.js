// Native control/vault integration with a controlled account host, not live OAuth.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const app = resolve(process.argv[2]);
const { request } = await import(pathToFileURL(join(app, 'runtime/workers/client.js')));
const temporary = await mkdtemp(join(tmpdir(), 'lascoria-subscription-'));
// Let the supervisor create private state with its explicit owner on Windows.
const root = join(temporary, 'state');
const daemon = spawn(
  join(app, `runtime/constellation-supervisor${process.platform === 'win32' ? '.exe' : ''}`),
  [],
  {
    env: {
      ...process.env,
      SCH_STATE_DIR: root,
      SCH_AUTH_MANAGED: '1',
      SCH_ACCOUNT_WORKER: join(app, 'testing/account-worker.js'),
      SCH_RESOURCES: join(app, 'runtime'),
      SCH_NODE: process.execPath,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  },
);
daemon.stderr.resume();
async function until(action, predicate) {
  let last;
  for (let i = 0; i < 200; i++) {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Subscription control did not converge: ${JSON.stringify(last)}`);
}
try {
  await until(
    () => request(root, 'status'),
    (s) => s.pid === daemon.pid,
  );
  const before = await request(root, 'account/status');
  await request(root, 'account/login');
  const account = await until(
    () => request(root, 'account/status'),
    (s) => s.authenticated,
  );
  assert.equal(account.mode, 'subscription');
  if (before.keyStorageAvailable === false) assert.equal(account.keyConfigured, null);
  await request(root, 'account/logout');
  assert.equal((await request(root, 'account/status')).authenticated, false);
  await request(root, 'stop', { sessions: [] });
  await until(async () => daemon.exitCode !== null || daemon.signalCode !== null, Boolean);
  console.log(
    JSON.stringify({
      result: 'PASS',
      fixture: 'account host',
      vaultAvailable: before.keyStorageAvailable,
      subscriptionIndependent: true,
    }),
  );
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const done = new Promise((r) => daemon.once('exit', r));
    daemon.kill();
    await done;
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
