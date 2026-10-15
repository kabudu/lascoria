import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { request } from '../src/client.js';
import { provider } from '../testing/provider.js';
import { bounded } from '../src/runtime.js';
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
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await done;
}
async function helper(session, env) {
  const child = spawn(
    resolve('supervisor/target/debug/constellation-supervisor'),
    ['--relay-mcp', session],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const pending = new Map();
  let seq = 0;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const r = JSON.parse(line);
    pending.get(r.id)?.(r);
    pending.delete(r.id);
  });
  const call = async (method, params = {}) => {
    const id = ++seq;
    const result = new Promise((r) => pending.set(id, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return await bounded(result, 15000);
  };
  const initialized = await call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    child,
    call,
    tool: async (name, args = {}) => {
      const r = await call('tools/call', { name, arguments: args });
      assert.ok(r.result, JSON.stringify(r));
      return r.result;
    },
  };
}
test(
  'real Muse calls session-scoped MCP relay tools with explicit peer permission and bounded exchanges',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-agent-relay-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'work');
    await mkdir(workspace);
    const model = await provider(root, { relay: true });
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'meta',
      ...model.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env,
      stdio: 'ignore',
    });
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
    const a = (await api('start', { workspace }, 'start-a')).sessionId,
      b = (await api('start', { workspace }, 'start-b')).sessionId,
      c = (await api('start', { workspace }, 'start-c')).sessionId;
    const status = await api('status');
    assert.ok(
      status.sessions.every((s) => s.state.relayToolsAvailable),
      'native capability/config advertised',
    );
    const ha = await helper(a, env);
    helpers.push(ha);
    const hc = await helper(c, env);
    helpers.push(hc);
    assert.deepEqual(
      (await ha.call('tools/list')).result.tools.map((t) => t.name),
      ['local_peers', 'read_messages', 'send_message'],
    );
    assert.equal(JSON.parse((await ha.tool('local_peers')).content[0].text).peers.length, 0);
    await api('relay/connect', { sessionId: a, peerId: b, expectedRevision: 0 });
    assert.equal(
      (
        await ha.tool('send_message', {
          peerId: b,
          messageId: 'before-permission',
          body: 'not authorised',
        })
      ).isError,
      true,
    );
    let inbox = await api('relay/get', { sessionId: a });
    await api('relay/connect', {
      sessionId: a,
      peerId: b,
      expectedRevision: inbox.revision,
      allowAgentMessages: true,
    });
    assert.equal(JSON.parse((await ha.tool('local_peers')).content[0].text).peers[0].sessionId, b);
    async function turn(id, text, command) {
      const admitted = await api('turn', { sessionId: id, text }, command);
      const end = await until(
        async () => {
          const s = await api('status');
          const row = s.sessions.find((s) => s.id === id);
          for (const p of row.state.approvals) {
            const choice = p.requested.availableChoices.find((x) => x.decision === 'approved');
            assert.ok(choice, 'scoped test MCP permission must offer approval');
            const decided = await api(
              'decide',
              {
                sessionId: id,
                approvalId: p.approvalId,
                requirementId: p.requested.currentRequirementId,
                choiceId: choice.choiceId,
              },
              'approve-' + p.approvalId,
            );
            assert.ok(['accepted', 'applied'].includes(decided.status), JSON.stringify(decided));
          }
          return row;
        },
        (r) =>
          !r.state.activeTurnId &&
          r.state.turns.some((t) => t.commandId === admitted.commandId && t.state === 'settled'),
        command,
      );
      assert.equal(end.state.turns.at(-1).terminal, 'completed', JSON.stringify(end.state.turns));
    }
    await turn(a, `STAGE_RELAY_SEND_TO:${b}:agent-note-a`, 'send-a');
    inbox = await api('relay/get', { sessionId: b });
    if (!inbox.messages.length)
      await writeFile(
        '.dev/relay-agent-failure.json',
        JSON.stringify(
          {
            sessions: (await api('status')).sessions,
            modelInputs: model.requests.map((body) => JSON.parse(body).input),
          },
          null,
          2,
        ),
      );
    assert.equal(inbox.messages[0]?.body, 'Selected evidence from agent-note-a');
    assert.equal(inbox.messages[0].from, a);
    assert.equal(inbox.messages[0].origin, 'agent');
    await turn(b, `STAGE_RELAY_READ_FROM:${a}:read-one`, 'read-b');
    assert.ok(
      model.requests.some((body) =>
        JSON.parse(body).input?.some(
          (i) =>
            i.type === 'function_call_output' &&
            JSON.stringify(i.output).includes('Selected evidence from agent-note-a'),
        ),
      ),
      'real Muse passed peer text through the MCP result to the model',
    );
    await turn(b, `STAGE_RELAY_SEND_TO:${a}:agent-note-b`, 'send-b');
    await turn(a, `STAGE_RELAY_READ_FROM:${b}:read-two`, 'read-a');
    assert.equal((await api('relay/get', { sessionId: a })).messages.length, 2);
    assert.equal(
      (await hc.tool('read_messages', { peerId: a })).isError,
      true,
      'unconnected session cannot read another exchange',
    );
    assert.equal(
      (
        await hc.call('tools/call', {
          name: 'send_message',
          arguments: { sessionId: a, peerId: b, messageId: 'spoof', body: 'spoofed' },
        })
      ).error.code,
      -32602,
      'model arguments cannot replace owning session',
    );
    assert.deepEqual(JSON.parse((await hc.tool('local_peers')).content[0].text).peers, []);
    for (let i = 0; i < 6; i++) {
      const r = await ha.tool('send_message', {
        peerId: b,
        messageId: `bounded-${i}`,
        body: 'bounded evidence',
      });
      assert.ok(!r.isError, JSON.stringify(r));
    }
    assert.equal(
      (await ha.tool('send_message', { peerId: b, messageId: 'too-many', body: 'overflow' }))
        .isError,
      true,
    );
    assert.ok(
      !(
        await ha.tool('send_message', {
          peerId: b,
          messageId: 'agent-note-a',
          body: 'Selected evidence from agent-note-a',
        })
      ).isError,
      'identical retry remains possible after quota',
    );
    inbox = await api('relay/get', { sessionId: a });
    assert.equal(inbox.messages.length, 8);
    await api('relay/disconnect', { sessionId: a, peerId: b, expectedRevision: inbox.revision });
    assert.equal((await ha.tool('read_messages', { peerId: b })).isError, true);
    assert.ok(
      !(
        await ha.tool('send_message', {
          peerId: b,
          messageId: 'agent-note-a',
          body: 'Selected evidence from agent-note-a',
        })
      ).isError,
      'lost reply reconciles after revocation without another message',
    );
  },
);
