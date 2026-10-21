// Opt-in live trial. Prompts are fixed; credentials remain entirely with Muse.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, writeFile, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { platform, release, arch } from 'node:os';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const live = process.env.SCH_TRIAL_PROVIDER === 'meta';
const keep = process.env.SCH_TRIAL_KEEP === '1';
const modelId = process.env.SCH_TRIAL_MODEL ?? (live ? 'muse-wonder-1.0' : undefined);
await mkdir('.dev', { recursive: true });
const root = await mkdtemp(resolve('.dev/concurrent-trial-'));
const directory = join(root, 'state'),
  workspace = join(root, 'workspace');
await mkdir(workspace);
const log = await open(join(root, 'supervisor.log'), 'a');
const env = { ...process.env, SCH_STATE_DIR: directory, SCH_PROVIDER: live ? 'meta' : 'echo' };
delete env.META_API_KEY; // A shell API key must not override the user's stored subscription login.
if (!live) {
  env.XDG_CONFIG_HOME = join(root, 'config');
  env.XDG_DATA_HOME = join(root, 'data');
  env.XDG_CACHE_HOME = join(root, 'cache');
}
const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
  env,
  detached: true,
  stdio: ['ignore', log.fd, log.fd],
});
let succeeded = false;
let frozen;
const report = {
  provider: live ? 'meta' : 'echo',
  modelId,
  sessions: 3,
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    node: process.versions.node,
  },
  gates: {},
};
const status = () => request(directory, 'status');
async function until(check, label, ms = 120000) {
  let state;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      state = await status();
      if (check(state)) return state;
    } catch (e) {
      state = e.message;
    }
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(state)}`);
}
const row = (s, id) => s.sessions.find((r) => r.id === id);
const terminal = (s, id, turnId) =>
  row(s, id)?.state.turns.find((t) => t.turnId === turnId)?.terminal;
try {
  await until((s) => s.pid === daemon.pid, 'ready', 10000);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const started = await request(directory, 'start', {
      workspace,
      ...(modelId ? { modelId } : {}),
    });
    assert.equal(started.status, 'applied', JSON.stringify(started));
    ids.push(started.sessionId);
  }
  const initial = await status();
  report.museVersion = row(initial, ids[0]).handshake.serverInfo.version;
  if (live) assert.ok(ids.every((id) => row(initial, id).state.modelRoute.modelId === modelId));
  const broker = row(initial, ids[0]).state.diagnostics.processId;
  const { stdout } = await exec('pgrep', ['-P', String(broker)]);
  frozen = Number(stdout.trim().split('\n')[0]);
  assert.ok(Number.isInteger(frozen) && frozen > 1);
  let settled = false;
  process.kill(frozen, 'SIGSTOP');
  const blocked = request(directory, 'models', { sessionId: ids[0] }).finally(() => {
    settled = true;
  });
  try {
    await delay(250);
    assert.equal(settled, false, 'native request is blocked');
    const began = performance.now();
    const peer = await request(directory, 'models', { sessionId: ids[1] });
    assert.ok(Array.isArray(peer.models));
    if (live) assert.ok(peer.models.length > 0);
    report.peerReadMsDuringBlockedHost = performance.now() - began;
    assert.ok(report.peerReadMsDuringBlockedHost < 1500);
    assert.equal(settled, false, 'peer read finished before blocked native call');
    report.gates.blockedHostIsolation = true;
  } finally {
    process.kill(frozen, 'SIGCONT');
    frozen = undefined;
    await blocked;
  }
  const prompts = [
    'Concurrency trial A. Without using tools, explain why checking a concurrency limit before an await can admit too many jobs, and give a minimal correction. Keep the answer under 120 words.',
    'Concurrency trial B. Without using tools, give three invariants for a bounded per-session FIFO scheduler that recovers one session without blocking others. Keep the answer under 120 words.',
    'Concurrency trial C. Without using tools, explain the difference between an uncertain command outcome and a rejected command, and when retry is safe. Keep the answer under 120 words.',
  ];
  const began = performance.now();
  const turns = await Promise.all(
    ids.map((sessionId, i) => request(directory, 'turn', { sessionId, text: prompts[i] })),
  );
  for (const turn of turns)
    assert.ok(['accepted', 'applied'].includes(turn.status), JSON.stringify(turn));
  report.concurrentAdmissionMs = performance.now() - began;
  const completed = await until(
    (s) =>
      ids.every(
        (id, i) => terminal(s, id, turns[i].result.turnId) && !row(s, id).state.activeTurnId,
      ),
    'three terminal turns',
  );
  assert.ok(
    ids.every((id, i) => terminal(completed, id, turns[i].result.turnId) === 'completed'),
    'all live turns completed successfully',
  );
  report.gates.concurrentTurnsCompleted = true;
  const generations = ids.map((id) => row(completed, id).generation);
  // Fail one of our own native hosts, then prove both peers stay usable during repair.
  const hosts = (await exec('pgrep', ['-P', String(broker)])).stdout.trim().split('\n').map(Number);
  process.kill(hosts[0], 'SIGKILL');
  const peerStart = performance.now();
  await request(directory, 'models', { sessionId: ids[1] });
  report.peerReadMsDuringRecovery = performance.now() - peerStart;
  assert.ok(report.peerReadMsDuringRecovery < 1500);
  const recovered = await until(
    (s) =>
      row(s, ids[0]).generation > generations[0] &&
      s.sessions.every((r) => r.lifecycle === 'connected' && r.state.current),
    'isolated native recovery',
  );
  assert.deepEqual(
    ids.slice(1).map((id) => row(recovered, id).generation),
    generations.slice(1),
  );
  report.gates.isolatedRecovery = true;
  const final = await request(directory, 'turn', {
    sessionId: ids[0],
    text: 'Post-recovery check. Without tools, reply with RECOVERY_OK and one sentence explaining why uncertain side effects must not be replayed automatically.',
  });
  const finalState = await until(
    (s) => terminal(s, ids[0], final.result.turnId),
    'post-recovery turn',
  );
  assert.equal(terminal(finalState, ids[0], final.result.turnId), 'completed');
  report.gates.postRecoveryTurnCompleted = true;
  if (live) assert.equal(row(finalState, ids[0]).state.modelRoute.modelId, modelId);
  report.diagnostics = await request(directory, 'diagnostics');
  succeeded = true;
  console.log(JSON.stringify({ directory, report }, null, 2));
} finally {
  report.outcome = succeeded ? 'passed' : 'failed';
  if (frozen) {
    try {
      process.kill(frozen, 'SIGCONT');
    } catch {}
  }
  if (!keep || !succeeded) {
    try {
      const s = await status();
      await request(directory, 'stop', { sessions: s.sessions.map((r) => r.id) });
    } catch {
      daemon.kill('SIGTERM');
    }
    if (daemon.exitCode === null && daemon.signalCode === null)
      await bounded(new Promise((resolve) => daemon.once('exit', resolve)), 20000).catch(() =>
        daemon.kill('SIGKILL'),
      );
  } else daemon.unref();
  await log.close();
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
