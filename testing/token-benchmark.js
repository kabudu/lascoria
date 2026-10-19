// T5: token-efficiency benchmark. Runs the same tasks repeatedly in fresh sessions under a
// baseline and an efficient configuration and compares tokens, correctness, model calls and
// completion time from what Muse reports. A saving counts only when every efficient run is as
// correct as the baseline.
//
//   node testing/token-benchmark.js                 controlled loopback model (deterministic;
//                                                   proves the harness, not real savings)
//   SCH_BENCH_LIVE=1 SCH_BENCH_STATE=<state folder> node testing/token-benchmark.js
//       your Muse subscription, signed in beforehand in that isolated state folder (for example
//       a `qa-launch.mjs live` or `bound` state after signing in; Muse data is taken from beside
//       that folder). Stop the app and supervisor using it first. Real model calls;
//       uses your allowance.
//
// Options: SCH_BENCH_RUNS (default 3 per configuration), SCH_BENCH_OUTPUT (report path).
// Configurations:
//   baseline   Muse's default reasoning effort; the task asks Muse to run the tests itself.
//   efficient  the economical effort preset (T4) and, from the second run on, the previous
//              unchanged test result attached as context instead of asking for a rerun (T2).
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { request } from '../src/client.js';
import { provider } from './provider.js';

const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const live = process.env.SCH_BENCH_LIVE === '1';
const runs = Number(process.env.SCH_BENCH_RUNS ?? 3);
if (!(runs >= 1 && runs <= 20)) throw Error('SCH_BENCH_RUNS must be 1..20');
const output = resolve(process.env.SCH_BENCH_OUTPUT ?? '.dev/benchmarks/t5/token-benchmark.json');
const root = await mkdtemp(join(tmpdir(), 'lsc-t5-'));
const directory = live ? resolve(process.env.SCH_BENCH_STATE ?? '') : join(root, 'state');
if (live && !process.env.SCH_BENCH_STATE)
  throw Error('Set SCH_BENCH_STATE to a signed-in state folder');
const model = live ? null : await provider(root, { responseDelayMs: 200 });
const env = {
  ...process.env,
  ...(model?.env ?? {}),
  SCH_STATE_DIR: directory,
  SCH_PROVIDER: 'meta',
  SCH_AUTH_MANAGED: live ? '1' : '0',
  MUSE_NO_AUTO_UPDATE: '1',
  // Muse's own data (sign-in, sessions) stays beside the chosen state folder, as qa-launch.mjs
  // lays it out, never in your normal Muse home.
  ...(live
    ? {
        XDG_CONFIG_HOME: join(dirname(directory), 'config'),
        XDG_DATA_HOME: join(dirname(directory), 'data'),
        XDG_CACHE_HOME: join(dirname(directory), 'cache'),
      }
    : {
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      }),
};
const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
  env,
  stdio: 'ignore',
});
const status = () => request(directory, 'status');
async function until(read, accept, what, ms = 300_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const value = await read();
      if (accept(value)) return value;
    } catch {}
    await delay(200);
  }
  throw Error(`Timed out waiting for ${what}`);
}

// The task: a tiny repository with a failing test; the model must fix it. Correctness is
// checked independently by running the test after the task.
async function repository(name) {
  const dir = join(root, name);
  await mkdir(dir);
  await writeFile(join(dir, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(
    join(dir, 'test.mjs'),
    "import { sum } from './sum.mjs';\nif (sum(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n",
  );
  await exec('git', ['init', '-q', dir]);
  await exec('git', ['-C', dir, 'add', '.']);
  await exec('git', [
    '-C',
    dir,
    '-c',
    'user.name=T5',
    '-c',
    'user.email=t5@example.invalid',
    'commit',
    '-qm',
    'start',
  ]);
  return dir;
}
const TASK = 'Fix sum.mjs so that `node test.mjs` passes. Keep the change minimal.';

async function one(config, index, previousResult) {
  const workspace = await repository(`${config}-${index}`);
  const started = performance.now();
  const start = await request(
    directory,
    'start',
    {
      workspace,
      name: `${config} ${index}`,
      ...(config === 'efficient' ? { effortPreset: 'economical' } : {}),
    },
    `t5-${config}-${index}-start`,
  );
  if (start.status !== 'applied') throw Error(`Start failed: ${JSON.stringify(start)}`);
  const sessionId = start.sessionId;
  await until(status, (s) => s.sessions.find((r) => r.id === sessionId)?.state.current, 'session');
  const text =
    config === 'efficient' && previousResult
      ? `${TASK}\n\n${previousResult}\nUse this result instead of running the test before your change.`
      : `${TASK} Run the test before and after your change.`;
  await request(directory, 'turn', { sessionId, text }, `t5-${config}-${index}-turn`);
  const row = (
    await until(
      status,
      (s) => {
        const r = s.sessions.find((x) => x.id === sessionId);
        return r && !r.state.activeTurnId && r.state.turns?.some((t) => t.terminal);
      },
      'task',
    )
  ).sessions.find((r) => r.id === sessionId);
  const elapsedMs = performance.now() - started;
  const turn = row.state.turns.at(-1);
  const tokens = row.state.tokens?.byTurn?.[turn.turnId] ?? null;
  const check = await exec('node', ['test.mjs'], { cwd: workspace }).then(
    () => true,
    () => false,
  );
  await request(directory, 'session/archive', { sessionId }, `t5-${config}-${index}-archive`).catch(
    () => {},
  );
  return {
    config,
    index,
    terminal: turn.terminal,
    correct: turn.terminal === 'completed' && check,
    totalTokens: tokens?.totalTokens ?? null,
    modelCalls: tokens?.calls ?? null,
    elapsedMs: Math.round(elapsedMs),
    effortPreset: row.effortPreset ?? null,
    reasoningEffort: row.state.reasoningEffort ?? null,
  };
}

const results = [];
try {
  await until(status, (s) => s.pid === daemon.pid, 'supervisor', 20_000);
  for (const config of ['baseline', 'efficient']) {
    let previous;
    for (let i = 0; i < runs; i++) {
      const result = await one(config, i, previous);
      results.push(result);
      // T2: the user's own earlier passing result, with provenance, as context for the next run.
      previous = result.correct
        ? 'Test result: `node test.mjs` failed (exit 1) before the change, run by the user; the starting files are identical.'
        : undefined;
    }
  }
  const summary = (config) => {
    const rows = results.filter((r) => r.config === config);
    const known = rows.filter((r) => typeof r.totalTokens === 'number');
    const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      runs: rows.length,
      correct: rows.filter((r) => r.correct).length,
      meanTokens: mean(known.map((r) => r.totalTokens)),
      meanModelCalls: mean(known.map((r) => r.modelCalls)),
      meanElapsedMs: mean(rows.map((r) => r.elapsedMs)),
      tokensReported: known.length,
    };
  };
  const baseline = summary('baseline');
  const efficient = summary('efficient');
  const comparable =
    efficient.correct >= baseline.correct && baseline.meanTokens && efficient.meanTokens;
  const report = {
    schemaVersion: 1,
    kind: live ? 'live-subscription' : 'controlled-loopback',
    reference: {
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      muse: (await exec(process.env.MUSE_BIN ?? 'muse', ['--version'])).stdout.trim(),
    },
    task: TASK,
    results,
    baseline,
    efficient,
    tokenSaving: comparable ? 1 - efficient.meanTokens / baseline.meanTokens : null,
    gates: {
      allCompleted: results.every((r) => r.terminal === 'completed'),
      efficientAsCorrect: efficient.correct >= baseline.correct,
      tokensReported:
        baseline.tokensReported === baseline.runs && efficient.tokensReported === efficient.runs,
    },
    limitations: [
      live
        ? 'Live runs vary between attempts; compare means over several runs and keep the raw results.'
        : 'The controlled loopback model returns fixed usage and canned responses, so this run proves the harness and the reporting, not real savings.',
      'Correctness is the repository test passing after the task, checked outside Muse.',
    ],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({
      kind: report.kind,
      baseline,
      efficient,
      tokenSaving: report.tokenSaving,
      gates: report.gates,
    }),
  );
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const exited = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await Promise.race([exited, delay(15000)]);
  }
  await model?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
