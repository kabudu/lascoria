import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// R7: the real supervisor previews a support report and saves exactly that text, privately,
// only outside its private state folder. No Muse session is needed.
test('support report: preview, exact save and private-data boundaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'lsc-sup-'));
  // Short: macOS limits Unix socket paths to 104 bytes.
  const directory = join(root, 'state');
  const out = join(root, 'out');
  await mkdir(out);
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env: {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_PROVIDER: 'echo',
      SCH_AUTH_MANAGED: '0',
      XDG_CONFIG_HOME: join(root, 'config'),
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  for (let i = 0; i < 200; i++) {
    try {
      if ((await request(directory, 'status')).pid === daemon.pid) break;
    } catch {}
    await delay(50);
  }
  assert.ok((await request(directory, 'status')).features.includes('supportReport'));
  const preview = await request(directory, 'support/preview', {}, 'support-1');
  const report = JSON.parse(preview.text);
  assert.equal(report.report, 'Lascoria support report');
  assert.equal(report.sessions.count, 0);
  assert.equal(report.account.managed, false);
  assert.ok(report.features.includes('usageLatest'));
  assert.ok(!preview.text.includes(root), 'no local paths');
  assert.ok(!preview.text.includes('lsc-sup-'));
  await assert.rejects(
    request(directory, 'support/save', { reportId: 'support-1', path: join(directory, 'r.json') }),
    /outside Lascoria's private data folder/,
  );
  await assert.rejects(
    request(directory, 'support/save', { reportId: 'other', path: join(out, 'r.json') }),
    /preview the report again/,
  );
  const saved = await request(directory, 'support/save', {
    reportId: 'support-1',
    path: join(out, 'r.json'),
  });
  assert.equal(await readFile(saved.path, 'utf8'), preview.text);
  if (process.platform !== 'win32') assert.equal((await stat(saved.path)).mode & 0o777, 0o600);
});
