// Explicit paid acceptance, never part of local CI. Only synthetic repository text leaves
// this computer. Keys are read into memory from private files, saved through the normal
// supervisor API and forgotten in finally. No raw HTTP requests bypass the Rust adapters.
// node testing/decision-trial.js --paid <key-directory> <providers, e.g. jev,subq>
// Add --hold to inspect the isolated state in the native app; Ctrl+C cleans up the service.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';

const [approval, keyDirectory, selected] = process.argv.slice(2);
assert.equal(approval, '--paid', 'Pass --paid deliberately; this sends paid API requests');
assert.ok(keyDirectory, 'Pass a directory containing the private provider key files');
const providers = { jev: '.typesafeai', subq: '.subq', openai: '.openai' };
const ids = selected === 'all' ? Object.keys(providers) : (selected ?? '').split(',');
assert.ok(
  ids.length <= 3 &&
    ids.every((id) => Object.hasOwn(providers, id)) &&
    new Set(ids).size === ids.length,
  'Choose explicit providers, for example jev,subq or all',
);
const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-da-')));
const directory = join(root, 'state');
const env = {
  ...process.env,
  SCH_STATE_DIR: directory,
  SCH_PROVIDER: 'echo',
  SCH_AUTH_MANAGED: '0',
  MUSE_NO_AUTO_UPDATE: '1',
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
};
delete env.META_API_KEY;
const binary = resolve('supervisor/target/debug/constellation-supervisor');
const log = await open(join(root, 'supervisor.log'), 'a');
const daemon = spawn(binary, [], { env, stdio: ['ignore', log.fd, log.fd] });
await log.close();
const report = { revision: '', directory, daemonPid: daemon.pid, providers: {}, cleanup: [] };
const exec = promisify(execFile);
report.revision = (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim();
report.dirty = (await exec('git', ['status', '--porcelain'])).stdout !== '';
const call = (op, params = {}, id = randomUUID()) => request(directory, op, params, id, 65000);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, test, label, ms = 35000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !stop) {
    const value = await read().catch(() => undefined);
    if (value && test(value)) return value;
    await pause(150);
  }
  throw Error(`Timed out: ${label}; do not retry a paid request`);
}
async function configure(op, params) {
  const status = await call('decision/status');
  return call(op, { ...params, expectedRevision: status.revision });
}
async function helper(sessionId, args) {
  const child = spawn(binary, ['--relay-mcp', sessionId], {
    env,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
  });
  let id = 0;
  const rpc = async (method, params) => {
    const next = ++id;
    const reply = new Promise((r) => pending.set(next, r));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    try {
      const value = await bounded(reply, 65000);
      assert.ok(!value.error, 'MCP protocol refused the request');
      return value.result;
    } finally {
      pending.delete(next);
    }
  };
  try {
    await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'decision-acceptance', version: '1' },
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const listed = await rpc('tools/list', {});
    assert.ok(listed.tools.some((t) => t.name === 'ask_decision_assistant'));
    const ask = { name: 'ask_decision_assistant', arguments: args };
    const result = await rpc('tools/call', ask);
    assert.equal(result.isError, undefined, 'Live tool request failed; see isolated history');
    const again = await rpc('tools/call', ask);
    assert.deepEqual(again, result, 'Same tool identity must return its recorded answer');
    return JSON.parse(result.content[0].text);
  } finally {
    lines.close();
    child.kill();
  }
}
const configured = new Set();
let stop = false;
process.on('SIGINT', () => {
  stop = true;
});
process.on('SIGTERM', () => {
  stop = true;
});
try {
  await until(
    () => call('status'),
    (s) => s.pid === daemon.pid,
    'supervisor startup',
  );
  for (const provider of ids) {
    if (stop) break;
    const results = [];
    report.providers[provider] = { results };
    // A fresh repository per provider keeps workspace consent from enabling other sessions.
    const repo = join(root, provider);
    await mkdir(repo);
    await exec('git', ['init', '-q', repo]);
    await writeFile(join(repo, 'fixture.txt'), 'The build status is FAILED.\n');
    await exec('git', ['add', '.'], { cwd: repo });
    await exec(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-qm',
        'Synthetic fixture',
      ],
      { cwd: repo },
    );
    const started = await call('start', { workspace: repo, name: `Decision ${provider} trial` });
    const sessionId = started.sessionId;
    assert.ok(sessionId);
    const turn = await call('turn', {
      sessionId,
      text: 'Synthetic acceptance task: report that a change is ready for the user to review. Do not change files or use tools.',
    });
    const turnId = turn.result.turnId;
    await until(
      () => call('status'),
      (s) =>
        s.sessions
          .find((s) => s.id === sessionId)
          ?.state.turns.some((t) => t.turnId === turnId && t.terminal === 'completed'),
      'echo task completion',
    );
    await writeFile(join(repo, 'fixture.txt'), 'The build status is PASSED.\n');
    const artifact = await call('artifact/capture', { sessionId, taskId: turnId });
    let key = (await readFile(join(resolve(keyDirectory), providers[provider]), 'utf8'))
      .trim()
      .replace(/^[A-Z_][A-Z_0-9]*\s*[:=]\s*/, '')
      .replace(/^Bearer\s+/i, '');
    if (!/^[!-~]{8,4096}$/.test(key))
      throw Error('Key file must contain one API key (plain, Bearer or uppercase name: value)');
    // Register cleanup before saving: a vault write may succeed after an uncertain reply.
    configured.add(provider);
    try {
      await configure('decision/setKey', { provider, apiKey: key });
      key = '';
      const settings = await call('decision/status');
      await configure('decision/configure', {
        provider,
        model: settings.providers.find((p) => p.id === provider).defaultModel,
        enabled: true,
        sessionId,
        workspaceEnabled: true,
      });
      const questions = [
        {
          type: 'predicate',
          prompt: 'Does the added line explicitly say the build status is PASSED?',
        },
        {
          type: 'choice',
          prompt: 'What status does the added line report?',
          options: ['PASSED', 'FAILED'],
        },
        {
          type: 'score',
          prompt: 'Score the added line using the exact build status it reports.',
          options: ['The added line reports FAILED', 'The added line reports PASSED'],
        },
      ];
      for (const question of questions) {
        if (stop) break;
        const params = { provider, sessionId, artifactId: artifact.id, question };
        const preview = await call('decision/preview', params);
        assert.ok(JSON.stringify(preview.payload).includes('+The build status is PASSED.'));
        const requestId = randomUUID();
        const row = await call(
          'decision/evaluate',
          { ...params, fingerprint: preview.fingerprint },
          requestId,
        );
        results.push({
          type: question.type,
          status: row.status,
          message: row.message,
          model: row.result?.model,
          answer: row.result?.answer,
          latencyMs: row.latencyMs,
        });
        assert.equal(
          row.status,
          'completed',
          `Provider ${provider} did not complete; no retry will be sent`,
        );
        const stored = await call('decision/result', { requestId });
        assert.deepEqual(stored.result, row.result);
        const answer = row.result.answer;
        const correct =
          question.type === 'predicate'
            ? (answer.probability ?? answer.noul) > 0.5
            : question.type === 'choice'
              ? answer.choice === 'option_0'
              : answer.score > 0.5;
        assert.ok(correct, `Synthetic ${question.type} quality check failed`);
      }
      if (stop) break;
      await configure('decision/configureMode', {
        mode: 'tool',
        provider,
        sessionId,
        workspaceEnabled: true,
        dailyLimit: 3,
      });
      const answer = await helper(sessionId, {
        question: 'Is two plus two four?',
        kind: 'yes_no',
        context: 'Two plus two is four.',
        requestId: 'synthetic-tool-one',
      });
      results.push({ type: 'mcpTool', model: answer.model, answer: answer.answer });
      assert.ok((answer.answer.probability ?? answer.answer.noul) > 0.5);
      if (stop) break;
      await configure('decision/configureMode', { mode: 'tool', provider: null });
      await configure('decision/configureMode', {
        mode: 'triage',
        provider,
        sessionId,
        workspaceEnabled: true,
        share: ['request', 'reply'],
        dailyLimit: 3,
      });
      const triaged = await until(
        () => call('decision/status'),
        (s) =>
          s.recent.some(
            (r) =>
              r.purpose === 'triage' && r.source?.sessionId === sessionId && r.status !== 'sending',
          ),
        'background triage',
        45000,
      );
      const row = triaged.recent.find(
        (r) => r.purpose === 'triage' && r.source?.sessionId === sessionId,
      );
      results.push({
        type: 'triage',
        status: row.status,
        message: row.message,
        answer: row.result?.answer,
      });
      assert.equal(row.status, 'completed');
      await configure('decision/configureMode', { mode: 'triage', provider: null });
      report.providers[provider].passed = true;
    } catch (error) {
      // Only service-generated messages are recorded; never serialize arguments or keys.
      report.providers[provider].error = String(error.message).slice(0, 240);
    } finally {
      key = '';
      await configure('decision/forgetKey', { provider });
      configured.delete(provider);
    }
    const prefs = await call('presentation/get');
    await call('presentation/save', {
      expectedRevision: prefs.revision,
      value: {
        ...prefs.value,
        sessionId,
        selection: turnId,
        panels: { sessions: { collapsed: true }, attention: { collapsed: true } },
      },
    });
    console.log(
      JSON.stringify({
        provider,
        passed: !!report.providers[provider].passed,
        results: results.map((r) => ({ type: r.type, status: r.status })),
        error: report.providers[provider].error,
      }),
    );
  }
  report.metrics = await call('decision/metrics');
  if (process.argv.includes('--hold')) {
    console.log(
      JSON.stringify({ readyForNativeInspection: true, directory, daemonPid: daemon.pid }),
    );
    while (!stop) await pause(250);
  }
} finally {
  for (const provider of configured) {
    try {
      await configure('decision/forgetKey', { provider });
    } catch {
      report.cleanup.push(
        `Could not confirm forgetting ${provider}; inspect the isolated QA vault entry`,
      );
    }
  }
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const ended = once(daemon, 'exit');
    daemon.kill('SIGTERM');
    await bounded(ended, 10000).catch(() => daemon.kill('SIGKILL'));
  }
  await mkdir('.dev', { recursive: true });
  await writeFile(
    resolve('.dev/decision-trial-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    { mode: 0o600 },
  );
}
if (report.cleanup.length || ids.some((p) => !report.providers[p]?.passed)) process.exitCode = 1;
