// R11-3: status cost against command-journal size. Seeds a fresh journal with N command rows
// (one in ten a full record, the rest compacted tombstones, as cleanup leaves them), then
// measures sequential status reads and supervisor memory. No Muse session is started.
//
//   SCH_SUPERVISOR=<binary> node testing/status-scale.js [rows ...]
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { request } from '../src/client.js';
const binary = resolve(
  process.env.SCH_SUPERVISOR ?? 'supervisor/target/debug/constellation-supervisor',
);
const sizes = process.argv.slice(2).map(Number);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function measure(rows) {
  const root = await mkdtemp(join(tmpdir(), 'lsc-status-'));
  const directory = join(root, 'state');
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    XDG_CONFIG_HOME: join(root, 'config'),
  };
  let daemon;
  const boot = async () => {
    daemon = spawn(binary, [], { env, stdio: 'ignore' });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await request(directory, 'status')).pid === daemon.pid) return;
      } catch {}
      await delay(50);
    }
    throw Error('supervisor not ready');
  };
  const stop = async () => {
    const exited = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await exited;
  };
  try {
    await boot();
    await stop();
    const db = new DatabaseSync(join(directory, 'state.sqlite'));
    const insert = db.prepare('INSERT INTO commands VALUES (?, ?)');
    db.exec('BEGIN');
    for (let n = 0; n < rows; n++) {
      const id = `seed-${n}`;
      const base = { id, operation: 'turn', sessionId: 'seed', createdAtMillis: n };
      insert.run(
        id,
        JSON.stringify(
          n % 10 === 0
            ? { ...base, status: 'applied', params: { sessionId: 'seed', text: 'x'.repeat(200) } }
            : { ...base, status: 'applied', compacted: true, compactedAtMillis: n },
        ),
      );
    }
    db.exec('COMMIT');
    db.close();
    await boot();
    const latencies = [];
    for (let i = 0; i < 300; i++) {
      const start = performance.now();
      const status = await request(directory, 'status');
      latencies.push(performance.now() - start);
      if (status.commands.length !== Math.min(100, rows)) throw Error('wrong command page');
      if (rows && status.commands[0].id !== `seed-${rows - 1}`) throw Error('not newest first');
    }
    const rss =
      Number(execFileSync('ps', ['-o', 'rss=', '-p', String(daemon.pid)]).toString()) * 1024;
    await stop();
    latencies.sort((a, b) => a - b);
    return {
      rows,
      p50Ms: latencies[149],
      p95Ms: latencies[284],
      maxMs: latencies[299],
      supervisorRssBytes: rss,
    };
  } finally {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}
const results = [];
for (const rows of sizes.length ? sizes : [100, 5000, 20000]) results.push(await measure(rows));
console.log(JSON.stringify({ binary, results }));
