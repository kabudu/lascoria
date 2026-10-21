// Native Windows integration. Requires the real Muse runtime, not a simulated SDK.
// The echo provider makes no external model call. Credential checks use a disposable fixture.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
const app = resolve(process.argv[2]);
const fixture = process.argv[3] === '--fixture';
const muse = fixture ? '' : resolve(process.argv[3]);
const { request } = await import(pathToFileURL(join(app, 'runtime/workers/client.js')).href);
const root = await mkdtemp(join(tmpdir(), 'lascoria-windows-'));
const source = join(root, 'source');
const directory = join(root, 'state');
const passed = [];
let daemon;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(action, predicate, label) {
  let last;
  for (let i = 0; i < 200; i++) {
    try {
      last = await action();
      if (predicate(last)) return last;
    } catch (e) {
      last = e.message;
    }
    await delay(100);
  }
  throw Error(`${label}: ${JSON.stringify(last)}`);
}
async function stop() {
  if (daemon?.exitCode === null && daemon.signalCode === null) {
    const done = new Promise((r) => daemon.once('exit', r));
    daemon.kill();
    await done;
  }
}
function boot(state, extra = {}) {
  daemon = spawn(join(app, 'runtime/constellation-supervisor.exe'), [], {
    env: {
      ...process.env,
      SCH_AUTH_MANAGED: '',
      SCH_STATE_DIR: state,
      // Tauri resolves extended paths on Windows. External Node arguments must be normalised.
      SCH_RESOURCES:
        process.platform === 'win32' ? '\\\\?\\' + join(app, 'runtime') : join(app, 'runtime'),
      SCH_NODE: process.execPath,
      SCH_PROVIDER: 'echo',
      MUSE_BIN: muse,
      ...(fixture ? { SCH_WORKER: join(app, 'testing/uncertain-worker.js') } : {}),
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  daemon.stdout.resume();
  daemon.stderr.on('data', (data) => process.stderr.write(data));
  return until(
    () => request(state, 'status'),
    (s) => s.pid === daemon.pid,
    'supervisor ready',
  );
}
try {
  await mkdir(source);
  const git = (...args) =>
    execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Lascoria QA');
  git('config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(source, 'README.md'), 'Original checkout\n');
  git('add', '.');
  git('commit', '-qm', 'Initial');
  await boot(directory);
  passed.push('supervisor/installed-resources');
  const endpoint = JSON.parse(await readFile(join(directory, 'ipc.json'), 'utf8')).pipe;
  const denied = await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let data = '';
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(Error('authentication timeout'));
    });
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({ version: 1, token: 'wrong', operation: 'status', id: 'bad' }) + '\n',
      ),
    );
    socket.on('data', (chunk) => (data += chunk));
    socket.on('end', () => resolve(JSON.parse(data)));
  });
  assert.match(denied.error, /authentication/);
  passed.push('IPC/reject-unauthenticated');
  const started = await request(
    directory,
    'start',
    { workspace: source, isolated: true },
    'windows-start',
  );
  assert.equal(started.status, 'applied', JSON.stringify(started));
  const sessionId = started.sessionId;
  const status = () => request(directory, 'status');
  if (!fixture) {
    const turn = await request(
      directory,
      'turn',
      { sessionId, text: 'Windows native Muse proof' },
      'windows-turn',
    );
    assert.ok(['applied', 'accepted'].includes(turn.status), JSON.stringify(turn));
    await until(
      status,
      (s) => s.sessions[0].state.turns?.some((t) => t.terminal === 'completed'),
      'real Muse echo turn',
    );
    passed.push('Muse/real-native-turn');
  } else passed.push('control/fixture-state-not-Muse');
  const draft = await request(
    directory,
    'drafts/save',
    { sessionId, text: 'Keep this Windows draft', expectedRevision: 0 },
    'windows-draft',
  );
  assert.equal(draft.revision, 1);
  passed.push('draft/save');
  await request(
    directory,
    'workspace/run',
    { sessionId, command: 'echo PASS_WINDOWS' },
    'windows-command',
  );
  const result = await until(
    status,
    (s) => s.commands.find((c) => c.id === 'windows-command')?.result?.outcome === 'passed',
    'Windows test command',
  );
  assert.match(
    result.commands.find((c) => c.id === 'windows-command').result.stdout,
    /PASS_WINDOWS/,
  );
  passed.push('workspace/cmd-execution');
  const taskWorkspace = (await status()).sessions[0].workspace;
  await mkdir(join(root, 'quoted tools'));
  const testNode = join(root, 'quoted tools/node.exe');
  await copyFile(process.execPath, testNode);
  const childCode =
    "require('fs').writeFileSync('child-started.txt','yes');setTimeout(()=>require('fs').writeFileSync('escaped.txt','bad'),4000);setInterval(()=>{},1000)";
  const parentCode = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`;
  // Use a script file so the test exercises a quoted executable path without nesting JS in cmd syntax.
  await writeFile(join(taskWorkspace, 'timeout-fixture.cjs'), parentCode);
  await request(
    directory,
    'workspace/run',
    { sessionId, command: `"${testNode}" timeout-fixture.cjs`, timeoutSeconds: 2 },
    'windows-timeout',
  );
  await until(
    () => readFile(join(taskWorkspace, 'child-started.txt'), 'utf8'),
    (v) => v === 'yes',
    'descendant actually started',
  );
  await until(
    status,
    (s) => s.commands.find((c) => c.id === 'windows-timeout')?.result?.outcome === 'timedOut',
    'process-tree timeout',
  );
  await delay(4500);
  await assert.rejects(readFile(join(taskWorkspace, 'escaped.txt')), /ENOENT/);
  passed.push('workspace/job-kills-detached-descendant');
  const preview = await request(directory, 'workspace/inspect', { sessionId });
  assert.ok(preview.fingerprint);
  passed.push('workspace/fingerprint');
  await rm(join(taskWorkspace, 'child-started.txt'));
  await request(
    directory,
    'workspace/run',
    { sessionId, command: `"${testNode}" timeout-fixture.cjs` },
    'windows-crash-command',
  );
  await until(
    () => readFile(join(taskWorkspace, 'child-started.txt'), 'utf8'),
    (v) => v === 'yes',
    'crash descendant actually started',
  );
  await stop();
  await delay(4500);
  await assert.rejects(readFile(join(taskWorkspace, 'escaped.txt')), /ENOENT/);
  passed.push('workspace/supervisor-crash-kills-descendant');
  await boot(directory);
  assert.equal(
    (await status()).commands.find((c) => c.id === 'windows-crash-command').status,
    'outcomeUnknown',
  );
  await request(directory, 'stop', { sessions: [sessionId] }, 'windows-stop');
  await until(
    async () => daemon.exitCode !== null || daemon.signalCode !== null,
    Boolean,
    'graceful stop',
  );
  await stop();
  await boot(directory);
  assert.equal(
    (await request(directory, 'drafts/get')).drafts[sessionId].text,
    'Keep this Windows draft',
  );
  passed.push('draft/restart');
  await stop();
  const authDirectory = join(root, 'account');
  await boot(authDirectory, {
    SCH_AUTH_MANAGED: '1',
    SCH_ACCOUNT_WORKER: join(app, 'testing/account-worker.js'),
  });
  await request(authDirectory, 'account/setKey', { apiKey: 'windows-disposable-key-fixture' });
  const account = await request(authDirectory, 'account/status');
  assert.equal(account.keyConfigured, true, JSON.stringify(account));
  passed.push('Credential-Manager/save-read');
  await request(authDirectory, 'account/logout');
  await request(authDirectory, 'account/forgetKey');
  assert.equal((await request(authDirectory, 'account/status')).keyConfigured, false);
  assert.equal(
    (await readFile(join(authDirectory, 'state.sqlite'))).includes(
      Buffer.from('windows-disposable-key-fixture'),
    ),
    false,
  );
  passed.push('Credential-Manager/delete-no-journal-secret');
  console.log(
    JSON.stringify({
      result: 'PASS',
      passed,
      platform: process.platform,
      muse: fixture ? 'NOT EXERCISED: controlled worker' : 'real native echo provider',
      arch: process.arch,
    }),
  );
} finally {
  // Remove only this test's credential, if setup failed partway through.
  const authDirectory = join(root, 'account');
  try {
    await request(authDirectory, 'account/forgetKey');
  } catch {}
  await stop();
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
