import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { provider } from '../testing/provider.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, accept) {
  const end = Date.now() + 20000;
  let value;
  while (Date.now() < end) {
    try {
      value = await read();
      if (accept(value)) return value;
    } catch (e) {
      value = e.message;
    }
    await delay(50);
  }
  throw Error('Permission state did not converge: ' + JSON.stringify(value));
}
test(
  'native permission lifecycle: scoped selection, durable recovery, stale confirmation and same-boundary probe',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-permissions-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'workspace');
    await mkdir(workspace);
    const model = await provider(root, { permissionProbe: true });
    const env = {
      ...process.env,
      ...model.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'meta',
      SCH_AUTH_MANAGED: '0',
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    let daemon;
    const launch = () => {
      daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: 'ignore',
      });
    };
    const stop = async () => {
      if (daemon.exitCode !== null) return;
      const done = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await bounded(done, 15000);
    };
    t.after(async () => {
      await stop();
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    launch();
    const status = () => request(directory, 'status');
    await until(status, (s) => s.pid === daemon.pid);
    await assert.rejects(
      request(directory, 'start', { workspace, permissionProfile: ':unrestricted' }),
      /Choose/,
    );
    const first = await request(directory, 'start', { workspace }, 'permission-start');
    assert.equal(first.status, 'applied');
    const sessionId = first.sessionId;
    const other = await request(directory, 'start', { workspace }, 'permission-peer');
    const read = () => request(directory, 'permissions', { sessionId });
    let p = await read();
    assert.equal(p.effective.current, true);
    assert.equal(p.effective.permissionState.profileId, ':ask-me');
    assert.equal(p.profiles.find((r) => r.profileId === ':unrestricted').selectable, false);
    assert.equal(
      model.requests.length,
      0,
      'Reading or changing permission metadata must not call a model',
    );
    const invalid = await request(
      directory,
      'setPermissionProfile',
      { sessionId, profileId: ':read-only', expectedKey: p.effective.key },
      'permission-no-confirm',
    );
    assert.equal(invalid.status, 'rejected');
    const change = {
      sessionId,
      profileId: ':read-only',
      expectedKey: p.effective.key,
      confirmed: true,
    };
    const result = await request(directory, 'setPermissionProfile', change, 'permission-read-only');
    assert.equal(result.status, 'applied');
    assert.deepEqual(
      await request(directory, 'setPermissionProfile', change, 'permission-read-only'),
      result,
      'A lost client reply reconciles the same receipt without replay',
    );
    p = await read();
    assert.equal(p.effective.permissionState.profileId, ':read-only');
    const old = await request(
      directory,
      'setApprovalMode',
      { sessionId, mode: 'allowAll', expectedKey: change.expectedKey, confirmed: true },
      'permission-stale',
    );
    assert.equal(old.status, 'rejected');
    assert.equal(
      (await request(directory, 'permissions', { sessionId: other.sessionId })).effective
        .permissionState.profileId,
      ':ask-me',
    );
    assert.equal(model.requests.length, 0);
    await stop();
    launch();
    await until(
      status,
      (s) => s.pid === daemon.pid && s.sessions.find((r) => r.id === sessionId)?.state.current,
    );
    p = await read();
    assert.equal(p.effective.permissionState.profileId, ':read-only');
    assert.notEqual(
      p.effective.key,
      change.expectedKey,
      'A restart invalidates earlier confirmations',
    );
    const deniedTurn = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_A_APPROVAL' },
      'permission-readonly-write',
    );
    assert.ok(['accepted', 'applied'].includes(deniedTurn.status));
    const readOnlyHold = await until(
      status,
      (s) =>
        s.sessions.find((r) => r.id === sessionId).state.approvals.length > 0 ||
        s.sessions
          .find((r) => r.id === sessionId)
          .state.turns.some((turn) => turn.turnId === deniedTurn.result.turnId && turn.terminal),
    );
    for (const entry of readOnlyHold.sessions.find((r) => r.id === sessionId).state.approvals) {
      const a = entry.requested;
      const allow = a.availableChoices.find((c) => c.scope === 'once' && c.decision === 'approved');
      if (allow) {
        const refused = await request(
          directory,
          'decide',
          {
            sessionId,
            approvalId: a.approvalId,
            requirementId: a.currentRequirementId,
            choiceId: allow.choiceId,
          },
          'readonly-cannot-approve',
        );
        assert.equal(refused.status, 'rejected');
        assert.match(refused.error.message, /Read-only/);
      }
      const deny = a.availableChoices.find(
        (c) => c.decision === 'abort' || c.decision === 'denied',
      );
      assert.ok(deny);
      await request(directory, 'decide', {
        sessionId,
        approvalId: a.approvalId,
        requirementId: a.currentRequirementId,
        choiceId: deny.choiceId,
      });
    }
    await until(status, (s) => !s.sessions.find((r) => r.id === sessionId).state.activeTurnId);
    await assert.rejects(readFile(join(workspace, 'approval-count.txt')), /ENOENT/);
    const restore = await request(
      directory,
      'setPermissionProfile',
      { sessionId, profileId: ':ask-me', expectedKey: p.effective.key, confirmed: true },
      'permission-restore',
    );
    assert.equal(restore.status, 'applied');
    p = await read();
    const strict = await request(
      directory,
      'setApprovalMode',
      { sessionId, mode: 'promptUnmatched', expectedKey: p.effective.key, confirmed: true },
      'permission-strict',
    );
    assert.equal(strict.status, 'applied');
    assert.equal((await read()).effective.approvalMode.mode, 'promptUnmatched');
    const heldTurn = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_A_APPROVAL_2' },
      'permission-held-turn',
    );
    const held = await until(
      status,
      (s) => s.sessions.find((r) => r.id === sessionId).state.approvals.length > 0,
    );
    const heldId = held.sessions.find((r) => r.id === sessionId).state.approvals[0].requested
      .approvalId;
    p = await read();
    await request(
      directory,
      'setApprovalMode',
      { sessionId, mode: 'onRequest', expectedKey: p.effective.key, confirmed: true },
      'permission-normal',
    );
    const pendingAfterMode = (await status()).sessions.find((r) => r.id === sessionId).state
      .approvals;
    assert.ok(
      pendingAfterMode.some((a) => a.requested.approvalId === heldId),
      'Changing mode must not retroactively approve a held command',
    );
    await assert.rejects(readFile(join(workspace, 'approval-count.txt')), /ENOENT/);
    await request(
      directory,
      'cancel',
      { sessionId, turnId: heldTurn.result.turnId },
      'permission-cancel-held',
    );
    await until(status, (s) => !s.sessions.find((r) => r.id === sessionId).state.activeTurnId);
    p = await read();
    const preflightParams = { sessionId, expectedKey: p.effective.key, confirmed: true };
    if (p.effective.sandboxAvailability !== 'available') {
      const calls = model.requests.length;
      const refused = await request(
        directory,
        'permissionPreflight',
        preflightParams,
        'unavailable-probe',
      );
      assert.equal(refused.status, 'rejected');
      assert.equal(
        model.requests.length,
        calls,
        'Unavailable sandbox must fail before a model call',
      );
      t.diagnostic(
        'Native sandbox unavailable on this host: rejection verified; positive sandbox execution not established.',
      );
      return;
    }
    const probe = await request(
      directory,
      'permissionPreflight',
      preflightParams,
      'permission-probe',
    );
    assert.ok(['applied', 'accepted'].includes(probe.status));
    assert.equal(probe.result.permissionProbe.turnId, probe.result.turnId);
    // Only this isolated fixture approves a server-minted one-time request.
    const deadline = Date.now() + 25000;
    let observed;
    while (Date.now() < deadline) {
      const row = (await status()).sessions.find((r) => r.id === sessionId);
      for (const entry of row.state.approvals ?? []) {
        const a = entry.requested;
        const choice = a.availableChoices.find(
          (c) => c.scope === 'once' && c.decision === 'approved',
        );
        assert.ok(choice, 'Probe fixture must never grant a session/persistent allowance');
        await request(directory, 'decide', {
          sessionId,
          approvalId: a.approvalId,
          requirementId: a.currentRequirementId,
          choiceId: choice.choiceId,
        });
      }
      observed = row.state.permissionProbe;
      if (observed?.observed && !row.state.activeTurnId) break;
      await delay(100);
    }
    assert.ok(
      observed?.observed,
      JSON.stringify((await status()).sessions.find((r) => r.id === sessionId).state),
    );
    assert.equal(observed.currentBoundary, true);
    for (const value of Object.values(observed.observed.results))
      assert.ok(['allowed', 'denied', 'notChecked'].includes(value.status));
    assert.equal(
      (await status()).commands.filter((c) => c.operation === 'workspace/run').length,
      0,
    );
    const reconciled = await request(
      directory,
      'permissionPreflight',
      preflightParams,
      'permission-probe',
    );
    assert.equal(reconciled.commandId, probe.commandId);
    assert.deepEqual(reconciled.result, probe.result);
    assert.ok(['accepted', 'applied'].includes(reconciled.status));
    p = await read();
    await request(
      directory,
      'setPermissionProfile',
      { sessionId, profileId: ':read-only', expectedKey: p.effective.key, confirmed: true },
      'permission-revoke',
    );
    await until(
      status,
      (s) =>
        s.sessions.find((r) => r.id === sessionId).state.permissionProbe?.currentBoundary === false,
    );
  },
);
