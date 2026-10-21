import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, open } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const binary = resolve('supervisor/target/debug/constellation-supervisor');

// R7: a damaged data file does not stop Lascoria for good. It is set aside, the service starts
// with empty data and points at the newest backup, and restoring that backup brings the work
// back. Data from a newer version is not treated as damage: the service stops and says why.
test('a damaged data file is kept aside and the newest backup restores the work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-recover-'));
  const directory = join(root, 'state');
  const workspace = join(root, 'work');
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  let daemon;
  const start = () => (daemon = spawn(binary, [], { env, stdio: 'ignore' }));
  const stop = async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const exit = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await bounded(exit, 10000).catch(() => daemon.kill('SIGKILL'));
  };
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const api = (op, params = {}, id = crypto.randomUUID()) => request(directory, op, params, id);
  async function ready() {
    for (let i = 0; i < 100; i++) {
      const s = await api('status').catch(() => undefined);
      if (s?.pid === daemon.pid) return s;
      await delay(100);
    }
    throw Error('supervisor did not start');
  }

  start();
  await ready();
  await api('start', { workspace, name: 'Kept work' }, 'start');
  const backup = await api('data/backup', {}, 'backup-1');
  await stop();

  // The data file is overwritten with bytes that are not a database.
  const garbage = Buffer.alloc(32768, 0x5a);
  await writeFile(join(directory, 'state.sqlite'), garbage);
  start();
  const fresh = await ready();
  assert.equal(fresh.sessions.length, 0, 'started with empty data');
  assert.equal(fresh.dataRecovery.status, 'damaged');
  assert.equal(fresh.dataRecovery.latestBackup.id, backup.id);
  assert.deepEqual(await readFile(join(directory, fresh.dataRecovery.keptAs)), garbage);

  // Restoring the offered backup brings the session back on the next start.
  await api('data/restore', { backupId: backup.id }, 'restore-1');
  await stop();
  start();
  const restored = await ready();
  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].displayName, 'Kept work');
  assert.equal(restored.dataRecovery, null, 'the restored data has no damage notice');
  await stop();

  // A newer version's data: nothing is moved, and the reason is left for the app to show.
  // SQLite keeps user_version as a big-endian integer at byte 60 of the file header.
  const file = await open(join(directory, 'state.sqlite'), 'r+');
  const version = Buffer.alloc(4);
  version.writeUInt32BE(99);
  await file.write(version, 0, 4, 60);
  await file.close();
  start();
  const code = await bounded(new Promise((r) => daemon.once('exit', r)), 10000);
  assert.notEqual(code, 0);
  const note = JSON.parse(await readFile(join(directory, 'startup-error.json'), 'utf8'));
  assert.match(note.message, /newer version/);
  assert.equal((await readdir(join(directory, 'damaged'))).length, 1, 'nothing else moved');
});
