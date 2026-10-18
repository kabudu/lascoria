import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
// Header-valid PNG (signature + IHDR, 1x1) padded to the requested size; staging checks the
// header, size and checksum, not the pixels.
const png = (bytes: number) => {
  const head = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  return Buffer.concat([head, Buffer.alloc(bytes - head.length, 7)]);
};

// Review findings: oversized files are refused before any read while limits are unknown, and
// retrying after a lost reply resumes the same upload instead of leaving an orphan copy.
test('composer images: bounded intake without limits and exactly-once recovery after lost replies', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lsc-imgr-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    SCH_AUTH_MANAGED: '0',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env,
    stdio: 'ignore',
  });
  const context = await browser.newContext();
  const status = () => request(directory, 'status');
  const calls: string[] = [];
  let holdList: Promise<void> | null = null;
  let releaseList = () => {};
  let rejectList = false;
  let loseAfterCommit: string | null = null;
  try {
    await expect
      .poll(async () => {
        try {
          return (await status()).pid;
        } catch {
          return 0;
        }
      })
      .toBe(daemon.pid);
    const { sessionId } = await request(directory, 'start', { workspace, name: 'Pictures' }, 's1');
    await expect.poll(async () => (await status()).sessions[0]?.state.current).toBe(true);
    const bridge = async (input: any) => {
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 35000, maxBuffer: 40 * 1024 * 1024 },
      ).catch((error) => {
        if (error.code === 1 && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      return data.result;
    };
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      if (command === 'connect_supervisor')
        return bridge({ operation: 'status', params: {}, id: 'connect' });
      const operation = args?.operation as string;
      if (operation?.startsWith('attachment/')) calls.push(operation);
      if (operation === 'attachment/list') {
        if (rejectList) throw new Error('Supervisor unavailable');
        if (holdList) await holdList;
      }
      const result = await bridge(args);
      if (operation === loseAfterCommit) {
        // The supervisor has committed the request; only the reply is lost.
        loseAfterCommit = null;
        throw new Error('Connection lost before the reply arrived');
      }
      return result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });
    const page = await context.newPage();
    const strip = page.getByRole('list', { name: 'Attachments for the next task' });
    const chooser = page.getByLabel('Choose files to attach');
    const tooLarge = { name: 'huge.png', mimeType: 'image/png', buffer: png(6 * 1024 * 1024) };

    // 1. Limits not loaded yet (list held), then unavailable (list fails): the oversized image
    // is refused before any preview, upload or checksum.
    holdList = new Promise((r) => (releaseList = r));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Pictures', exact: true })).toBeVisible();
    await chooser.setInputFiles([tooLarge]);
    await expect(
      page.getByRole('status').filter({ hasText: 'huge.png is larger than 5.0 MB' }),
    ).toBeVisible();
    await expect(strip).toHaveCount(0);
    expect(calls.filter((c) => c !== 'attachment/list')).toEqual([]);
    releaseList();
    holdList = null;
    rejectList = true;
    await page.reload();
    await expect(
      page.getByText('Attachments waiting for this session could not be loaded.'),
    ).toBeVisible();
    calls.length = 0;
    await chooser.setInputFiles([tooLarge]);
    await expect(
      page.getByRole('status').filter({ hasText: 'huge.png is larger than 5.0 MB' }),
    ).toBeVisible();
    await expect(strip).toHaveCount(0);
    expect(calls).toEqual([]);
    rejectList = false;
    await page.reload();

    // 2. finish commits but its reply is lost: Retry finds the finished upload.
    loseAfterCommit = 'attachment/finish';
    await chooser.setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: png(2000) }]);
    await expect(strip.getByRole('button', { name: 'Retry first.png' })).toBeVisible();
    await strip.getByRole('button', { name: 'Retry first.png' }).click();
    await expect(strip.getByText('1×1')).toHaveCount(1);
    await expect(strip.getByRole('button', { name: 'Retry first.png' })).toHaveCount(0);

    // 3. A middle chunk commits but its reply is lost: Retry resumes the same upload.
    loseAfterCommit = 'attachment/append';
    await chooser.setInputFiles([
      { name: 'second.png', mimeType: 'image/png', buffer: png(120_000) },
    ]);
    await strip.getByRole('button', { name: 'Retry second.png' }).click();
    await expect(strip.getByText('1×1')).toHaveCount(2);

    const listed = (await request(directory, 'attachment/list', { sessionId })).attachments;
    expect(listed.map((a: any) => a.name).sort()).toEqual(['first.png', 'second.png']);
    // No orphan staging left behind: only the two finished uploads exist on disk.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(directory, 'attachments', sessionId));
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2);
    await page.reload();
    await expect(strip.getByText('first.png')).toHaveCount(1);
    await expect(strip.getByText('second.png')).toHaveCount(1);
  } finally {
    releaseList();
    await context.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
