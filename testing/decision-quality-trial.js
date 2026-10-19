// R10 independent quality check, explicit paid acceptance, never part of local CI.
// The decision assistant reviews four synthetic code changes and predicts whether the
// repository's tests pass; each prediction is compared with an independent `node --test` run
// of the same change. Only the synthetic repository diff leaves this computer. Keys are read
// into memory from private files, saved through the supervisor API and forgotten in finally.
//
//   node testing/decision-quality-trial.js --paid <key-directory> jev,subq
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, realpath, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';

const [approval, keyDirectory, selected] = process.argv.slice(2);
assert.equal(approval, '--paid', 'Pass --paid deliberately; this sends paid API requests');
assert.ok(keyDirectory, 'Pass a directory containing the private provider key files');
const providers = { jev: '.typesafeai', subq: '.subq' };
const ids = (selected ?? '').split(',');
assert.ok(
  ids.length >= 1 && ids.every((id) => Object.hasOwn(providers, id)),
  'Choose jev, subq or jev,subq',
);
const exec = promisify(execFile);

// The repository before each change, and four changes adding a fixed-amount discount that is
// applied before tax. Two keep every test passing; two do not, one of them only because an
// existing call without a discount now returns NaN.
const BASE = {
  'price.mjs': `export function total(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return subtotal * (1 + taxRate);
}
`,
  'price.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { total } from './price.mjs';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, \`\${a} is not \${b}\`);
test('adds tax', () => near(total([{ price: 10, qty: 2 }], 0.1), 22));
`,
};
const discountTest = `test('discount comes off before tax', () =>
  near(total([{ price: 10, qty: 2 }], 0.1, 2), 19.8));
`;
const CANDIDATES = [
  {
    id: 'correct-with-default',
    files: {
      'price.mjs': `export function total(items, taxRate, discount = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return (subtotal - discount) * (1 + taxRate);
}
`,
    },
  },
  {
    id: 'discount-after-tax',
    files: {
      'price.mjs': `export function total(items, taxRate, discount = 0) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return subtotal * (1 + taxRate) - discount;
}
`,
    },
  },
  {
    id: 'missing-default',
    files: {
      'price.mjs': `export function total(items, taxRate, discount) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return (subtotal - discount) * (1 + taxRate);
}
`,
    },
  },
  {
    id: 'correct-refactor',
    files: {
      'price.mjs': `const lineTotal = (item) => item.price * item.qty;

export function total(items, taxRate, discount = 0) {
  const discounted = items.map(lineTotal).reduce((a, b) => a + b, 0) - discount;
  return discounted * (1 + taxRate);
}
`,
    },
  },
];
const QUESTION = {
  type: 'predicate',
  prompt:
    'Read the diff, including the existing test it shows. After this change, will every test in price.test.mjs pass when run with node --test? Answer yes only if all tests pass.',
};

const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-dq-')));
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
const report = {
  revision: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
  question: QUESTION.prompt,
  providers: {},
  cleanup: [],
};
const call = (op, params = {}, id = randomUUID()) => request(directory, op, params, id, 65000);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, check, label, ms = 35000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read().catch(() => undefined);
    if (value && check(value)) return value;
    await pause(150);
  }
  throw Error(`Timed out: ${label}; do not retry a paid request`);
}
const configure = async (op, params) =>
  call(op, { ...params, expectedRevision: (await call('decision/status')).revision });
const git = (cwd, ...args) =>
  exec('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], {
    cwd,
  });
async function testsPass(cwd) {
  try {
    await exec(process.execPath, ['--test', 'price.test.mjs'], { cwd, timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}

const configured = new Set();
try {
  await until(
    () => call('status'),
    (s) => s.pid === daemon.pid,
    'supervisor startup',
  );
  for (const provider of ids) {
    const rows = [];
    report.providers[provider] = { rows };
    const repo = join(root, provider);
    await mkdir(repo);
    await git(repo, 'init', '-q');
    for (const [name, text] of Object.entries(BASE)) await writeFile(join(repo, name), text);
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'Synthetic price fixture');
    assert.ok(await testsPass(repo), 'the base fixture passes its tests');
    const { sessionId } = await call('start', { workspace: repo, name: `Quality ${provider}` });
    const turn = await call('turn', {
      sessionId,
      text: 'Synthetic acceptance task: report that a change is ready for review. Do not change files or use tools.',
    });
    const taskId = turn.result.turnId;
    await until(
      () => call('status'),
      (s) =>
        s.sessions
          .find((r) => r.id === sessionId)
          ?.state.turns.some((t) => t.turnId === taskId && t.terminal === 'completed'),
      'echo task',
    );
    let key = (await readFile(join(resolve(keyDirectory), providers[provider]), 'utf8'))
      .trim()
      .replace(/^[A-Z_][A-Z_0-9]*\s*[:=]\s*/, '')
      .replace(/^Bearer\s+/i, '');
    assert.ok(/^[!-~]{8,4096}$/.test(key), 'Key file must contain one API key');
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
      for (const candidate of CANDIDATES) {
        for (const [name, text] of Object.entries(candidate.files))
          await writeFile(join(repo, name), text);
        await writeFile(join(repo, 'price.test.mjs'), BASE['price.test.mjs'] + discountTest);
        const actual = await testsPass(repo);
        const artifact = await call('artifact/capture', { sessionId, taskId });
        const params = { provider, sessionId, artifactId: artifact.id, question: QUESTION };
        const preview = await call('decision/preview', params);
        assert.ok(JSON.stringify(preview.payload).includes("test('adds tax'"));
        const row = await call(
          'decision/evaluate',
          { ...params, fingerprint: preview.fingerprint },
          randomUUID(),
        );
        assert.equal(row.status, 'completed', `${provider} did not complete; no retry is sent`);
        const answer = row.result.answer;
        const probability = answer.probability ?? answer.noul;
        rows.push({
          candidate: candidate.id,
          testsPass: actual,
          probabilityPass: probability,
          correct: probability > 0.5 === actual,
          model: row.result.model,
          latencyMs: row.latencyMs,
        });
        await git(repo, 'checkout', '-q', '--', '.');
      }
      const correct = rows.filter((r) => r.correct).length;
      report.providers[provider].accuracy = `${correct}/${rows.length}`;
      report.providers[provider].brier = Number(
        (
          rows.reduce((s, r) => s + (r.probabilityPass - (r.testsPass ? 1 : 0)) ** 2, 0) /
          rows.length
        ).toFixed(3),
      );
    } catch (error) {
      report.providers[provider].error = String(error.message).slice(0, 240);
    } finally {
      key = '';
      await configure('decision/forgetKey', { provider });
      configured.delete(provider);
    }
  }
  report.groundTruth = Object.values(report.providers)[0]?.rows?.map((r) => [
    r.candidate,
    r.testsPass,
  ]);
} finally {
  for (const provider of configured)
    await configure('decision/forgetKey', { provider }).catch(() =>
      report.cleanup.push(`Could not confirm forgetting ${provider}`),
    );
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const ended = once(daemon, 'exit');
    daemon.kill('SIGTERM');
    await bounded(ended, 10000).catch(() => daemon.kill('SIGKILL'));
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  console.log(JSON.stringify(report, null, 2));
}
