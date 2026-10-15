import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { provider } from '../testing/provider.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, accept) {
  const end = Date.now() + 20000;
  let last;
  while (Date.now() < end) {
    try {
      last = await read();
      if (accept(last)) return last;
    } catch {}
    await delay(50);
  }
  throw Error(JSON.stringify(last));
}
test(
  'active account logout cancels and checkpoints real Muse; detached work continues and reconnects',
  { timeout: 60000, skip: process.platform !== 'darwin' },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-active-account-'));
    const directory = join(root, 'state');
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const model = await provider(root, { responseDelayMs: 8000 });
    const config = join(directory, 'account-config', 'muse');
    await mkdir(config, { recursive: true });
    await copyFile(join(root, 'config', 'muse', 'settings.json'), join(config, 'settings.json'));
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        SCH_STATE_DIR: directory,
        SCH_AUTH_MANAGED: '1',
        SCH_ACCOUNT_WORKER: resolve('testing/account-worker.js'),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    t.after(async () => {
      try {
        await request(directory, 'account/forgetKey');
      } catch {}
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exited = new Promise((r) => daemon.once('exit', r));
        daemon.kill('SIGTERM');
        await bounded(exited, 20000);
      }
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const status = () => request(directory, 'status');
    await until(status, (s) => s.pid === daemon.pid);
    await request(directory, 'account/setKey', { apiKey: model.env.META_API_KEY });
    const { sessionId } = await request(directory, 'start', { workspace });
    const draft = await request(
      directory,
      'drafts/save',
      { sessionId, text: 'Retain this task draft', expectedRevision: 0 },
      'draft-1',
    );
    assert.equal(draft.revision, 1);
    assert.equal(
      (await request(directory, 'drafts/get')).drafts[sessionId].text,
      'Retain this task draft',
    );
    await assert.rejects(
      request(directory, 'drafts/save', {
        sessionId,
        text: 'stale overwrite',
        expectedRevision: 0,
      }),
      /Draft changed/,
    );
    const turn = await request(directory, 'turn', {
      sessionId,
      text: 'Stop this active turn for app logout',
    });
    const turnId = turn.result.turnId;
    await until(
      status,
      (s) => s.sessions[0].state.activeTurnId === turnId && model.requests.length > 0,
    );
    const beforeUsage = (await status()).sessions[0];
    const modelCalls = model.requests.length;
    const usage = await request(directory, 'usage', { sessionId });
    assert.equal(typeof usage, 'object');
    const skills = await request(directory, 'skills', { sessionId });
    assert.ok(Array.isArray(skills.skills));
    for (const text of ['/usage', '/lascoria-missing-skill-qa']) {
      const refused = await request(directory, 'steer', { sessionId, turnId, text });
      assert.equal(
        refused.status,
        'rejected',
        'local or unknown shortcuts cannot become model prompts',
      );
    }
    const afterUsage = (await status()).sessions[0];
    assert.equal(afterUsage.state.activeTurnId, turnId);
    assert.equal(afterUsage.generation, beforeUsage.generation);
    assert.equal(model.requests.length, modelCalls, 'usage cannot invoke the model');
    await request(directory, 'account/logout');
    let state = (await status()).sessions[0];
    assert.equal(state.lifecycle, 'interrupted');
    assert.equal(state.state.shutdown.turnId, turnId);
    assert.equal(state.state.shutdown.cancellation, 'confirmed');
    assert.equal(state.state.turns.find((v) => v.turnId === turnId).terminal, 'cancelled');
    const generation = state.generation;
    await delay(1200);
    assert.equal(
      (await status()).sessions[0].generation,
      generation,
      'logged out work cannot recover',
    );
    await request(directory, 'account/useKey');
    state = (await until(status, (s) => s.sessions[0].lifecycle === 'connected')).sessions[0];
    assert.equal(state.id, sessionId);
    assert.equal(
      (await request(directory, 'drafts/get')).drafts[sessionId].text,
      'Retain this task draft',
      'draft survives account-mode change and recovery',
    );
    assert.ok(
      state.interruptions.some((entry) => entry.shutdown?.cancellation === 'confirmed'),
      'shutdown evidence survives cold replay',
    );
    assert.equal(
      state.state.turns.find((v) => v.turnId === turnId).terminal,
      'cancelled',
      'cold replay retains checkpoint',
    );
    const next = await request(directory, 'turn', {
      sessionId,
      text: 'Continue after the preserved cancellation',
    });
    // Every IPC client is disconnected here, as when the WebView exits for an update.
    await delay(9000);
    state = (
      await until(status, (s) =>
        s.sessions[0].state.turns.some(
          (v) => v.turnId === next.result.turnId && v.terminal === 'completed',
        ),
      )
    ).sessions[0];
    assert.equal(state.lifecycle, 'connected');
    assert.equal(state.state.activeTurnId, undefined);
    assert.equal(state.generation, generation + 1, 'UI absence does not restart the host');
  },
);
