import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { provider } from '../testing/provider.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A small filesystem of its own for the state folder needs Linux and permission to mount.
function mountable(path) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return false;
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=8m', 'tmpfs', path], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// R7: when the disk holding Lascoria's data fills while Muse works, Muse keeps running, the
// app is told why nothing is being saved, new work is refused with a plain reason, and the
// finished task is saved by itself once space is freed. Previously every host was stopped
// and the session stayed stuck until the service restarted.
test('a full data disk keeps Muse running and saves the waiting result once space returns', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-full-'));
  const disk = join(root, 'disk');
  await mkdir(disk);
  if (!mountable(disk)) {
    t.skip('needs Linux and permission to mount a small tmpfs');
    await rm(root, { recursive: true, force: true });
    return;
  }
  const workspace = join(root, 'work');
  await mkdir(workspace);
  execFileSync('git', ['init', '-q', workspace]);
  const model = await provider(root, { responseDelayMs: 1500 });
  const directory = join(disk, 'state');
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
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
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exit = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await bounded(exit, 10000).catch(() => daemon.kill('SIGKILL'));
    }
    await model.close();
    try {
      execFileSync('umount', [disk], { stdio: 'ignore' });
    } catch {}
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const api = (op, params = {}, id = crypto.randomUUID()) => request(directory, op, params, id);
  async function until(predicate, label) {
    let last;
    for (let i = 0; i < 150; i++) {
      last = await api('status').catch((e) => e.message);
      if (typeof last === 'object' && predicate(last)) return last;
      await delay(100);
    }
    throw Error(`${label}: ${JSON.stringify(last).slice(0, 400)}`);
  }
  await until((s) => s.pid === daemon.pid, 'boot');
  const { sessionId } = await api('start', { workspace }, 'start');
  await until((s) => s.sessions[0]?.state.current, 'ready');
  await api('turn', { sessionId, text: 'A slow task' }, 'slow');
  // Fill the disk while Muse is still working on it.
  try {
    execFileSync('dd', ['if=/dev/zero', `of=${join(disk, 'filler')}`, 'bs=64k'], {
      stdio: 'ignore',
    });
  } catch {}
  const full = await until((s) => s.storage?.unsaved >= 1, 'storage warning');
  assert.match(full.storage.message, /disk is full/);
  assert.equal(full.pid, daemon.pid);
  assert.equal(full.sessions[0].lifecycle, 'connected', 'the host was not stopped');
  await assert.rejects(api('turn', { sessionId, text: 'More' }, 'refused'), /disk is full/);

  await rm(join(disk, 'filler'));
  const saved = await until(
    (s) => !s.storage && s.sessions[0].state.turns.at(-1)?.terminal === 'completed',
    'waiting result saved',
  );
  assert.equal(saved.sessions[0].state.turns.length, 1);
  // Work continues, and the refused request can be sent again with the same identity.
  await api('turn', { sessionId, text: 'More' }, 'refused');
  const next = await until(
    (s) => s.sessions[0].state.turns.length === 2 && s.sessions[0].state.turns[1].terminal,
    'next task',
  );
  assert.equal(next.sessions[0].state.turns[1].terminal, 'completed');
});
