import test from 'node:test';
import assert from 'node:assert/strict';
import {
  permissionTracker,
  checkPermissionChange,
  initialProfile,
  profileChoices,
} from '../src/permissions.js';
import { permissionProbe, observedProbe } from '../src/permission-probe.js';
const session = () => ({
  workspaceRoot: '/fixture',
  approvalMode: { mode: 'onRequest' },
  permissionState: {
    profileId: ':ask-me',
    reviewerAuthority: 'human',
    reviewerAttached: true,
    axes: { filesystem: 'sandboxed' },
  },
});
test('permission reads fail closed, invalidate stale/ABA confirmations and coalesce raced reads', async () => {
  let reads = 0,
    release;
  let fail = false;
  const tracker = permissionTracker(
    async () => {
      reads++;
      if (reads === 1)
        await new Promise((r) => {
          release = r;
        });
      if (fail) throw Error('fixture transport lost');
      return { session: session() };
    },
    { sandboxAvailability: 'available' },
  );
  const first = tracker.refresh('fixture');
  const second = tracker.refresh('fixture');
  assert.equal(reads, 1);
  tracker.invalidate();
  release();
  const [a, coalesced] = await Promise.all([first, second]);
  assert.deepEqual(coalesced, a);
  assert.equal(reads, 2);
  assert.equal(a.current, true);
  checkPermissionChange({ confirmed: true, expectedKey: a.key }, a);
  assert.throws(() => checkPermissionChange({ expectedKey: a.key }, a), /Confirm/);
  tracker.invalidate();
  tracker.invalidate();
  assert.equal(tracker.state.current, false);
  const b = await tracker.refresh('fixture');
  assert.notEqual(a.key, b.key);
  assert.throws(() => checkPermissionChange({ confirmed: true, expectedKey: a.key }, b), /changed/);
  fail = true;
  assert.equal((await tracker.refresh('fixture')).current, false);
  const missing = permissionTracker(
    async () => ({ session: { permissionState: {}, approvalMode: {} } }),
    {},
  );
  assert.equal((await missing.refresh('fixture')).current, false);
});
test('permission catalogue admission cannot expose unrestricted or custom grants or override native exclusion', () => {
  assert.equal(initialProfile(), ':ask-me');
  for (const id of [':unrestricted', 'custom', null, {}, ''])
    assert.throws(() => initialProfile(id));
  const rows = profileChoices({
    profiles: [
      { profileId: ':read-only', available: true },
      { profileId: ':ask-me', available: false },
      { profileId: ':unrestricted', available: true },
      { profileId: 'custom', available: true },
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.selectable),
    [true, false, false, false],
  );
  assert.throws(() => profileChoices({ profiles: Array(101).fill({}) }), /bounds/);
});
test('capability observations require the exact native shell command, default boundary, turn and completed output', () => {
  const probe = { ...permissionProbe('unix', 'fixture-1'), turnId: 'turn' };
  const result = {
    processInspection: { status: 'allowed' },
    loopbackBind: { status: 'denied' },
    loopbackConnection: { status: 'notChecked' },
  };
  const item = {
    kind: 'toolCall',
    tool: 'bash',
    turnId: 'turn',
    status: 'completed',
    args: JSON.stringify({ command: probe.command, sandbox_permissions: 'use_default' }),
    visibleOutput: JSON.stringify({
      command: probe.command,
      exit_code: 0,
      terminal_status: 'completed',
      truncated: false,
      output: probe.marker + JSON.stringify(result),
    }),
    itemId: 'probe',
    revision: 2,
  };
  assert.deepEqual(observedProbe([item], probe).results.loopbackBind.status, 'denied');
  const yielded = {
    ...item,
    args: JSON.stringify({
      command: probe.command,
      sandbox_permissions: 'use_default',
      timeout_ms: 10000,
      yield_time_ms: 10000,
    }),
  };
  assert.equal(observedProbe([yielded], probe)?.results.loopbackBind.status, 'denied');
  for (const value of [-1, 10001, '10000', null])
    assert.equal(
      observedProbe(
        [
          {
            ...yielded,
            args: JSON.stringify({ ...JSON.parse(yielded.args), yield_time_ms: value }),
          },
        ],
        probe,
      ),
      null,
    );

  for (const patch of [
    { kind: 'agentMessage' },
    { turnId: 'other' },
    { background: true },
    { status: 'inProgress' },
    { tool: 'userShell' },
    {
      args: JSON.stringify({
        command: probe.command,
        sandbox_permissions: 'use_default',
        disable_sandbox: true,
      }),
    },
    ...[
      { truncated: true },
      { exit_code: 1 },
      { terminal_status: 'running' },
      { command: 'other' },
    ].map((patch) => ({
      visibleOutput: JSON.stringify({
        command: probe.command,
        exit_code: 0,
        terminal_status: 'completed',
        truncated: false,
        output: probe.marker + JSON.stringify(result),
        ...patch,
      }),
    })),
    { args: JSON.stringify({ command: probe.command, sandbox_permissions: 'require_escalated' }) },
    { args: JSON.stringify({ command: 'echo spoof', sandbox_permissions: 'use_default' }) },
    { visibleOutput: probe.marker + '{}' },
    {
      visibleOutput:
        probe.marker + JSON.stringify(result) + '\n' + probe.marker + JSON.stringify(result),
    },
  ])
    assert.equal(observedProbe([{ ...item, ...patch }], probe), null);
});
