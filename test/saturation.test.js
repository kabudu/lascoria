import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import net from 'node:net';
import { provider } from '../testing/provider.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(directory, predicate, label) {
  let value;
  for (let attempt = 0; attempt < 900; attempt++) {
    try {
      value = await request(directory, 'status');
      if (predicate(value)) return value;
    } catch (error) {
      value = error.message;
    }
    await delay(100);
  }
  throw new Error(
    `${label}: ${JSON.stringify(typeof value === 'object' ? value.sessions.map((row) => ({ generation: row.generation, lifecycle: row.lifecycle, recoveryError: row.recoveryError, interruptions: row.interruptions, current: row.state.current, gaps: row.state.gaps, eventCount: row.state.eventCount })) : value)}`,
  );
}
test(
  'native Muse egress saturation: real gap, live splice recovery and exact final text',
  { timeout: 240000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-saturation-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const directory = join(root, 'state');
    const model = await provider(root, { saturation: true });
    const proxy = resolve('testing/native-egress-proxy.js');
    await chmod(proxy, 0o700);
    const controlPath = join(root, 'egress.sock');
    const control = (operation) =>
      bounded(
        new Promise((resolve, reject) => {
          const socket = net.createConnection(controlPath);
          let text = '';
          socket.on('error', reject);
          socket.on('connect', () => socket.write(JSON.stringify({ operation }) + '\n'));
          socket.on('data', (data) => (text += data));
          socket.on('end', () => resolve(JSON.parse(text)));
        }),
        5000,
      );
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
        SCH_STATE_DIR: directory,
        SCH_PROVIDER: 'meta',
        MUSE_BIN: proxy,
        SCH_NATIVE_MUSE: process.env.MUSE_BIN ?? 'muse',
        SCH_SATURATION_SOCKET: controlPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let paused = false;
    const stderr = [];
    daemon.stderr.on('data', (data) => stderr.push(data.toString()));
    t.after(async () => {
      if (paused) await control('release').catch(() => {});
      model.beginBurst();
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise((resolve) => daemon.once('exit', resolve));
        daemon.kill('SIGTERM');
        await bounded(exited, 10000);
      }
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    await eventually(directory, (state) => state.pid === daemon.pid, 'ready');
    let sessionId;
    let turn;
    let before;
    const started = await request(directory, 'start', { workspace }, 'saturation-session');
    assert.equal(started.status, 'applied');
    sessionId = started.sessionId;
    turn = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_A_SATURATION' },
      'saturation-turn',
    );
    assert.ok(['accepted', 'applied'].includes(turn.status));
    await eventually(
      directory,
      (state) =>
        state.sessions[0].state.activeTurnId === turn.result.turnId && model.requests.length > 0,
      'stream started',
    );
    model.beginBurst();
    await bounded(model.batchFinished, 180000);
    before = await eventually(
      directory,
      (state) => !state.sessions[0].state.activeTurnId,
      'initial workload complete',
    );
    const requestsBefore = model.requests.length;
    const healthyPage = await control('probe');
    assert.equal(healthyPage.error, undefined, JSON.stringify(healthyPage));
    assert.equal(healthyPage.events, 200);
    await control('hold');
    paused = true;
    await control('flood');
    await delay(2000);
    await control('release');
    paused = false;
    const transport = await control('status');
    console.log('NATIVE_TRANSPORT_STATUS', JSON.stringify(transport));
    await eventually(
      directory,
      (state) =>
        state.sessions[0].state.current &&
        !state.sessions[0].state.activeTurnId &&
        state.sessions[0].state.gaps?.some((gap) => gap.recovered),
      'reader ready for tail',
    );
    const tail = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_A_TAIL' },
      'saturation-tail',
    );
    const final = await eventually(
      directory,
      (state) =>
        state.sessions[0].state.gaps?.some((gap) => gap.recovered) &&
        !state.sessions[0].state.activeTurnId &&
        state.sessions[0].state.current &&
        state.sessions[0].state.turns.some(
          (turn) => turn.turnId === tail.result.turnId && turn.terminal === 'completed',
        ),
      'native gap repaired',
    );
    const row = final.sessions[0];
    assert.equal(row.generation, 1, 'host/worker are not replaced');
    assert.equal(row.interruptions.length, 0);
    assert.ok(
      row.state.gaps.every(
        (gap) =>
          gap.sessionId === sessionId &&
          typeof gap.after === 'string' &&
          typeof gap.next === 'string' &&
          gap.recovered &&
          gap.unavailableDuringFill,
      ),
    );
    assert.ok(
      row.state.items.some((item) => item.kind === 'agentMessage' && item.text === 'stage-a reply'),
    );
    assert.equal(
      row.state.totalItems,
      before.sessions[0].state.totalItems + 2,
      'all tools and both model messages folded',
    );
    assert.equal(
      row.state.turns.find((entry) => entry.turnId === turn.result.turnId).terminal,
      'completed',
    );
    const repeat = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_A_SATURATION' },
      'saturation-turn',
    );
    assert.equal(repeat.commandId, turn.commandId);
    const native = await control('status');
    assert.ok(native.gaps.length > 0, 'proxy observed native gap bytes directly');
    assert.equal(native.replies, 1);
    let overlap = 0;
    for (const item of before.sessions[0].state.items) {
      const recovered = row.state.items.find((recovered) => recovered.itemId === item.itemId);
      if (recovered) {
        overlap++;
        assert.deepEqual(recovered, item);
      }
    }
    assert.ok(overlap >= before.sessions[0].state.items.length - 2, 'unchanged history retained');
    assert.deepEqual(native.errors, [], 'native replay request admitted');
    assert.equal(
      model.requests.length,
      requestsBefore + 1,
      'exactly one additional model response, no workload replay',
    );
    console.log(
      'NATIVE_SATURATION_PROOF',
      JSON.stringify({
        binary: row.handshake.serverInfo.version,
        tools: 1536,
        gaps: row.state.gaps,
        generation: row.generation,
        terminal: 'completed',
        exactText: true,
        modelRequests: model.requests.length,
      }),
    );
    await request(directory, 'resume', { sessionId }, 'saturation-cold-resume');
    const cold = await eventually(
      directory,
      (state) => state.sessions[0].state.current && state.sessions[0].generation === 2,
      'cold saturation projection',
    );
    assert.deepEqual(
      cold.sessions[0].state.items,
      row.state.items,
      'cold history and repaired live items converge',
    );
    assert.equal(cold.sessions[0].state.totalItems, row.state.totalItems);
    for (const state of [row.state, cold.sessions[0].state]) {
      for (const item of state.items) {
        assert.equal(
          state.itemProvenance[item.itemId]?.revision,
          item.revision,
          `Displayed ${item.itemId} retains matching native provenance`,
        );
      }
    }
    assert.deepEqual(
      cold.sessions[0].state.sessionState,
      row.state.sessionState,
      'session state revisions converge',
    );
    assert.equal(
      model.requests.length,
      requestsBefore + 1,
      'cold resume does not rerun the workload',
    );
    assert.ok(!stderr.some((text) => text.includes('panicked')), stderr.join(''));
  },
);
