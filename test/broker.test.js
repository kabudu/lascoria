import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { provider } from '../testing/provider.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(directory, check, label) {
  let state;
  for (let i = 0; i < 300; i++) {
    try {
      state = await request(directory, 'status');
      if (check(state)) return state;
    } catch {}
    await delay(100);
  }
  throw Error(label + ': ' + JSON.stringify(state));
}
const children = (pid) =>
  execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(Number);
test(
  'shared SDK broker: routing, model/effort durability, isolated host failure and broker-wide recovery without replay',
  { timeout: 100000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-broker-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'workspace');
    await mkdir(workspace);
    const model = await provider(root, { modelSettings: true });
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        SCH_STATE_DIR: directory,
        SCH_PROVIDER: 'meta',
        ...model.env, // Environment-only fake credential; never migrate into the user's Keychain.
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
      stdio: 'ignore',
    });
    t.after(async () => {
      try {
        const s = await request(directory, 'status');
        await request(directory, 'stop', { sessions: s.sessions.map((r) => r.id) });
      } catch {
        daemon.kill('SIGTERM');
      }
      if (daemon.exitCode === null && daemon.signalCode === null)
        await bounded(new Promise((r) => daemon.once('exit', r)), 15000).catch(() =>
          daemon.kill('SIGKILL'),
        );
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await until(directory, (s) => s.pid === daemon.pid, 'ready');
    const a = (await request(directory, 'start', { workspace, modelId: 'stage-a-fixture' }))
      .sessionId;
    const b = (await request(directory, 'start', { workspace, modelId: 'stage-a-fixture' }))
      .sessionId;
    await request(directory, 'turn', { sessionId: b, text: 'Persist independent second session' });
    await until(
      directory,
      (s) => s.sessions[1].state.turns.at(-1)?.terminal === 'completed',
      'second session persisted',
    );
    let s = await request(directory, 'status');
    assert.equal(new Set(s.sessions.map((r) => r.state.diagnostics.processId)).size, 1);
    assert.equal(children(daemon.pid).length, 1);
    assert.ok(s.sessions.every((r) => r.state.modelRoute.modelId === 'stage-a-fixture'));
    const broker = s.sessions[0].state.diagnostics.processId;
    const catalog = await request(directory, 'models', { sessionId: a });
    assert.ok(catalog.models.some((m) => m.modelId === 'stage-b-alternate'));
    const active = await request(directory, 'turn', { sessionId: a, text: 'STAGE_A_STEER' });
    await until(
      directory,
      (s) => s.sessions[0].state.activeTurnId === active.result.turnId,
      'active before settings',
    );
    const set = await request(
      directory,
      'setModel',
      { sessionId: a, modelId: 'stage-b-alternate' },
      'switch-model',
    );
    assert.ok(['applied', 'accepted'].includes(set.status), JSON.stringify(set));
    assert.deepEqual(
      await request(
        directory,
        'setModel',
        { sessionId: a, modelId: 'stage-b-alternate' },
        'switch-model',
      ),
      set,
    );
    await assert.rejects(
      request(directory, 'setModel', { sessionId: a, modelId: 'stage-a-fixture' }, 'switch-model'),
      /different payload/,
    );
    await until(
      directory,
      (s) => s.sessions[0].state.modelRoute?.modelId === 'stage-b-alternate',
      'model observed',
    );
    const effort = await request(directory, 'setEffort', { sessionId: a, reasoningEffort: 'low' });
    assert.ok(['applied', 'accepted'].includes(effort.status), JSON.stringify(effort));
    await until(directory, (s) => s.sessions[0].state.reasoningEffort === 'low', 'effort observed');
    assert.equal(
      (await request(directory, 'setEffort', { sessionId: a, reasoningEffort: 'invented' })).status,
      'rejected',
    );
    assert.equal(
      (await request(directory, 'setModel', { sessionId: a, modelId: 'invented' })).status,
      'rejected',
    );
    await request(directory, 'cancel', { sessionId: a, turnId: active.result.turnId });
    await until(directory, (s) => !s.sessions[0].state.activeTurnId, 'cancel settings trial');
    // Actual side effect through Muse with native permission acknowledgement.
    await request(directory, 'turn', { sessionId: a, text: 'STAGE_A_APPROVAL' });
    s = await until(directory, (s) => s.sessions[0].state.approvals.length, 'approval');
    const approval = s.sessions[0].state.approvals[0].requested;
    await request(directory, 'decide', {
      sessionId: a,
      approvalId: approval.approvalId,
      requirementId: approval.currentRequirementId,
      choiceId: approval.availableChoices.find((c) => c.decision === 'approved').choiceId,
    });
    await until(
      directory,
      (s) => s.sessions[0].state.turns.at(-1)?.terminal === 'completed',
      'artifact done',
    );
    assert.equal(await readFile(join(workspace, 'approval-count.txt'), 'utf8'), 'approved');
    const providerRequest = JSON.parse(model.requests.at(-1));
    assert.equal(providerRequest.model, 'stage-b-alternate');
    assert.equal(providerRequest.reasoning?.effort ?? providerRequest.reasoning_effort, 'low');
    // A frozen native host must not monopolize the supervisor or the shared broker.
    const frozenHost = children(broker)[0];
    let pending;
    let settled = false;
    process.kill(frozenHost, 'SIGSTOP');
    try {
      pending = request(directory, 'models', { sessionId: a }).finally(() => {
        settled = true;
      });
      await delay(250);
      assert.equal(settled, false, 'native request is actually blocked');
      const began = performance.now();
      const peer = await request(directory, 'setModel', {
        sessionId: b,
        modelId: 'stage-a-fixture',
      });
      assert.ok(['applied', 'accepted'].includes(peer.status), JSON.stringify(peer));
      assert.ok(performance.now() - began < 1500, 'peer mutation bypasses frozen native host');
      assert.equal(settled, false, 'peer completes before blocked native request');
    } finally {
      process.kill(frozenHost, 'SIGCONT');
      await pending;
    }
    // One real host dies. Second session retains its worker generation and broker.
    const before = await request(directory, 'status');
    process.kill(children(broker)[0], 'SIGKILL');
    s = await until(
      directory,
      (s) =>
        s.sessions[0].generation > before.sessions[0].generation &&
        s.sessions.every((r) => r.lifecycle === 'connected'),
      'single host recovery',
    );
    assert.equal(s.sessions[1].generation, before.sessions[1].generation);
    assert.equal(s.sessions[1].state.diagnostics.processId, broker);
    assert.equal(s.sessions[0].state.modelRoute.modelId, 'stage-b-alternate');
    assert.equal(s.sessions[0].state.reasoningEffort, 'low');
    // Shared failure is visible for every slot, without retransmitting the tool.
    const generations = s.sessions.map((r) => r.generation);
    process.kill(broker, 'SIGKILL');
    s = await until(
      directory,
      (s) =>
        s.sessions.every(
          (r, i) => r.generation > generations[i] && r.lifecycle === 'connected' && r.state.current,
        ),
      'broker recovery',
    );
    assert.ok(s.sessions.every((r) => r.interruptions.some((i) => i.kind === 'brokerEof')));
    assert.equal(new Set(s.sessions.map((r) => r.state.diagnostics.processId)).size, 1);
    assert.notEqual(s.sessions[0].state.diagnostics.processId, broker);
    assert.equal(s.sessions[0].state.modelRoute.modelId, 'stage-b-alternate');
    assert.equal(s.sessions[0].state.reasoningEffort, 'low');
    assert.equal(s.sessions[1].state.modelRoute.modelId, 'stage-a-fixture');
    assert.equal(s.sessions[1].state.reasoningEffort, undefined);
    assert.equal(await readFile(join(workspace, 'approval-count.txt'), 'utf8'), 'approved');
    assert.equal(
      s.sessions[1].state.items.some((i) => i.kind === 'toolCall'),
      false,
    );
  },
);
