import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
test('local session sharing and explicit Muse delivery through native Rust bridge', async ({
  browser,
}) => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-relay-ui-'));
  const directory = join(root, 'state'),
    workspace = join(root, 'work');
  await mkdir(workspace);
  const env = {
    ...process.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'echo',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env,
    stdio: 'ignore',
  });
  const context = await browser.newContext();
  let releaseQuitDraft: (() => void) | undefined;
  try {
    await expect
      .poll(async () => {
        try {
          return (await request(directory, 'status')).pid;
        } catch {
          return 0;
        }
      })
      .toBe(daemon.pid);
    const a = (await request(directory, 'start', { workspace }, 'start-a')).sessionId;
    const b = (await request(directory, 'start', { workspace }, 'start-b')).sessionId;
    let loseSendReply = true;
    let failStatus = false;
    let heldDraftRead: Promise<void> | undefined;
    let heldQuitDraft: Promise<void> | undefined;
    let quitDraftStarted = false;
    let stopCalls = 0;
    let draftAtStop: string | undefined;
    await context.exposeBinding('nativeBridge', async (_s, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      if (input.operation === 'status' && failStatus) throw new Error('Synthetic IPC disconnect');
      if (input.operation === 'relay/draftSave' && heldQuitDraft) {
        quitDraftStarted = true;
        await heldQuitDraft;
      }
      if (input.operation === 'stop') {
        stopCalls++;
        draftAtStop = (await request(directory, 'relay/draftsGet')).drafts[`${b}:${a}`]?.text;
      }
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 35000, maxBuffer: 40 * 1024 * 1024 },
      );
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      if (input.operation === 'relay/draftsGet' && heldDraftRead) {
        const held = heldDraftRead;
        heldDraftRead = undefined;
        await held;
      }
      if (input.operation === 'relay/send' && loseSendReply) {
        loseSendReply = false;
        throw new Error('Simulated reply lost after durable inbox insertion');
      }
      return data.result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (c: string, a: any) => (window as any).nativeBridge(c, a),
      };
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Local messages', exact: true }).click();
    const modal = page.getByRole('dialog');
    await modal.getByLabel('Other session').selectOption(b);
    await expect(modal.getByRole('checkbox', { name: 'Allow Muse' })).not.toBeChecked();
    await modal.getByRole('checkbox', { name: 'Allow Muse' }).check();
    await modal.getByRole('button', { name: 'Connect sessions', exact: true }).click();
    await expect(modal.getByRole('button', { name: 'Disconnect sessions' })).toBeVisible();
    expect(
      (await request(directory, 'relay/get', { sessionId: a })).connections[0].allowAgentMessages,
    ).toBe(true);
    await expect(modal.getByRole('checkbox', { name: 'Allow Muse' })).toBeChecked();
    await expect(modal.getByRole('checkbox', { name: 'Allow Muse' })).toBeDisabled();
    await modal.getByLabel('Message', { exact: true }).fill('UI selected finding for B');
    await expect
      .poll(async () => (await request(directory, 'relay/draftsGet')).drafts[`${a}:${b}`]?.text)
      .toBe('UI selected finding for B');
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await page.setViewportSize({ width: 800, height: 650 });
    await page.getByRole('button', { name: 'Expand canvas controls' }).click();
    await page.getByRole('button', { name: 'Session links', exact: true }).click();
    const links = page.getByRole('region', { name: 'Session links panel', exact: true });
    await expect(
      links.getByRole('button', { name: new RegExp(`Open local conversation.*${b.slice(-8)}`) }),
    ).toBeVisible();
    await expect(links.locator('.session-link-curve')).toHaveCount(1);
    failStatus = true;
    await expect(links.locator('.session-link-owner')).toContainText('Unavailable');
    await expect(links.locator('.session-link-peer')).toContainText('Unavailable');
    failStatus = false;
    await expect(links.locator('.session-link-owner')).toContainText('Idle');
    await expect(links.locator('.session-link-curve')).toHaveAttribute('d', / C /);
    expect(
      (await new AxeBuilder({ page }).include('[aria-label="Session links panel"]').analyze())
        .violations,
    ).toEqual([]);
    expect(await links.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await links.getByRole('button', { name: 'Collapse Session links panel', exact: true }).click();
    await expect(links.getByRole('button', { name: /Open local conversation/ })).toBeHidden();
    await links.getByRole('button', { name: 'Expand Session links panel', exact: true }).click();
    await links.locator('.session-link-hit').click();
    await expect(modal.getByLabel('Other session')).toHaveValue(b);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    const peerLink = links.getByRole('button', {
      name: new RegExp(`Open local conversation.*${b.slice(-8)}`),
    });
    await peerLink.focus();
    await peerLink.press('Enter');
    await expect(modal.getByLabel('Other session')).toHaveValue(b);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await links.getByRole('button', { name: 'Collapse Session links panel', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await request(directory, 'presentation/get')).value.panels?.connections?.collapsed,
      )
      .toBe(true);
    await page.reload();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Local messages', exact: true }).click();
    await modal.getByLabel('Other session').selectOption(b);
    await expect(modal.getByLabel('Message', { exact: true })).toHaveValue(
      'UI selected finding for B',
    );
    let releaseDraftRead!: () => void;
    heldDraftRead = new Promise<void>((resolve) => {
      releaseDraftRead = resolve;
    });
    const otherPage = await context.newPage();
    await otherPage.goto('/');
    await otherPage.getByLabel('Workspace menu').click();
    await otherPage.getByRole('button', { name: 'Local messages', exact: true }).click();
    const otherDialog = otherPage.getByRole('dialog');
    await otherDialog.getByLabel('Other session').selectOption(b);
    await otherDialog
      .getByLabel('Message', { exact: true })
      .fill('Typed before saved draft loaded');
    releaseDraftRead();
    await expect(otherDialog.getByRole('region', { name: 'Message draft conflict' })).toBeVisible();
    await expect(otherDialog.getByLabel('Message', { exact: true })).toHaveValue(
      'Typed before saved draft loaded',
    );
    await otherDialog.getByRole('button', { name: 'Close dialog' }).click();
    await otherPage.getByRole('button', { name: 'Review drafts (1)', exact: true }).click();
    await expect(otherDialog.getByRole('region', { name: 'Message draft conflict' })).toBeVisible();
    await otherDialog.getByRole('button', { name: 'Use saved draft' }).click();
    await expect(otherDialog.getByLabel('Message', { exact: true })).toHaveValue(
      'UI selected finding for B',
    );
    await modal.getByLabel('Message', { exact: true }).fill('First window wins');
    await expect
      .poll(async () => (await request(directory, 'relay/draftsGet')).drafts[`${a}:${b}`]?.text)
      .toBe('First window wins');
    await otherDialog.getByLabel('Message', { exact: true }).fill('Other window retained');
    await expect(otherDialog.getByRole('region', { name: 'Message draft conflict' })).toBeVisible();
    await otherDialog.getByRole('button', { name: 'Use saved draft' }).click();
    await expect(otherDialog.getByLabel('Message', { exact: true })).toHaveValue(
      'First window wins',
    );
    await otherPage.close();
    await modal.getByLabel('Message', { exact: true }).fill('UI selected finding for B');

    await modal.getByRole('button', { name: 'Share message', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('reply lost');
    await modal.getByRole('button', { name: 'Share message', exact: true }).click();
    await expect(modal.getByLabel('Message', { exact: true })).toHaveValue('');
    expect((await request(directory, 'relay/get', { sessionId: a })).messages).toHaveLength(1);

    await expect(modal.getByText('UI selected finding for B', { exact: true })).toBeVisible();
    expect(
      (await request(directory, 'status')).commands.filter((c: any) => c.operation === 'turn'),
    ).toHaveLength(0);
    await page.setViewportSize({ width: 800, height: 650 });
    expect(await modal.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await page.context().setOffline(true);
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const help = page.getByRole('dialog');
    await help.getByLabel('Search help').fill('attachments');
    await expect(help.getByText('Files and attachments', { exact: true })).toBeVisible();
    await expect(help).toContainText('are not available yet');
    await help.getByLabel('Search help').fill('no-match-fixture');
    await expect(help).toContainText('No matching guides');
    await help.getByRole('button', { name: 'show all guides', exact: true }).click();
    await expect(help.getByRole('status')).toHaveText('12 guides');
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    await help.getByLabel('Search help').fill('messages between local sessions');
    await help.getByRole('button', { name: 'Open local messages', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Local session messages', exact: true }),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await page.context().setOffline(false);
    // Global discovery selects the recipient and exact sender without inference or receipts.
    await page.reload();
    await page.getByRole('button', { name: '1 new message', exact: true }).click();
    await expect(
      modal.getByRole('heading', { name: 'New local messages', exact: true }),
    ).toBeVisible();
    const conversation = modal.getByRole('button').filter({ hasText: b.slice(-8) });
    await expect(conversation).toContainText(a.slice(-8));
    expect(
      (await request(directory, 'relay/get', { sessionId: b })).messages[0].viewedAtMillis,
    ).toBeUndefined();
    expect((await new AxeBuilder({ page }).include('dialog').analyze()).violations).toEqual([]);
    expect(await modal.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    await conversation.click();
    await expect(modal.getByLabel('Other session')).toHaveValue(a);
    await expect(modal.getByText('UI selected finding for B', { exact: true })).toBeVisible();
    await expect(modal.getByRole('status')).toHaveText('1 new message');
    await modal.getByRole('button', { name: 'Mark messages viewed' }).click();
    await expect(modal.getByRole('status')).toHaveText('0 new messages');
    await expect(page.getByRole('button', { name: '1 new message', exact: true })).toHaveCount(0);
    await expect(modal.getByText('Viewed in Lascoria', { exact: true })).toBeVisible();
    expect(
      (await request(directory, 'status')).commands.filter((c: any) => c.operation === 'turn'),
    ).toHaveLength(0);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await page.reload();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Local messages', exact: true }).click();
    await expect(modal.getByRole('status')).toHaveText('0 new messages');
    await modal.getByRole('button', { name: 'Ask Muse about this' }).click();
    await expect
      .poll(
        async () =>
          (await request(directory, 'status')).commands.find((c: any) => c.id.startsWith('relay_'))
            ?.status,
      )
      .toBe('applied');
    await modal.getByRole('button', { name: 'Refresh messages' }).click();
    await expect(modal.getByRole('button', { name: 'Check delivery' })).toBeVisible();
    await modal.getByLabel('Other session').selectOption(a);
    await modal.getByLabel('Message', { exact: true }).fill('B replies from its own session');
    await modal.getByRole('button', { name: 'Share message', exact: true }).click();
    await expect(
      modal.locator('.relay-messages').getByText('B replies from its own session', { exact: true }),
    ).toBeVisible();
    expect((await request(directory, 'relay/get', { sessionId: a })).messages).toHaveLength(2);
    const draftKey = `${b}:${a}`;
    const currentDraft = (await request(directory, 'relay/draftsGet')).drafts[draftKey];
    await request(
      directory,
      'relay/draftSave',
      {
        sessionId: b,
        peerId: a,
        text: 'Another saved copy',
        expectedRevision: currentDraft.revision,
      },
      'remote-draft-conflict',
    );
    await modal.getByLabel('Message', { exact: true }).fill('Local copy before disconnect');
    await expect(modal.getByRole('region', { name: 'Message draft conflict' })).toBeVisible();
    await modal.getByRole('button', { name: 'Disconnect sessions' }).click();
    await expect(
      modal.getByRole('button', { name: 'Connect sessions', exact: true }),
    ).toBeVisible();
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await links.getByRole('button', { name: 'Expand Session links panel', exact: true }).click();
    await expect(links.getByText('No connected sessions yet.', { exact: true })).toBeVisible();
    await expect(links.locator('.session-link-curve')).toHaveCount(0);
    await links.getByRole('button', { name: 'Collapse Session links panel', exact: true }).click();
    await page.getByRole('button', { name: 'Review drafts (1)', exact: true }).click();
    await expect(modal.getByRole('region', { name: 'Message draft conflict' })).toBeVisible();
    await modal.getByRole('button', { name: 'Use saved draft' }).click();
    await expect(modal.getByLabel('Message', { exact: true })).toHaveValue('Another saved copy');
    await expect(modal.getByRole('button', { name: 'Share message', exact: true })).toBeDisabled();
    heldQuitDraft = new Promise<void>((resolve) => {
      releaseQuitDraft = resolve;
    });
    await modal.getByLabel('Message', { exact: true }).fill('Retained before explicit quit');
    await expect.poll(() => quitDraftStarted).toBe(true);
    await modal.getByRole('button', { name: 'Close dialog' }).click();
    await page.getByLabel('Workspace menu').click();
    await page.getByRole('button', { name: 'Quit & stop', exact: true }).click();
    await modal.getByRole('button', { name: 'Stop all sessions', exact: true }).click();
    await expect(
      modal.getByRole('button', { name: 'Stop all sessions', exact: true }),
    ).toBeDisabled();
    expect(stopCalls).toBe(0);
    releaseQuitDraft!();
    await expect.poll(() => daemon.exitCode, { timeout: 10000 }).toBe(0);
    expect(draftAtStop).toBe('Retained before explicit quit');
  } finally {
    releaseQuitDraft?.();
    await context.close();
    const done = new Promise((r) => daemon.once('exit', r));
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill('SIGTERM');
      await done;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
