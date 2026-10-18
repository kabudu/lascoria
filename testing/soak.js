// R11 soak: repeated real work against the real supervisor and Muse echo runtime, with
// resource samples throughout. No model provider, credential or user state is used.
//
//   SCH_SOAK_MINUTES=30 [SCH_BENCH_RUNTIME=<packaged runtime>] node testing/soak.js
//
// Each cycle starts a session, runs two tasks, reads status, searches, exports the transcript,
// archives the session and removes it with Data & backups cleanup; every fifth cycle also
// restarts the supervisor (reconnect and recovery). Three sessions stay open throughout as
// background load. The report compares the first and last fifths of the run so growth in
// memory, processes or journal size is visible instead of averaged away.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus, platform, release, arch, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { request } from '../src/client.js';
const exec = promisify(execFile);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const minutes = Number(process.env.SCH_SOAK_MINUTES ?? 30);
if (!(minutes >= 1 && minutes <= 120)) throw Error('Soak minutes must be 1..120');
const packaged = process.env.SCH_BENCH_RUNTIME ? resolve(process.env.SCH_BENCH_RUNTIME) : null;
const output = resolve(process.env.SCH_BENCH_OUTPUT ?? '.dev/benchmarks/r11/soak.json');
const root = await mkdtemp(join(tmpdir(), 'lsc-soak-'));
const directory = join(root, 'state');
const workspace = join(root, 'workspace');
const exports = join(root, 'exports');
await mkdir(workspace);
await mkdir(exports);
await exec('git', ['init', '-q', workspace]);
const env = {
  ...process.env,
  SCH_STATE_DIR: directory,
  SCH_PROVIDER: 'echo',
  SCH_AUTH_MANAGED: '0',
  MUSE_NO_AUTO_UPDATE: '1',
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  ...(packaged ? { SCH_RESOURCES: packaged, SCH_NODE: join(packaged, 'node') } : {}),
};
delete env.META_API_KEY;
const supervisorBinary = packaged
  ? join(packaged, 'constellation-supervisor')
  : resolve('supervisor/target/debug/constellation-supervisor');
let daemon;
const alive = () => daemon && daemon.exitCode === null && daemon.signalCode === null;
async function boot() {
  daemon = spawn(supervisorBinary, [], { env, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await request(directory, 'status', {}, undefined, 1000)).pid === daemon.pid) return;
    } catch {}
    await delay(100);
  }
  throw Error('Supervisor did not become ready');
}
async function shutdown() {
  if (!alive()) return;
  const exited = new Promise((r) => daemon.once('exit', r));
  daemon.kill('SIGTERM');
  await Promise.race([exited, delay(15000)]);
  if (alive()) daemon.kill('SIGKILL');
}
async function inventory() {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm=']);
  return stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid, rss, time, ...name] = line.trim().split(/\s+/);
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        rssBytes: Number(rss) * 1024,
        cpuSeconds: time
          .split(/[:-]/)
          .map(Number)
          .reduce((sum, n) => sum * 60 + n, 0),
        name: name.join(' ').split('/').at(-1),
      };
    });
}
// The supervisor and every descendant (SDK broker, Muse hosts, relay helpers, test commands).
async function tree() {
  const all = await inventory();
  const ids = new Set([daemon.pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all)
      if (ids.has(p.ppid) && !ids.has(p.pid)) {
        ids.add(p.pid);
        changed = true;
      }
  }
  return all.filter((p) => ids.has(p.pid));
}
const row = async (id) => (await request(directory, 'status')).sessions.find((s) => s.id === id);
async function settled(id, turns) {
  for (let i = 0; i < 600; i++) {
    const s = await row(id);
    if (s?.state.current && s.state.turns?.length >= turns && !s.state.activeTurnId) return s;
    await delay(100);
  }
  throw Error(`Session ${id} did not settle`);
}
async function task(id, text, n) {
  await request(directory, 'turn', { sessionId: id, text }, `${id}-t${n}`);
  const s = await settled(id, n);
  if (s.state.turns.at(-1).terminal !== 'completed') throw Error('Task did not complete');
}
const samples = [];
const errors = [];
const latencies = [];
let cycles = 0;
let restarts = 0;
let completedTasks = 0;
let cpuOffset = 0; // CPU seconds of supervisors that have exited, so restarts are counted.
let lastTreeCpu = 0;
const started = performance.now();
const deadline = started + minutes * 60_000;
let sampler;
try {
  await boot();
  const background = [];
  for (let i = 0; i < 3; i++) {
    const { sessionId } = await request(
      directory,
      'start',
      { workspace, name: `Background ${i + 1}` },
      `bg-${i}`,
    );
    await settled(sessionId, 0);
    await task(sessionId, `Background session ${i + 1} ready`, 1);
    completedTasks++;
    background.push(sessionId);
  }
  sampler = (async () => {
    while (performance.now() < deadline) {
      try {
        if (alive()) {
          const procs = await tree();
          const treeCpu = procs.reduce((n, p) => n + p.cpuSeconds, 0);
          lastTreeCpu = treeCpu;
          samples.push({
            atSeconds: (performance.now() - started) / 1000,
            processes: procs.length,
            museHosts: procs.filter((p) => /^muse/.test(p.name)).length,
            rssBytes: procs.reduce((n, p) => n + p.rssBytes, 0),
            controlRssBytes: procs
              .filter((p) => p.pid === daemon.pid || p.ppid === daemon.pid)
              .reduce((n, p) => n + p.rssBytes, 0),
            cpuSeconds: cpuOffset + treeCpu,
          });
        }
      } catch (e) {
        errors.push(`sample: ${e.message}`);
      }
      await delay(5000);
    }
  })();
  while (performance.now() < deadline) {
    cycles++;
    try {
      const { sessionId } = await request(
        directory,
        'start',
        { workspace, name: `Cycle ${cycles}` },
        `c${cycles}-start`,
      );
      await settled(sessionId, 0);
      await task(sessionId, `Soak cycle ${cycles} first task`, 1);
      await task(sessionId, `Soak cycle ${cycles} second task`, 2);
      completedTasks += 2;
      const t = performance.now();
      await request(directory, 'status');
      latencies.push(performance.now() - t);
      const found = await request(directory, 'search', { query: `soak cycle ${cycles}` });
      if (!found.results.some((r) => r.sessionId === sessionId)) throw Error('Search missed');
      await request(
        directory,
        'data/transcript',
        { sessionId, path: join(exports, `cycle-${cycles % 5}.md`) },
        `c${cycles}-md`,
      );
      await request(directory, 'session/archive', { sessionId }, `c${cycles}-archive`);
      for (let i = 0; i < 100 && (await row(sessionId))?.lifecycle !== 'archived'; i++)
        await delay(100);
      await request(directory, 'data/removeArchived', { sessionIds: [sessionId] }, `c${cycles}-rm`);
      if (cycles % 5 === 0) {
        cpuOffset += lastTreeCpu;
        lastTreeCpu = 0;
        await shutdown();
        await boot();
        restarts++;
        for (const id of background) await settled(id, 1);
      }
    } catch (e) {
      errors.push(`cycle ${cycles}: ${e.message}`);
      if (!alive()) await boot();
    }
  }
  await sampler;
  const summary = await request(directory, 'data/summary');
  const fifth = Math.max(1, Math.floor(samples.length / 5));
  const mean = (xs, key) => xs.reduce((n, s) => n + s[key], 0) / xs.length;
  const first = samples.slice(0, fifth);
  const lastFifth = samples.slice(-fifth);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    kind: 'soak-real-supervisor-real-muse-echo',
    reference: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0].model,
      logicalCpus: cpus().length,
      node: process.version,
      commit: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(),
      dirtyCheckout: Boolean((await exec('git', ['status', '--porcelain'])).stdout.trim()),
      buildMode: packaged ? 'release (packaged runtime)' : 'debug',
      muse: (await exec(env.MUSE_BIN ?? 'muse', ['--version'])).stdout.trim(),
      loadAverageAfter: loadavg(),
    },
    workload: { minutes, backgroundSessions: 3, cycles, restarts, completedTasks },
    errors,
    statusLatency: {
      count: sorted.length,
      p50Ms: sorted[Math.floor(sorted.length * 0.5)] ?? null,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
      maxMs: sorted.at(-1) ?? null,
    },
    resources: {
      sampleIntervalSeconds: 5,
      samples: samples.length,
      meanTreeCpuPercentOneCore:
        ((samples.at(-1).cpuSeconds - samples[0].cpuSeconds) /
          (samples.at(-1).atSeconds - samples[0].atSeconds)) *
        100,
      firstFifth: {
        meanRssBytes: mean(first, 'rssBytes'),
        meanControlRssBytes: mean(first, 'controlRssBytes'),
        meanProcesses: mean(first, 'processes'),
        meanMuseHosts: mean(first, 'museHosts'),
      },
      lastFifth: {
        meanRssBytes: mean(lastFifth, 'rssBytes'),
        meanControlRssBytes: mean(lastFifth, 'controlRssBytes'),
        meanProcesses: mean(lastFifth, 'processes'),
        meanMuseHosts: mean(lastFifth, 'museHosts'),
      },
      peakRssBytes: Math.max(...samples.map((s) => s.rssBytes)),
      maxProcesses: Math.max(...samples.map((s) => s.processes)),
    },
    retained: {
      sessions: summary.sessions,
      journalEntries: summary.journalEntries,
      journalRows: summary.journalRows,
      databaseBytes: summary.databaseBytes,
      backups: summary.backups.length,
    },
    elapsedSeconds,
    gates: {
      noErrors: errors.length === 0,
      usefulWork: completedTasks >= cycles * 2,
      museHostsReturnToBaseline: lastFifth.every((s) => s.museHosts <= 4),
      noProcessAccumulation: mean(lastFifth, 'processes') <= mean(first, 'processes') + 2,
      controlRssGrowthUnder20Percent:
        mean(lastFifth, 'controlRssBytes') <= mean(first, 'controlRssBytes') * 1.2,
      sessionsBounded: summary.sessions <= 4,
    },
    limitations: [
      'ps RSS and cumulative CPU time; shared pages are counted per process. CPU of processes that exit between 5-second samples (removed sessions, restarted supervisors after their last sample) is not counted, so CPU is a lower bound.',
      'Echo provider: no live-provider streaming, questions or approvals. No GUI in this soak.',
      'Cleanup makes a safety backup each cycle; at most ten backups are retained.',
    ],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ gates: report.gates, workload: report.workload }));
  if (!Object.values(report.gates).every(Boolean)) process.exitCode = 1;
} finally {
  await shutdown();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
