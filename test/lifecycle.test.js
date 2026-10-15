import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { request } from '../src/client.js';
import { provider } from '../testing/provider.js';

async function eventually(fn, predicate, label, ms = 20000) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    try {
      value = await fn();
      if (predicate(value)) return value;
    } catch (error) {
      value = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
async function exit(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  await done;
}

test(
  'real Muse: detached client, commands, approval, host death and supervisor restart',
  { timeout: 100000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-stage-a-'));
    const workspace = join(root, 'workspace');
    const directory = join(root, 'state');
    await mkdir(workspace);
    const model = await provider(root);
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'meta',
      ...model.env, // Environment-only fake credential; never migrate into the user's Keychain.
    };
    const errors = [];
    const boot = () => {
      const child = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stderr.on('data', (c) => errors.push(c.toString()));
      return child;
    };
    let daemon = boot();
    t.after(async () => {
      await exit(daemon);
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    await eventually(
      () => request(directory, 'status'),
      (v) => v.pid === daemon.pid,
      'supervisor ready',
    );
    for (const [path, mode] of [
      ['', 0o700],
      ['supervisor.sock', 0o600],
      ['token', 0o600],
      ['state.sqlite', 0o600],
    ])
      assert.equal((await stat(join(directory, path))).mode & 0o777, mode);
    const second = boot();
    await new Promise((resolve) => second.once('exit', resolve));
    assert.notEqual(second.exitCode, 0, 'duplicate supervisor refused');
    const started = await request(directory, 'start', { workspace }, 'session-one');
    assert.equal(started.status, 'applied', JSON.stringify(started));
    const sessionId = started.sessionId;
    assert.deepEqual(await request(directory, 'start', { workspace }, 'session-one'), started);
    await assert.rejects(
      request(directory, 'start', { workspace: root }, 'session-one'),
      /different payload/,
    );
    let turn = await request(directory, 'turn', { sessionId, text: 'STAGE_A_STEER' }, 'turn-one');
    assert.equal(turn.status, 'accepted');
    const turnId = turn.result.turnId;
    await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].state.activeTurnId === turnId,
      'active turn',
    );
    const steer = await request(
      directory,
      'steer',
      { sessionId, turnId, text: 'additional instruction' },
      'steer-one',
    );
    assert.ok(['accepted', 'applied'].includes(steer.status), JSON.stringify(steer));
    assert.equal(steer.result.turnId, turnId);
    const cancelled = await request(directory, 'cancel', { sessionId, turnId }, 'cancel-one');
    assert.ok(['accepted', 'applied'].includes(cancelled.status), JSON.stringify(cancelled));
    const cancelledState = await eventually(
      () => request(directory, 'status'),
      (v) => !v.sessions[0].state.activeTurnId,
      'cancel terminal',
    );
    assert.equal(
      cancelledState.sessions[0].state.turns.find((entry) => entry.turnId === turnId).terminal,
      'cancelled',
    );
    await request(directory, 'turn', { sessionId, text: 'STAGE_A_INPUT' }, 'input-turn');
    const inputState = await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].state.userInputs.length > 0,
      'user input request',
    );
    const input = inputState.sessions[0].state.userInputs[0];
    const answered = await request(
      directory,
      'answer',
      {
        sessionId,
        userInputId: input.userInputId,
        answers: [{ questionId: input.questions[0].id, selectedLabel: 'Alpha' }],
      },
      'answer-one',
    );
    assert.ok(['accepted', 'applied'].includes(answered.status), JSON.stringify(answered));
    await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].state.userInputs.length === 0 && !v.sessions[0].state.activeTurnId,
      'input settlement',
    );
    // Each diagnostic call opens and closes a socket. Execution has continued between calls.
    turn = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_A_APPROVAL' },
      'approval-turn',
    );
    assert.equal(turn.status, 'accepted');
    let state = await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].state.approvals.length > 0,
      'pending approval',
    );
    const approval = state.sessions[0].state.approvals[0].requested;
    const invalid = await request(
      directory,
      'decide',
      {
        sessionId,
        approvalId: approval.approvalId,
        requirementId: { ...approval.currentRequirementId, sourceIndex: -1 },
        choiceId: approval.availableChoices[0].choiceId,
      },
      'stale-decision',
    );
    assert.equal(invalid.status, 'rejected');
    const choice = approval.availableChoices.find((c) => c.decision === 'approved');
    assert.ok(choice);
    const decisionParams = {
      sessionId,
      approvalId: approval.approvalId,
      requirementId: approval.currentRequirementId,
      choiceId: choice.choiceId,
    };
    const decision = await request(directory, 'decide', decisionParams, 'decision-one');
    assert.ok(['accepted', 'applied'].includes(decision.status), JSON.stringify(decision));
    await request(directory, 'decide', decisionParams, 'decision-one');
    await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].state.approvals.length === 0 && !v.sessions[0].state.activeTurnId,
      'decision settles',
    );
    assert.equal(
      await readFile(join(workspace, 'approval-count.txt'), 'utf8'),
      'approved',
      'tool side effect exactly once',
    );
    await request(directory, 'turn', { sessionId, text: 'STAGE_A_APPROVAL_2' }, 'restart-turn');
    state = await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].state.approvals.length > 0,
      'second approval',
    );
    const old = state.sessions[0].state.approvals[0].requested;
    // The installed host aborts an approval when its stdio owner dies. Recovery must expose that fact.
    await exit(daemon, 'SIGKILL');
    daemon = boot();
    state = await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0]?.lifecycle === 'connected',
      'restart converges',
      30000,
    );
    assert.ok(state.sessions[0].interruptions.some((i) => i.kind === 'supervisorRestart'));
    assert.equal(
      state.sessions[0].state.approvals.length,
      0,
      'aborted approval is not offered again',
    );
    const stale = await request(
      directory,
      'decide',
      {
        sessionId,
        approvalId: old.approvalId,
        requirementId: old.currentRequirementId,
        choiceId: old.availableChoices[0].choiceId,
      },
      'old-decision',
    );
    assert.equal(stale.status, 'rejected');
    assert.equal(
      await readFile(join(workspace, 'approval-count.txt'), 'utf8'),
      'approved',
      'restart never replays the tool',
    );
    await request(directory, 'turn', { sessionId, text: 'STAGE_A_CRASH' }, 'crash-turn');
    // Kill the actual Muse host, identified only among this daemon's child tree.
    const nodePid = Number(
      execFileSync('pgrep', ['-P', String(daemon.pid)], { encoding: 'utf8' })
        .trim()
        .split('\n')[0],
    );
    const musePid = Number(
      execFileSync('pgrep', ['-P', String(nodePid)], { encoding: 'utf8' })
        .trim()
        .split('\n')[0],
    );
    process.kill(musePid, 'SIGKILL');
    state = await eventually(
      () => request(directory, 'status'),
      (v) =>
        v.sessions[0].lifecycle === 'connected' &&
        v.sessions[0].interruptions.some((i) => i.kind !== 'supervisorRestart'),
      'host recovery',
      30000,
    );
    assert.equal(await readFile(join(workspace, 'approval-count.txt'), 'utf8'), 'approved');
    assert.ok(
      state.sessions[0].interruptions.some(
        (exit) => exit.kind === 'crash' && exit.exitSignal === 'SIGKILL',
      ),
    );
    assert.ok(state.commands.some((c) => c.id === 'crash-turn'));
    const before = state.sessions[0].state.items;
    await exit(daemon);
    daemon = boot();
    state = await eventually(
      () => request(directory, 'status'),
      (v) => v.sessions[0].lifecycle === 'connected',
      'durable resume',
    );
    assert.deepEqual(
      state.sessions[0].state.items,
      before,
      'cold replay and live projection converge',
    );
    assert.ok(!errors.some((e) => e.includes('panicked')), errors.join(''));
  },
);
