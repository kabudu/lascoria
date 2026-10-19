import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { provider } from '../testing/provider.js';
// LASCORIA_RELAY_APP runs this against an installed QA package.
const app = process.env.LASCORIA_RELAY_APP;
const workers = app ? join(app, 'runtime', 'workers') : resolve('src');
const { request } = await import(pathToFileURL(join(workers, 'client.js')).href);
const { bounded } = await import(pathToFileURL(join(workers, 'runtime.js')).href);
const supervisor = app
  ? join(app, 'runtime', `constellation-supervisor${process.platform === 'win32' ? '.exe' : ''}`)
  : resolve('supervisor/target/debug/constellation-supervisor');
const exec = promisify(execFile);
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

// R9: a typed skill invocation is requested by the user; Muse reports loading it only as a
// `skillRead` item, which it sends to hosts that opted into its experimental API. Session hosts
// opt in for that item alone and decline the experimental notifications.
test(
  'real Muse reports which skill it loaded for a requested skill',
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'lascoria-skill-read-'));
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    const skill = join(root, 'skill-source', 'release-notes');
    await mkdir(skill, { recursive: true });
    await writeFile(
      join(skill, 'SKILL.md'),
      '---\nname: release-notes\ndescription: Write release notes in the house style.\n---\nStart with a one-line summary.\n',
    );
    const workspace = join(root, 'work');
    await mkdir(workspace);
    const model = await provider(root, {});
    const directory = join(root, 'state');
    const daemon = spawn(supervisor, [], {
      env: {
        ...env,
        ...model.env,
        ...(app ? { SCH_RESOURCES: join(app, 'runtime'), SCH_NODE: process.execPath } : {}),
        SCH_STATE_DIR: directory,
        SCH_PROVIDER: 'meta',
      },
      stdio: 'ignore',
    });
    t.after(async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exit = new Promise((r) => daemon.once('exit', r));
        daemon.kill('SIGTERM');
        await bounded(exit, 10000).catch(() => daemon.kill('SIGKILL'));
      }
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const api = (op, params = {}, id) => request(directory, op, params, id);
    await until(
      () => api('status'),
      (s) => s.pid === daemon.pid,
      'boot',
    );
    const started = async (id) => {
      const { sessionId } = await api('start', { workspace }, id);
      const ready = await until(
        () => api('status'),
        (s) => s.sessions.find((r) => r.id === sessionId)?.state.current,
        'ready',
      );
      return [sessionId, ready.sessions.find((r) => r.id === sessionId)];
    };
    // Install the skill only into this test's own Muse home: never into the user's.
    const [, probe] = await started('probe');
    const home = probe.handshake.museHome;
    if (!resolve(home).startsWith(resolve(root))) {
      t.skip(`Muse home ${home} is not isolated by XDG variables on this platform`);
      return;
    }
    await exec(process.env.MUSE_BIN ?? 'muse', ['skills', 'install', skill, '--scope', 'user'], {
      env,
    });
    const [sessionId, ready] = await started('start');
    assert.equal(ready.handshake.experimentalApi, true, 'session host opted in');
    const catalog = await api('skills', { sessionId });
    assert.ok(catalog.skills.some((s) => s.selector === 'release-notes' && s.source === 'user'));

    await api('turn', { sessionId, text: '/release-notes for 1.0' }, 'skill-turn');
    const done = await until(
      () => api('status'),
      (s) => s.sessions.find((r) => r.id === sessionId).state.turns?.at(-1)?.terminal,
      'skill turn',
    );
    const row = done.sessions.find((r) => r.id === sessionId);
    assert.equal(row.state.turns.at(-1).terminal, 'completed');
    const turnId = row.state.turns.at(-1).turnId;
    const ask = row.state.items.find((i) => i.kind === 'userMessage' && i.turnId === turnId);
    assert.equal(ask.text, '/release-notes for 1.0', 'what the user requested');
    const read = row.state.items.find((i) => i.kind === 'skillRead' && i.turnId === turnId);
    assert.ok(read, 'Muse reported the load');
    assert.equal(read.selector, 'release-notes');
    assert.equal(read.source, 'user');
    assert.equal(read.status, 'completed');
    assert.ok(row.state.itemProvenance[read.itemId], 'the report keeps its native provenance');
    assert.ok(
      model.requests.some((body) => body.includes('Start with a one-line summary.')),
      'and the skill really reached the model',
    );
    // A plain task reports no skill.
    await api('turn', { sessionId, text: 'Say hello' }, 'plain-turn');
    const mine = (s) => s.sessions.find((r) => r.id === sessionId);
    const plain = mine(
      await until(
        () => api('status'),
        (s) => mine(s).state.turns?.length === 2 && mine(s).state.turns.at(-1).terminal,
        'plain turn',
      ),
    );
    const plainTurn = plain.state.turns.at(-1).turnId;
    assert.ok(!plain.state.items.some((i) => i.kind === 'skillRead' && i.turnId === plainTurn));
  },
);
