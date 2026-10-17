import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);

// D3: the retained transcript is saved as Markdown to a place the user chooses.
test('Export transcript writes the retained conversation outside private state', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-tx-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'workspace'),
    outside = join(root, 'exports');
  await mkdir(workspace);
  await mkdir(outside);
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
  let chosen: string | null = join(outside, 'notes-transcript.md');
  const suggestions: string[] = [];
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
    const { sessionId } = await request(
      directory,
      'start',
      { workspace, name: 'Release notes' },
      's1',
    );
    await expect.poll(async () => (await status()).sessions[0]?.state.current).toBe(true);
    await request(directory, 'turn', { sessionId, text: 'Summarise the release' }, 't1');
    await expect
      .poll(async () => (await status()).sessions[0].state.turns?.at(-1)?.terminal)
      .toBe('completed');
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      // The OS save dialog is native acceptance; the rest uses the real Rust bridge.
      if (command === 'pick_transcript_destination') {
        suggestions.push(args.suggested);
        return chosen;
      }
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
    const exportButton = page.getByRole('button', { name: 'Export transcript…', exact: true });
    // Cancelling the chooser writes nothing.
    chosen = null;
    await exportButton.click();
    await expect.poll(() => suggestions.length).toBe(1);
    expect(suggestions[0]).toBe('Release-notes-transcript.md');
    chosen = join(outside, 'notes-transcript.md');
    await exportButton.click();
    const retained = (await status()).sessions[0].state.items.length;
    await expect(
      page.getByText(`Transcript saved · ${retained} messages`, { exact: false }),
    ).toBeVisible();
    const text = await readFile(chosen, 'utf8');
    expect(text).toContain('# Release notes');
    expect(text).toContain('Summarise the release');
    expect(text).toContain('## Muse');
    if (process.platform !== 'win32') expect((await stat(chosen)).mode & 0o777).toBe(0o600);
    // A destination inside Lascoria's private data is refused with a clear message.
    chosen = join(directory, 'leak.md');
    await exportButton.click();
    await expect(page.getByRole('alert')).toContainText('outside Lascoria');
    expect((await status()).commands.filter((c: any) => c.operation === 'turn')).toHaveLength(1);
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
