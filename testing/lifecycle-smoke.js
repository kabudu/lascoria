// Native acceptance smoke for the 17 October increments, against an installed-resource layout
// (scripts/package-native-qa.js on macOS/Linux, scripts/package-windows-qa.js on Windows).
// Uses the real Muse binary with its local echo provider: no model provider, credential or
// network. Every step runs in a private temporary state directory that is removed afterwards.
//
//   node testing/lifecycle-smoke.js <app directory> <Muse 1.4.10 binary> [app binary]
//
// Prints one JSON line. `passed` names what ran; `notExercised` names what did not and why.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const app = resolve(process.argv[2] ?? '.');
const muse = resolve(process.argv[3] ?? '');
const desktop = process.argv[4] ? resolve(process.argv[4]) : null;
const windows = process.platform === 'win32';
const exe = (name) => (windows ? `${name}.exe` : name);
const { request } = await import(pathToFileURL(join(app, 'runtime/workers/client.js')).href);
// Short prefix: macOS limits Unix socket paths to 104 bytes.
const root = await mkdtemp(join(tmpdir(), 'lsc-acc-'));
const passed = [];
const notExercised = [];
let daemon;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(action, predicate, label, attempts = 300) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (e) {
      last = e.message;
    }
    await delay(100);
  }
  throw Error(`${label}: ${JSON.stringify(last)?.slice(0, 500)}`);
}
async function stop() {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const done = new Promise((r) => daemon.once('exit', r));
    daemon.kill();
    await done;
  }
}
function spawnSupervisor(state, extra = {}) {
  const child = spawn(join(app, 'runtime', exe('constellation-supervisor')), [], {
    env: {
      ...process.env,
      SCH_AUTH_MANAGED: '',
      SCH_STATE_DIR: state,
      SCH_RESOURCES: windows ? '\\\\?\\' + join(app, 'runtime') : join(app, 'runtime'),
      SCH_NODE: process.execPath,
      SCH_PROVIDER: 'echo',
      MUSE_BIN: muse,
      MUSE_NO_AUTO_UPDATE: '1',
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      ...extra,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  child.stderr.on('data', (data) => process.stderr.write(data));
  return child;
}
function boot(state, extra = {}) {
  daemon = spawnSupervisor(state, extra);
  return until(
    () => request(state, 'status'),
    (s) => s.pid === daemon.pid,
    'supervisor ready',
  );
}
const state = join(root, 'state');
const status = () => request(state, 'status');
const row = async (id) => (await status()).sessions.find((s) => s.id === id);
async function settled(sessionId, turns) {
  return until(
    () => row(sessionId),
    (s) =>
      s?.state.current &&
      s.state.turns?.length >= turns &&
      s.state.turns.at(-1).terminal &&
      !s.state.activeTurnId,
    `turn ${turns} settles`,
  );
}

try {
  const workspace = join(root, 'workspace');
  const outside = join(root, 'exports');
  await mkdir(workspace);
  await mkdir(outside);
  const version = execFileSync(muse, ['--version'], { encoding: 'utf8' }).trim();
  assert.match(version, /1\.4\.10/, `Muse 1.4.10 required, found ${version}`);
  await boot(state);
  passed.push('supervisor/installed-resources');

  // A session with one real echo task, then an image sent with a second task.
  const first = (await request(state, 'start', { workspace, name: 'Acceptance A' }, 'acc-start'))
    .sessionId;
  await until(
    () => row(first),
    (s) => s?.state.current,
    'session current',
  );
  await request(state, 'turn', { sessionId: first, text: 'Acceptance marker alpha' }, 'acc-t1');
  await settled(first, 1);
  passed.push('Muse/echo-turn');

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  const attachmentId = randomUUID();
  await request(state, 'attachment/begin', {
    sessionId: first,
    attachmentId,
    name: 'pixel.png',
    bytes: png.length,
  });
  await request(state, 'attachment/append', {
    sessionId: first,
    attachmentId,
    offset: 0,
    data: png.toString('base64'),
  });
  await request(state, 'attachment/finish', {
    sessionId: first,
    attachmentId,
    sha256: createHash('sha256').update(png).digest('hex'),
  });
  assert.equal(
    (await request(state, 'attachment/list', { sessionId: first })).attachments.length,
    1,
  );
  await request(
    state,
    'turn',
    { sessionId: first, text: 'Describe the picture', attachments: [attachmentId] },
    'acc-t2',
  );
  await settled(first, 2);
  await until(
    () => request(state, 'attachment/list', { sessionId: first }),
    (r) => r.attachments.length === 0,
    'sent image leaves the composer',
  );
  passed.push('images/stage-send-clear');

  // D3: transcript export, search and continuation without a model turn.
  const transcript = join(outside, 'acceptance.md');
  await request(state, 'data/transcript', { sessionId: first, path: transcript }, 'acc-md');
  const markdown = await readFile(transcript, 'utf8');
  assert.match(markdown, /Acceptance marker alpha/);
  if (!windows) assert.equal((await stat(transcript)).mode & 0o077, 0, 'transcript is private');
  passed.push('transcript/export');
  const found = await request(state, 'search', { query: 'MARKER ALPHA' });
  assert.ok(
    found.results.some((r) => r.sessionId === first),
    JSON.stringify(found),
  );
  passed.push('search/case-insensitive');
  await request(state, 'session/archive', { sessionId: first }, 'acc-archive');
  await until(
    () => row(first),
    (s) => s?.lifecycle === 'archived',
    'archived',
  );
  const turnsBefore = (await status()).commands.filter((c) => c.operation === 'turn').length;
  const second = (
    await request(state, 'start', { workspace, continuedFrom: first }, 'acc-continue')
  ).sessionId;
  await until(
    () => row(second),
    (s) => s?.state.current,
    'continuation current',
  );
  assert.equal((await row(second)).continuedFrom, first);
  assert.equal(
    (await status()).commands.filter((c) => c.operation === 'turn').length,
    turnsBefore,
    'continuing starts no model turn',
  );
  passed.push('continuation/no-model-turn');

  // R5: backup, export outside private state, import, staged restore applied on restart.
  const backup = await request(state, 'data/backup', {}, 'acc-backup');
  assert.ok(backup.sha256);
  const exported = join(outside, 'lascoria-backup.sqlite');
  await request(state, 'data/export', { backupId: backup.id, path: exported }, 'acc-export');
  if (!windows) assert.equal((await stat(exported)).mode & 0o077, 0, 'export is private');
  const imported = await request(state, 'data/import', { path: exported }, 'acc-import');
  assert.equal(imported.sha256, backup.sha256);
  passed.push('data/backup-export-import');
  await request(state, 'session/archive', { sessionId: second }, 'acc-archive-2');
  await until(
    () => row(second),
    (s) => s?.lifecycle === 'archived',
    'second archived',
  );
  await request(state, 'data/removeArchived', { sessionIds: [second] }, 'acc-remove');
  assert.equal(await row(second), undefined);
  await request(state, 'data/restore', { backupId: imported.id }, 'acc-restore');
  assert.ok((await request(state, 'data/summary')).pendingRestore);
  await stop();
  await boot(state);
  const restored = await request(state, 'data/summary');
  assert.equal(restored.pendingRestore ?? null, null);
  assert.ok(await row(second), 'restored journal has the removed session again');
  assert.ok(
    restored.backups.some((b) => b.reason === 'beforeRestore'),
    'safety backup made before the swap',
  );
  passed.push('data/remove-restore-on-restart');

  // F1: control bound to a named desktop executable, exercising the operating system's
  // peer-process lookup in both directions.
  await stop();
  if (desktop) {
    // The named desktop is the real app binary, so this Node client must be refused.
    daemon = spawnSupervisor(join(root, 'bound'), { SCH_DESKTOP_EXE: desktop });
    const refusal = await until(
      () =>
        request(join(root, 'bound'), 'status').then(
          () => 'accepted',
          (e) => e.message,
        ),
      (m) => /Only the Lascoria app|accepted/.test(m),
      'bound supervisor answers',
    );
    assert.match(refusal, /Only the Lascoria app can control its background service/);
    passed.push('peer/foreign-client-refused');
    await stop();
  } else
    notExercised.push('peer/foreign-client-refused: pass the app binary as the third argument');
  // The named desktop is a copy of this Node binary at another path: accepted by content.
  const standIn = join(root, exe('desktop-stand-in'));
  await copyFile(process.execPath, standIn);
  await boot(join(root, 'bound-node'), { SCH_DESKTOP_EXE: standIn });
  passed.push('peer/desktop-accepted-by-content');
  await stop();

  console.log(
    JSON.stringify({
      result: 'PASS',
      passed,
      notExercised,
      platform: process.platform,
      arch: process.arch,
      muse: version,
    }),
  );
} finally {
  await stop();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
