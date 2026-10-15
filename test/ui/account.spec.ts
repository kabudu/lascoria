import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
test('account onboarding through native Rust bridge: key, subscription priority, logout, accessibility', async ({
  page,
}, info) => {
  test.skip(process.platform !== 'darwin', 'macOS Keychain integration');
  const root = await mkdtemp(join(tmpdir(), 'lascoria-account-ui-'));
  const directory = join(root, 'state');
  await mkdir(directory);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_AUTH_MANAGED: '1',
    SCH_ACCOUNT_WORKER: resolve('testing/account-worker.js'),
  };
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env,
    stdio: 'ignore',
  });
  let opened = '';
  let finishRuntime!: (value: any) => void;
  const runtime = new Promise((resolve) => {
    finishRuntime = resolve;
  });
  await page.exposeFunction('accountBridge', async (command: string, args: any) => {
    if (command.startsWith('plugin:')) return 1;
    if (command === 'runtime_status') return runtime;
    if (command === 'open_account_browser') {
      opened = args.url;
      return;
    }
    const input =
      command === 'connect_supervisor'
        ? { operation: 'status', params: {}, id: 'account-connect' }
        : args;
    try {
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 35000, maxBuffer: 4 * 1024 * 1024 },
      );
      return JSON.parse(stdout).result;
    } catch (e: any) {
      throw new Error(e.stdout ? JSON.parse(e.stdout).error : 'Bridge unavailable');
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: (command: string, args: any) => (window as any).accountBridge(command, args),
    };
  });
  try {
    for (let i = 0; i < 100; i++) {
      try {
        await request(directory, 'status');
        break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    await page.goto('/');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your Muse connection' })).toBeVisible();
    await expect(page.getByText('Checking your Muse runtime…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install Muse', exact: true })).toHaveCount(0);
    finishRuntime({ ready: true, version: '1.4.9', path: '/fixture/muse' });
    await expect(page.getByText('Muse 1.4.9 · ready')).toBeVisible();
    const audit = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(audit.violations).toEqual([]);
    await page.locator('.account-api summary').click();
    await page.getByLabel('Meta API key', { exact: true }).fill('ui-fixture-key-never-log');
    await page.getByRole('button', { name: 'Save and use API key', exact: true }).click();
    await expect(page.getByText('API billing selected', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Meta API key', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'Continue with Muse', exact: true }).click();
    await expect(page.getByText('Subscription active', { exact: true })).toBeVisible();
    expect(opened).toMatch(/^https:\/\/auth.meta.com\/oauth\/device\//);
    await expect(page.getByRole('button', { name: 'Use API billing instead' })).toHaveCount(0);
    await page.locator('.account-api summary').click();
    await page.getByLabel('Meta API key', { exact: true }).fill('ui-fixture-replacement');
    await page.getByRole('button', { name: 'Save inactive API key', exact: true }).click();
    await expect(page.getByText('Subscription active', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out of Lascoria…', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Confirm sign out' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out and stop Muse', exact: true }).click();
    await expect(page.getByText('Connect to Muse', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your Muse connection' })).toBeVisible();
    expect((await request(directory, 'account/status')).authenticated).toBe(false);
    await page.setViewportSize({ width: 800, height: 600 });
    await page.screenshot({ path: info.outputPath('account-light.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    const db = await readFile(join(directory, 'state.sqlite'));
    expect(db.includes(Buffer.from('ui-fixture-key-never-log'))).toBe(false);
    expect(db.includes(Buffer.from('ui-fixture-replacement'))).toBe(false);
  } finally {
    try {
      await request(directory, 'account/forgetKey');
    } catch {}
    const exited = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await exited;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
