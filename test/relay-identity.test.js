import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import readline from 'node:readline';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { provider } from '../testing/provider.js';
const exec = promisify(execFile);
const supervisor = resolve('supervisor/target/debug/constellation-supervisor');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(action, predicate, label) {
  let last;
  for (let i = 0; i < 300; i++) {
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
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await bounded(done, 8000).catch(() => child.kill('SIGKILL'));
}
/** A relay helper started by this test, not by a Muse host. */
async function helper(session, env) {
  const child = spawn(supervisor, ['--relay-mcp', session], { env, stdio: 'pipe' });
  const pending = new Map();
  let seq = 0;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const r = JSON.parse(line);
    pending.get(r.id)?.(r);
  });
  const call = (method, params = {}) => {
    const id = ++seq;
    const result = new Promise((r) => pending.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return bounded(result, 15000);
  };
  await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'impersonator', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    child,
    tool: async (name, args = {}) => (await call('tools/call', { name, arguments: args })).result,
    list: async () => (await call('tools/list')).result.tools.map((t) => t.name),
  };
}
/** The capability Muse gave the session's real helper, read as a same-user process could. */
async function stolenCapability(session) {
  const { stdout } = await exec('ps', ['-eo', 'pid=,args=']);
  const line = stdout.split('\n').find((l) => l.includes(`--relay-mcp ${session}`));
  assert.ok(line, 'Muse started the session helper');
  const pid = line.trim().split(/\s+/)[0];
  // Linux exposes a same-user process's environment in /proc; macOS through `ps eww`.
  const environ =
    process.platform === 'linux'
      ? (await readFile(`/proc/${pid}/environ`, 'utf8')).replaceAll('\0', ' ')
      : (await exec('ps', ['eww', '-o', 'command=', '-p', pid])).stdout;
  const found = environ.match(/(?:^|\s)SCH_RELAY_CAPABILITY=([0-9a-f]{64})(?:\s|$)/);
  assert.ok(found, 'the helper received a capability');
  return found[1];
}
async function filesContaining(root, needle) {
  const hits = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const bytes = await readFile(path).catch(() => Buffer.alloc(0));
    if (bytes.includes(needle)) hits.push(path);
  }
  return hits;
}

// F1, relay helper argv: with peer binding on, only the helper a Muse host started for a
// session can act as that session. A same-user script that runs the supervisor binary as
// `--relay-mcp <session>` is refused, even with the session's capability copied from the
// real helper's environment.
test(
  'only the Muse-started helper can use a session’s relay tools when peer binding is on',
  { timeout: 150000, skip: process.platform === 'win32' && 'Windows is checked natively' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-relay-identity-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'work');
    await mkdir(workspace);
    const model = await provider(root, { relay: true });
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'meta',
      // This test's Node is the "desktop", so it keeps full control while helpers are bound.
      SCH_DESKTOP_EXE: process.execPath,
      ...model.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    let daemon = spawn(supervisor, [], { env, stdio: 'ignore' });
    const helpers = [];
    t.after(async () => {
      for (const h of helpers) await stop(h.child);
      await stop(daemon);
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const api = (op, params = {}, id) => request(directory, op, params, id);
    await until(
      () => api('status'),
      (s) => s.pid === daemon.pid,
      'boot',
    );
    const a = (await api('start', { workspace }, 'start-a')).sessionId;
    const b = (await api('start', { workspace }, 'start-b')).sessionId;
    await until(
      () => api('status'),
      (s) => s.sessions.every((r) => r.state.current && r.state.relayToolsAvailable),
      'sessions ready',
    );
    const relay = await api('relay/get', { sessionId: a });
    await api('relay/connect', {
      sessionId: a,
      peerId: b,
      expectedRevision: relay.revision,
      allowAgentMessages: true,
    });
    async function turn(id, text, command) {
      const admitted = await api('turn', { sessionId: id, text }, command);
      const end = await until(
        async () => {
          const row = (await api('status')).sessions.find((s) => s.id === id);
          for (const p of row.state.approvals) {
            const choice = p.requested.availableChoices.find((x) => x.decision === 'approved');
            await api(
              'decide',
              {
                sessionId: id,
                approvalId: p.approvalId,
                requirementId: p.requested.currentRequirementId,
                choiceId: choice.choiceId,
              },
              'approve-' + p.approvalId,
            );
          }
          return row;
        },
        (r) =>
          !r.state.activeTurnId &&
          r.state.turns.some((x) => x.commandId === admitted.commandId && x.state === 'settled'),
        command,
      );
      assert.equal(end.state.turns.at(-1).terminal, 'completed', JSON.stringify(end.state.turns));
    }

    // The real path: Muse runs its helper, which proves itself and sends the message.
    await turn(a, `STAGE_RELAY_SEND_TO:${b}:from-muse`, 'send-a');
    const inbox = await api('relay/get', { sessionId: b });
    assert.equal(inbox.messages.at(-1)?.body, 'Selected evidence from from-muse');

    // A script running the same binary for session A: no capability, a guessed one, or the
    // real one copied from the helper's environment. Its parent is not A's Muse host.
    const refusedBecause = /not started by Lascoria for that session/;
    const stolen = await stolenCapability(a);
    for (const capability of [undefined, 'f'.repeat(64), stolen]) {
      const impersonator = await helper(a, {
        ...env,
        ...(capability ? { SCH_RELAY_CAPABILITY: capability } : {}),
      });
      helpers.push(impersonator);
      for (const [name, args] of [
        ['local_peers', {}],
        ['read_messages', { peerId: b }],
        ['send_message', { peerId: b, messageId: `spoof-${helpers.length}`, body: 'spoofed' }],
      ]) {
        const result = await impersonator.tool(name, args);
        assert.equal(result.isError, true, `${name}: ${JSON.stringify(result)}`);
        assert.match(result.content[0].text, refusedBecause);
      }
      // The decision tool is never offered to it either.
      assert.ok(!(await impersonator.list()).includes('ask_decision_assistant'));
    }
    assert.equal((await api('relay/get', { sessionId: b })).messages.length, 1, 'nothing spoofed');

    // The capability is never stored, journalled or reported.
    assert.ok(!JSON.stringify(await api('status')).includes(stolen), 'not in status');
    assert.deepEqual(await filesContaining(directory, stolen), [], 'not in Lascoria state');
    assert.deepEqual(await filesContaining(join(root, 'data'), stolen), [], 'not in Muse data');

    // Linux: the desktop program itself, started with an injected library, is refused.
    if (process.platform === 'linux') {
      const script = `import { request } from ${JSON.stringify(resolve('src/client.js'))};
        await request(${JSON.stringify(directory)}, 'status').then(
          () => console.log('accepted'),
          (e) => console.log(e.message),
        );`;
      const run = (extra) =>
        exec(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, ...extra },
        }).then((r) => r.stdout.trim());
      assert.equal(await run({}), 'accepted');
      assert.match(
        await run({ LD_PRELOAD: '/nonexistent/lascoria-test.so' }),
        /refused because it was started with injected libraries/,
      );
    }

    // After a supervisor restart the resumed host gets a new capability; the old one is dead.
    await Promise.all(helpers.map((h) => stop(h.child)));
    await stop(daemon);
    daemon = spawn(supervisor, [], { env, stdio: 'ignore' });
    await until(
      () => api('status'),
      (s) => s.pid === daemon.pid,
      'restart',
    );
    await api('resume', { sessionId: a }, 'resume-a');
    await until(
      () => api('status'),
      (s) => s.sessions.find((r) => r.id === a)?.state.current,
      'resumed',
    );
    await turn(a, `STAGE_RELAY_SEND_TO:${b}:after-restart`, 'send-a-2');
    assert.equal(
      (await api('relay/get', { sessionId: b })).messages.at(-1)?.body,
      'Selected evidence from after-restart',
    );
    assert.notEqual(await stolenCapability(a), stolen, 'a new host generation, a new capability');
  },
);
