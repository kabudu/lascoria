import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { provider } from '../testing/provider.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(action, predicate, label) {
  let value;
  for (let i = 0; i < 150; i++) {
    try {
      value = await action();
      if (predicate(value)) return value;
    } catch (e) {
      value = e.message;
    }
    await delay(100);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
test(
  'local relay scopes peers, persists both directions and never replays Muse delivery',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-relay-'));
    const directory = join(root, 'state'),
      workspace = join(root, 'work');
    await mkdir(workspace);
    const model = await provider(root);
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'meta',
      ...model.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    const boot = () =>
      spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
        env,
        stdio: 'ignore',
      });
    let daemon = boot();
    async function stop() {
      if (daemon.exitCode !== null || daemon.signalCode !== null) return;
      const done = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await done;
    }
    t.after(async () => {
      await stop();
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const call = (op, p = {}, id) => request(directory, op, p, id);
    await until(
      () => call('status'),
      (s) => s.pid === daemon.pid,
      'boot',
    );
    const a = (await call('start', { workspace }, 'start-a')).sessionId;
    const b = (await call('start', { workspace }, 'start-b')).sessionId;
    const c = (await call('start', { workspace }, 'start-c')).sessionId;
    const get = (id) => call('relay/get', { sessionId: id });
    const share = { sessionId: a, peerId: b, body: 'A selected finding for session B' };
    await assert.rejects(call('relay/send', share, 'note-a'), /Connect/);
    await assert.rejects(
      call('relay/connect', { sessionId: a, peerId: a, expectedRevision: 0 }),
      /another session/,
    );
    await assert.rejects(
      call('relay/connect', { sessionId: a, peerId: 'unknown', expectedRevision: 0 }),
      /Unknown local/,
    );
    await call('relay/connect', { sessionId: a, peerId: b, expectedRevision: 0 });
    await assert.rejects(
      call('relay/disconnect', { sessionId: a, peerId: b, expectedRevision: 0 }),
      /changed/,
    );
    const note = await call('relay/send', share, 'note-a');
    assert.equal(note.origin, 'user');
    assert.equal(note.state, 'available');
    assert.deepEqual(await call('relay/send', share, 'note-a'), note);
    await assert.rejects(
      call('relay/send', { ...share, body: 'changed' }, 'note-a'),
      /retry changed/,
    );
    await assert.rejects(
      call('relay/send', { ...share, body: 'é'.repeat(4097) }, 'oversized'),
      /8192/,
    );
    assert.equal((await get(a)).messages.length, 1);
    assert.equal((await get(b)).messages[0].body, share.body);
    assert.equal((await get(c)).messages.length, 0);
    await assert.rejects(
      call('relay/deliver', { sessionId: c, messageId: note.id }),
      /another recipient/,
    );
    const before = await call('status');
    assert.equal(
      before.commands.filter((x) => x.operation === 'turn').length,
      0,
      'sharing never invokes a model',
    );
    await call('relay/send', { sessionId: b, peerId: a, body: 'B replies explicitly' }, 'note-b');
    const delivered = await call('relay/deliver', { sessionId: b, messageId: note.id });
    assert.ok(['accepted', 'applied'].includes(delivered.status), JSON.stringify(delivered));
    await until(
      () => call('status'),
      (s) => s.sessions.find((x) => x.id === b).state.turns.some((x) => x.terminal === 'completed'),
      'native Muse completes delivery',
    );
    await call('turn', { sessionId: a, text: 'STAGE_A_INPUT' }, 'waiting-input');
    const waiting = await until(
      () => call('status'),
      (s) => s.sessions.find((x) => x.id === a).state.userInputs.length > 0,
      'recipient question',
    );
    const aRow = waiting.sessions.find((x) => x.id === a);
    const question = aRow.state.userInputs[0];
    const countBefore = model.requests.length;
    await assert.rejects(
      call('relay/deliver', { sessionId: a, messageId: 'note-b' }),
      /finish|idle/,
    );
    const preserved = (await call('status')).sessions.find((x) => x.id === a);
    assert.equal(preserved.state.userInputs[0].userInputId, question.userInputId);
    assert.equal(model.requests.length, countBefore, 'busy delivery does not call a model');
    await call('cancel', { sessionId: a, turnId: aRow.state.activeTurnId }, 'cancel-question');
    await until(
      () => call('status'),
      (s) => !s.sessions.find((x) => x.id === a).state.activeTurnId,
      'question cancelled',
    );
    let inbox = await get(a);
    assert.equal(inbox.messages.find((m) => m.id === 'note-a').delivery.id, 'relay_note-a');
    await call('relay/disconnect', { sessionId: a, peerId: b, expectedRevision: inbox.revision });
    assert.equal(
      (await call('relay/deliver', { sessionId: b, messageId: note.id })).id,
      'relay_note-a',
      'reconcile after disconnect',
    );
    await assert.rejects(
      call('relay/deliver', { sessionId: a, messageId: 'note-b' }),
      /disconnected/,
    );
    assert.deepEqual(
      await call('relay/send', share, 'note-a'),
      note,
      'lost acknowledgement reconciles after disconnect',
    );
    await stop();
    daemon = boot();
    await until(
      () => call('status'),
      (s) => s.pid === daemon.pid,
      'reboot',
    );
    assert.equal((await get(a)).messages.length, 2);
    assert.equal(
      (await call('relay/deliver', { sessionId: b, messageId: note.id })).id,
      'relay_note-a',
    );
    assert.equal((await call('status')).commands.filter((x) => x.id === 'relay_note-a').length, 1);
    inbox = await get(a);
    await call('relay/connect', { sessionId: a, peerId: b, expectedRevision: inbox.revision });
    for (let i = 0; i < 19; i++)
      await call('relay/send', { ...share, body: `bounded ${i}` }, `rate-${i}`);
    await assert.rejects(call('relay/send', share, 'rate-limit'), /rate limit/);
  },
);
