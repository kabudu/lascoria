import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { request } from '../src/client.js';
import { provider } from '../testing/provider.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(action, predicate, label) {
  let value;
  for (let i = 0; i < 250; i++) {
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
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await done;
}
test(
  'isolated coding lifecycle uses real Muse, direct tests, guarded commits, discard and durable archive',
  { timeout: 100000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'weftara-workspace-'));
    const source = join(root, 'source');
    const directory = join(root, 'state');
    await mkdir(source);
    const git = (...args) =>
      execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    await writeFile(join(source, 'README.md'), 'Original checkout\n');
    await writeFile(join(source, '.gitignore'), 'secret.txt\n');
    git('add', '.');
    git('commit', '-qm', 'Initial');
    const base = git('rev-parse', 'HEAD');
    await writeFile(join(source, 'README.md'), 'Keep these uncommitted changes\n');
    const model = await provider(root, { stageB: true });
    const env = {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'meta',
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
    t.after(async () => {
      await stop(daemon);
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const status = () => request(directory, 'status');
    await until(status, (s) => s.pid === daemon.pid, 'boot');
    const startParams = { workspace: source, isolated: true };
    const started = await request(directory, 'start', startParams, 'isolated-start');
    assert.equal(started.status, 'applied', JSON.stringify(started));
    const sessionId = started.sessionId;
    const row = () => status().then((s) => s.sessions.find((r) => r.id === sessionId));
    const workspace = (await row()).workspace;
    assert.notEqual(workspace, source);
    assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), 'Original checkout\n');
    assert.deepEqual(await request(directory, 'start', startParams, 'isolated-start'), started);
    const turn = await request(
      directory,
      'turn',
      { sessionId, text: 'STAGE_B_IMPLEMENT' },
      'implement',
    );
    assert.ok(['accepted', 'applied'].includes(turn.status));
    let settled = false;
    for (let i = 0; i < 250; i++) {
      const r = await row();
      for (const a of r.state.approvals ?? []) {
        const choice = a.requested.availableChoices.find((c) => c.decision === 'approved');
        await request(directory, 'decide', {
          sessionId,
          approvalId: a.approvalId,
          requirementId: a.requested.currentRequirementId,
          choiceId: choice.choiceId,
        });
      }
      if (r.state.turns?.some((t) => t.terminal === 'completed')) {
        settled = true;
        break;
      }
      await delay(100);
    }
    assert.ok(settled, 'real Muse implementation completes: ' + JSON.stringify(await row()));
    assert.match(await readFile(join(workspace, 'sum.mjs'), 'utf8'), /a \+ b/);
    await assert.rejects(access(join(source, 'sum.mjs')));
    const files = await request(directory, 'workspace/files', { sessionId, query: 'sum' });
    assert.deepEqual(files.paths, ['sum.mjs']);
    assert.match(
      (await request(directory, 'workspace/file', { sessionId, path: 'sum.mjs' })).text,
      /sum/,
    );
    await writeFile(join(workspace, 'secret.txt'), 'ignored local secret');
    await assert.rejects(
      request(directory, 'workspace/file', { sessionId, path: 'secret.txt' }),
      /not Git-visible/,
    );
    await assert.rejects(
      request(directory, 'workspace/file', { sessionId, path: '../source/README.md' }),
      /repository-relative/,
    );
    const command = `node --input-type=module -e "import {sum} from './sum.mjs';if(sum(2,3)!==5)process.exit(1);console.log('PASS direct test')"`;
    const runParams = { sessionId, command };
    assert.equal(
      (await request(directory, 'workspace/run', runParams, 'test-run')).status,
      'running',
    );
    const completed = await until(
      status,
      (s) => s.commands.find((c) => c.id === 'test-run')?.result?.outcome === 'passed',
      'direct test',
    );
    const result = completed.commands.find((c) => c.id === 'test-run');
    assert.equal(result.result.exitCode, 0);
    assert.equal(result.result.contentUnchanged, true);
    assert.match(result.result.stdout, /PASS direct test/);
    assert.deepEqual(await request(directory, 'workspace/run', runParams, 'test-run'), result);
    await request(
      directory,
      'workspace/run',
      { sessionId, command: 'sleep 5', timeoutSeconds: 1 },
      'slow-test',
    );
    await assert.rejects(
      request(directory, 'workspace/commit', {
        sessionId,
        message: 'too early',
        fingerprint: 'old',
      }),
      /test command/,
    );
    await until(
      status,
      (s) => s.commands.find((c) => c.id === 'slow-test')?.result?.outcome === 'timedOut',
      'deadline',
    );
    await request(
      directory,
      'workspace/run',
      { sessionId, command: 'node -e "process.stdout.write(\'x\'.repeat(70000))"' },
      'large-output',
    );
    await until(
      status,
      (s) => s.commands.find((c) => c.id === 'large-output')?.result?.outcome === 'failed',
      'output budget',
    );
    const preview = await request(directory, 'workspace/inspect', { sessionId });
    await writeFile(join(workspace, 'new.txt'), 'new edit\n');
    const stale = await request(
      directory,
      'workspace/commit',
      { sessionId, message: 'stale', fingerprint: preview.fingerprint },
      'stale-commit',
    );
    assert.equal(stale.status, 'outcomeUnknown');
    assert.match(stale.error.message, /Changes moved/);
    const fresh = await request(directory, 'workspace/inspect', { sessionId });
    const params = { sessionId, message: 'Implement sum', fingerprint: fresh.fingerprint };
    const committed = await request(directory, 'workspace/commit', params, 'commit');
    assert.equal(committed.status, 'applied', JSON.stringify(committed));
    assert.notEqual(committed.result.head, base);
    assert.deepEqual(await request(directory, 'workspace/commit', params, 'commit'), committed);
    assert.equal(git('rev-parse', 'HEAD'), base);
    assert.equal(
      await readFile(join(source, 'README.md'), 'utf8'),
      'Keep these uncommitted changes\n',
    );
    await rm(join(workspace, 'README.md'));
    const deletionPreview = await request(directory, 'workspace/inspect', { sessionId });
    const deletion = await request(
      directory,
      'workspace/commit',
      { sessionId, message: 'Remove task readme', fingerprint: deletionPreview.fingerprint },
      'commit-deletion',
    );
    assert.equal(deletion.status, 'applied', JSON.stringify(deletion));
    await writeFile(join(workspace, 'new.txt'), 'discard me\n');
    const discardPreview = await request(directory, 'workspace/inspect', { sessionId });
    const discarded = await request(
      directory,
      'workspace/discard',
      { sessionId, fingerprint: discardPreview.fingerprint, confirmation: sessionId },
      'discard',
    );
    assert.equal(discarded.status, 'applied', JSON.stringify(discarded));
    await assert.rejects(access(workspace));
    assert.equal(git('rev-parse', (await row()).managedWorkspace.branch), deletion.result.head);
    assert.equal((await row()).lifecycle, 'archived');
    await assert.rejects(request(directory, 'resume', { sessionId }), /Archived/);
    await stop(daemon);
    daemon = boot();
    await until(status, (s) => s.pid === daemon.pid, 'restart');
    await delay(1500);
    assert.equal((await row()).lifecycle, 'archived');
    assert.equal((await row()).state.current, false);
    const another = await request(
      directory,
      'start',
      { workspace: source, isolated: true },
      'another',
    );
    const retained = (await status()).sessions.find((s) => s.id === another.sessionId).workspace;
    await request(
      directory,
      'turn',
      { sessionId: another.sessionId, text: 'SECOND_ISOLATED_TASK' },
      'another-turn',
    );
    await until(
      status,
      (s) =>
        s.sessions
          .find((r) => r.id === another.sessionId)
          ?.state.turns?.some((t) => t.terminal === 'completed'),
      'second task settles',
    );
    await request(
      directory,
      'workspace/run',
      { sessionId: another.sessionId, command: 'sleep 2; printf orphan > late.txt' },
      'shutdown-test',
    );
    await assert.rejects(
      request(directory, 'session/archive', { sessionId: another.sessionId }),
      /test command/,
    );
    await stop(daemon);
    daemon = boot();
    await until(status, (s) => s.pid === daemon.pid, 'restart after running test');
    const interrupted = (await status()).commands.find((c) => c.id === 'shutdown-test');
    assert.equal(interrupted.status, 'outcomeUnknown');
    assert.equal(interrupted.result.outcome, 'interrupted');
    await delay(2200);
    await assert.rejects(access(join(retained, 'late.txt')));
    await until(
      status,
      (s) => s.sessions.find((r) => r.id === another.sessionId)?.state.current,
      'retained task recovery',
    );
    const archived = await request(
      directory,
      'session/archive',
      { sessionId: another.sessionId },
      'archive-retain',
    );
    assert.equal(archived.status, 'applied');
    await access(retained);
  },
);
