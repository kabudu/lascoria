import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// R14: images wait in a session's composer and are sent only with the next task.
test('composer images: choose, paste, refuse, survive reload, remove and send with a task', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-uimg-'));
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
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
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
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Pictures', exact: true })).toBeVisible();
    const strip = page.getByRole('list', { name: 'Images for the next task' });
    await expect(strip).toHaveCount(0);

    // Choosing stages the image; nothing is sent.
    await page.getByLabel('Choose images to attach').setInputFiles([
      { name: 'diagram.png', mimeType: 'image/png', buffer: PNG },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') },
    ]);
    await expect(strip.getByText('diagram.png')).toBeVisible();
    await expect(strip).toContainText('1×1');
    await expect(
      page.getByRole('status').filter({ hasText: 'notes.txt is not a PNG' }),
    ).toBeVisible();
    expect((await status()).commands.filter((c: any) => c.operation === 'turn')).toHaveLength(0);

    // Pasting an image adds it to the same strip.
    await page.getByRole('textbox', { name: 'New task for this session' }).evaluate((el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, PNG.toString('base64'));
    await expect(strip.getByText('pasted.png')).toBeVisible();
    await expect(strip.getByText('Preparing', { exact: false })).toHaveCount(0);
    expect((await request(directory, 'attachment/list', { sessionId })).attachments).toHaveLength(
      2,
    );
    expect((await new AxeBuilder({ page }).include('form').analyze()).violations).toEqual([]);

    // Waiting images survive a reload; removing one deletes it.
    await page.reload();
    await expect(strip.getByText('diagram.png')).toBeVisible();
    await expect(strip.getByText('pasted.png')).toBeVisible();
    await strip.getByRole('button', { name: 'Remove pasted.png' }).click();
    await expect(strip.getByText('pasted.png')).toHaveCount(0);
    await expect
      .poll(
        async () => (await request(directory, 'attachment/list', { sessionId })).attachments.length,
      )
      .toBe(1);

    await page
      .getByRole('textbox', { name: 'New task for this session' })
      .fill('What is in this image?');
    await page.getByRole('button', { name: 'Start turn', exact: true }).click();
    await expect
      .poll(async () => {
        const s = await status();
        return (
          !s.commands.some((c: any) => c.status === 'sending') &&
          s.sessions[0].state.turns?.at(-1)?.terminal === 'completed'
        );
      })
      .toBe(true);
    const turn = (await status()).commands.find((c: any) => c.operation === 'turn');
    expect(turn.params.attachments).toHaveLength(1);
    expect(JSON.stringify(turn)).not.toContain(PNG.toString('base64'));
    await expect(strip).toHaveCount(0);
    expect((await request(directory, 'attachment/list', { sessionId })).attachments).toHaveLength(
      0,
    );
    await expect(page.getByText('1 image attached')).toBeVisible();
    await page.setViewportSize({ width: 800, height: 700 });
    expect(
      await page
        .locator('form')
        .filter({ hasText: 'Add image' })
        .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
    ).toBe(true);
  } finally {
    await context.close();
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const stopped = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await stopped;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
