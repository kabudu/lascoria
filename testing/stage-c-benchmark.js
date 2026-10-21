// Real supervisor + real Muse echo runtime. No paid provider or user state.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, arch, loadavg, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { request } from '../src/client.js';
const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const seconds = Number(process.env.SCH_BENCH_IDLE_SECONDS ?? 300);
if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600)
  throw Error('Idle seconds must be 1..600');
// R11: session count (1, 5 or 10) and an optional packaged runtime, so release builds and the
// marginal cost per session are measured with the same workload.
const sessionCount = Number(process.env.SCH_BENCH_SESSIONS ?? 10);
if (![1, 5, 10].includes(sessionCount)) throw Error('Sessions must be 1, 5 or 10');
const packaged = process.env.SCH_BENCH_RUNTIME ? resolve(process.env.SCH_BENCH_RUNTIME) : null;
const output = resolve(process.env.SCH_BENCH_OUTPUT ?? '.dev/benchmarks/stage-c/runtime.json');
const root = await mkdtemp(join(tmpdir(), 'sch-benchmark-'));
const directory = join(root, 'state');
const workspace = join(root, 'workspace');
await mkdir(workspace);
await exec('git', ['init', '-q', workspace]);
const env = {
  ...process.env,
  SCH_STATE_DIR: directory,
  SCH_PROVIDER: 'echo',
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
};
delete env.META_API_KEY;
// SCH_BENCH_NODE substitutes the Node used for workers (for example a wrapper adding V8 flags).
if (packaged)
  Object.assign(env, {
    SCH_RESOURCES: packaged,
    SCH_NODE: process.env.SCH_BENCH_NODE ?? join(packaged, 'node'),
  });
const supervisorBinary = packaged
  ? join(packaged, 'constellation-supervisor')
  : resolve('supervisor/target/debug/constellation-supervisor');
const loadBefore = loadavg();
const daemon = spawn(supervisorBinary, [], {
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let spawnError;
daemon.on('error', (error) => {
  spawnError = error;
});
const running = () => daemon.exitCode === null && daemon.signalCode === null;
let stderr = '';
daemon.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-4096);
});
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1] ?? null;
const summary = (xs) => ({
  count: xs.length,
  p50Ms: quantile(xs, 0.5),
  p95Ms: quantile(xs, 0.95),
  maxMs: Math.max(...xs),
});
async function inventory() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm=']);
  const all = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, rss, time, ...name] = line.trim().split(/\s+/);
      const parts = time.split(':').map(Number);
      const cpuSeconds = parts.reduce((sum, n) => sum * 60 + n, 0);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rssBytes: Number(rss) * 1024,
        cpuSeconds,
        name: name.join(' ').split('/').at(-1),
      };
    });
  return all;
}
async function processes() {
  const all = await inventory();
  const ids = new Set([daemon.pid, ...(guiPid ? [guiPid] : [])]);
  if (guiPid)
    for (const p of all)
      if (p.name.startsWith('com.apple.WebKit.') && !foreignWebKit.has(p.pid)) ids.add(p.pid);
  for (let i = 0; i < all.length; i++) {
    let added = false;
    for (const p of all)
      if (ids.has(p.ppid) && !ids.has(p.pid)) {
        ids.add(p.pid);
        added = true;
      }
    if (!added) break;
  }
  return all.filter((p) => ids.has(p.pid));
}
// macOS physical footprint (Activity Monitor "Memory"): private dirty memory plus compressed,
// without the shared framework and binary pages that RSS counts once per process. Taken once,
// after the CPU window, so the measuring tool does not disturb the idle measurement.
async function footprints(list) {
  if (platform() !== 'darwin') return null;
  const result = {};
  for (const p of list) {
    try {
      const { stdout } = await exec('footprint', ['-p', String(p.pid)]);
      const match = stdout.match(/phys_footprint:\s*([\d.]+)\s*(KB|MB|GB|B)/);
      if (match)
        result[p.pid] =
          Number(match[1]) * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2]];
    } catch {}
  }
  return result;
}
let report;
const guiBinary = process.env.SCH_BENCH_GUI_BIN;
let gui;
let guiPid;
// WebKit helpers have launchd parents, so they cannot be attributed by ancestry. Helpers that
// already exist belong to other apps and are excluded; every helper appearing after the GUI
// launches is charged to it. The stable-process-tree gate fails if any appear later.
const foreignWebKit = new Set();

try {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await request(directory, 'status', {}, undefined, 500);
      break;
    } catch {
      if (spawnError) throw spawnError;
      if (Date.now() > deadline) throw Error('Readiness: ' + stderr);
      await delay(100);
    }
  }
  console.log(`Starting ${sessionCount} isolated echo sessions`);
  const ids = [];
  const startTimes = [];
  for (let i = 0; i < sessionCount; i++) {
    const start = performance.now();
    const r = await request(directory, 'start', { workspace });
    if (r.status !== 'applied') throw Error('Start not applied');
    ids.push(r.sessionId);
    startTimes.push(performance.now() - start);
    await request(directory, 'turn', {
      sessionId: r.sessionId,
      text: 'Stage C bounded echo benchmark',
    });
  }
  const verify = (state) => {
    assert.deepEqual(
      state.sessions.map((s) => s.id),
      ids,
    );
    for (const row of state.sessions) {
      assert.equal(row.state.sessionId, row.id);
      assert.equal(row.generation, 1);
      assert.equal(row.lifecycle, 'connected');
      assert.equal(row.state.current, true);
      assert.equal(row.state.activeTurnId ?? null, null);
      assert.equal(row.state.turns.at(-1)?.terminal, 'completed');
    }
  };
  for (let i = 0; i < 100; i++) {
    const state = await request(directory, 'status');
    if (
      state.sessions.every((s) => s.state.current && !s.state.activeTurnId && s.state.turns?.length)
    ) {
      verify(state);
      break;
    }
    if (i === 99) throw Error('Echo turns did not settle');
    await delay(100);
  }
  const latency = [];
  const burstStart = performance.now();
  let failures = 0;
  let maximumResponseBytes = 0;
  // Three seconds, 100 scheduled snapshot reads/sec, at most four in flight.
  const inFlight = new Set();
  for (let n = 0; n < 300; n++) {
    await delay(Math.max(0, burstStart + n * 10 - performance.now()));
    if (inFlight.size >= 4) await Promise.race(inFlight);
    const job = (async () => {
      const start = performance.now();
      try {
        const result = await request(directory, 'status');
        verify(result);
        maximumResponseBytes = Math.max(
          maximumResponseBytes,
          Buffer.byteLength(JSON.stringify(result)),
        );
      } catch {
        failures++;
      } finally {
        latency.push(performance.now() - start);
      }
    })();
    inFlight.add(job);
    job.finally(() => inFlight.delete(job));
  }
  await Promise.all(inFlight);
  const burstElapsedMs = performance.now() - burstStart;
  if (guiBinary) {
    if (platform() !== 'darwin')
      throw Error('Native GUI cohort benchmark currently requires macOS');
    for (const p of await inventory())
      if (p.name.startsWith('com.apple.WebKit.')) foreignWebKit.add(p.pid);
    gui = spawn(resolve(guiBinary), [], { env, stdio: 'ignore' });
    guiPid = gui.pid;
    let guiError;
    gui.on('error', (error) => {
      guiError = error;
    });
    for (let i = 0; i < 100; i++) {
      if (guiError) throw guiError;
      if (
        (await inventory()).some(
          (p) => p.name === 'com.apple.WebKit.WebContent' && !foreignWebKit.has(p.pid),
        )
      )
        break;
      if (i === 99) throw Error('Native WebView did not become ready');
      await delay(100);
    }
    // Allow startup allocations to settle before the idle interval.
    await delay(3000);
  }
  console.log(`Idle resource observation: ${seconds} seconds`);
  const baseline = await processes();
  const idleStart = performance.now();
  const samples = [];
  for (let i = 0; i < seconds; i++) {
    await delay(1000);
    samples.push(await processes());
  }
  verify(await request(directory, 'status'));
  const footprint = await footprints(samples.at(-1));
  const elapsedSeconds = (performance.now() - idleStart) / 1000;
  const last = samples.at(-1);
  const baselineById = new Map(baseline.map((p) => [p.pid, p]));
  const cpu = (predicate) =>
    (last
      .filter(predicate)
      .reduce(
        (n, p) => n + Math.max(0, p.cpuSeconds - (baselineById.get(p.pid)?.cpuSeconds ?? 0)),
        0,
      ) /
      elapsedSeconds) *
    100;
  const rss = (predicate) =>
    samples.reduce((n, s) => n + s.filter(predicate).reduce((a, p) => a + p.rssBytes, 0), 0) /
    samples.length;
  const stableProcessTree = samples.every(
    (sample) => sample.length === baseline.length && sample.every((p) => baselineById.has(p.pid)),
  );
  const control = (p) => p.pid === daemon.pid || p.ppid === daemon.pid;
  const webkit = (p) => p.name.startsWith('com.apple.WebKit.') && !foreignWebKit.has(p.pid);
  const guiProcess = (p) => p.pid === guiPid || webkit(p);
  const combined = (p) => control(p) || (Boolean(guiPid) && guiProcess(p));
  report = {
    schemaVersion: 1,
    kind: guiPid ? 'native-gui-real-supervisor-real-muse-echo' : 'real-supervisor-real-muse-echo',
    reference: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0].model,
      node: process.version,
      commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      dirtyCheckout: Boolean((await exec('git', ['status', '--porcelain'])).stdout.trim()),
      buildMode: packaged ? 'release (packaged runtime)' : 'debug',
      supervisor: supervisorBinary,
      logicalCpus: cpus().length,
      memoryBytes: totalmem(),
      loadAverageBefore: loadBefore,
      loadAverageAfter: loadavg(),
      muse: (await exec(env.MUSE_BIN ?? 'muse', ['--version'])).stdout.trim(),
    },
    workload: {
      sessions: sessionCount,
      snapshotRequests: 300,
      targetReadsPerSecond: 100,
      maxInFlight: 4,
      sdkMode: process.env.SCH_DEDICATED_WORKERS ? 'dedicated' : 'shared',
      guiIncluded: Boolean(guiPid),
      idleSeconds: seconds,
    },
    start: summary(startTimes),
    snapshot: summary(latency),
    burst: {
      elapsedMs: burstElapsedMs,
      achievedReadsPerSecond: (300 / burstElapsedMs) * 1000,
      failures,
      maximumResponseBytes,
    },
    idle: {
      elapsedSeconds,
      sampleCount: samples.length,
      controlCpuPercentOneCore: cpu(control),
      controlMeanRssBytes: rss(control),
      guiCohortMeanRssBytes: guiPid ? rss(guiProcess) : null,
      combinedMeanRssBytes: guiPid ? rss(combined) : null,
      combinedCpuPercentOneCore: guiPid ? cpu(combined) : null,
      fullTreeCpuPercentOneCore: cpu(() => true),
      fullTreeMeanRssBytes: rss(() => true),
      fullTreeCpuPercentMachine: cpu(() => true) / cpus().length,
      // Physical footprint at the end of the window (macOS only; null elsewhere).
      footprintBytes: footprint
        ? Object.fromEntries(
            Object.entries({
              control: control,
              gui: guiPid ? guiProcess : () => false,
              // Everything Lascoria itself runs: supervisor, SDK broker, relay helpers, GUI.
              lascoria: (p) =>
                control(p) ||
                p.name === 'constellation-supervisor' ||
                (Boolean(guiPid) && guiProcess(p)),
              museHosts: (p) => /^muse/.test(p.name),
              fullTree: () => true,
            }).map(([key, predicate]) => [
              key,
              last.filter(predicate).reduce((n, p) => n + (footprint[p.pid] ?? 0), 0),
            ]),
          )
        : null,
      footprintMissing: footprint
        ? last.filter((p) => footprint[p.pid] === undefined).length
        : null,
      museHostCount: last.filter((p) => /^muse/.test(p.name)).length,
      processTree: footprint
        ? last.map((p) => ({ ...p, footprintBytes: footprint[p.pid] ?? null }))
        : last,
    },
    diagnostics: await request(directory, 'diagnostics'),
    gates: {
      stableProcessTree,
      expectedSdkProcessCount:
        last.filter((p) => p.ppid === daemon.pid).length ===
        (process.env.SCH_DEDICATED_WORKERS ? sessionCount : 1),
      ...(guiPid
        ? { combinedRss: rss(combined) < 300_000_000, combinedCpu: cpu(combined) < 1 }
        : {}),
      idleControlCpu: cpu(control) < 1,
      idleControlRss: rss(control) < 300_000_000,
      fullFiveMinuteObservation: seconds >= 300,
      snapshotP95Under100ms: quantile(latency, 0.95) < 100,
      noErrors: failures === 0,
    },
    limitations: [
      'CPU uses ps cumulative time at platform resolution; direct children of the supervisor are classified as SDK workers.',
      guiPid
        ? `GUI cohort includes every WebKit process that appeared after launch; ${foreignWebKit.size} pre-existing WebKit processes of other apps were excluded. Another WebKit app starting during observation would be charged to the GUI and fail the stable-tree gate. Native GUI uses ${sessionCount} sessions with one turn each, not the fifty-node synthetic workload.`
        : 'No GUI is represented.',
      'No live-provider latency, native view-update stream, 100000-item runtime history or developer usefulness trial is represented. Snapshot requests are reads, not Muse view updates.',
    ],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report.gates));
} finally {
  if (gui && gui.exitCode === null && gui.signalCode === null) {
    const exited = new Promise((r) => gui.once('exit', r));
    gui.kill('SIGTERM');
    await Promise.race([exited, delay(5000)]);
    if (gui.exitCode === null && gui.signalCode === null) gui.kill('SIGKILL');
  }
  try {
    const state = await request(directory, 'status', {}, undefined, 1000);
    await request(
      directory,
      'stop',
      { sessions: state.sessions.map((s) => s.id) },
      undefined,
      10000,
    );
  } catch {
    daemon.kill('SIGTERM');
  }
  if (running()) {
    await Promise.race([new Promise((r) => daemon.once('exit', r)), delay(10000)]);
    if (running()) daemon.kill('SIGKILL');
  }
  await rm(root, { recursive: true, force: true });
}
if (
  report &&
  (!report.gates.noErrors ||
    !report.gates.stableProcessTree ||
    report.burst.achievedReadsPerSecond < 90 ||
    (process.env.SCH_BENCH_ENFORCE === '1' && !Object.values(report.gates).every(Boolean)))
)
  process.exitCode = 1;
