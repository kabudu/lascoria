import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

// Security finding F1: with the desktop named, other same-user programs holding the token are refused.
test('supervisor control is bound to the desktop executable when the app starts it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-peer-'));
  const directory = join(root, 'state');
  const desktop = resolve('src-tauri/target/debug/spatial-constellation-desktop');
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    SCH_DESKTOP_EXE: desktop,
  };
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env,
    stdio: 'ignore',
  });
  const bridge = async (operation: string, params = {}) => {
    const { stdout } = await exec(
      desktop,
      [
        '--bridge-json',
        JSON.stringify({ operation, params, id: `peer-${operation.replace('/', '-')}` }),
      ],
      { env, timeout: 35000 },
    ).catch((error) => (error.code === 1 && error.stdout ? error : Promise.reject(error)));
    return JSON.parse(stdout);
  };
  try {
    // The debug supervisor hashes the large debug desktop binary at startup before it answers;
    // on slower machines that takes several seconds.
    await expect
      .poll(async () => (await bridge('status').catch(() => ({})))?.result?.pid ?? 0, {
        timeout: 30000,
      })
      .toBe(daemon.pid);
    // This test runner holds the real token but is not the desktop app.
    await expect(request(directory, 'status')).rejects.toThrow(
      /Only the Lascoria app can control its background service/,
    );
    await expect(request(directory, 'data/summary')).rejects.toThrow(/Only the Lascoria app/);
    expect((await bridge('data/summary')).result.sessionLimit).toBe(100);
  } finally {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
