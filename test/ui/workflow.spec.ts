import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { provider } from '../../testing/provider.js';
import { request } from '../../src/client.js';
const exec = promisify(execFile);
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('real Muse implementation, tests and review through React and the native Rust bridge', async ({
  browser,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), 'sch-stage-b-'));
  const workspace = join(root, 'workspace');
  const directory = join(root, 'state');
  await mkdir(workspace);
  await exec('git', ['init', '-q', workspace]);
  await writeFile(join(workspace, 'README.md'), 'Stage B test repository\n');
  await exec('git', ['-C', workspace, 'add', '.']);
  await exec('git', [
    '-C',
    workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Initial',
  ]);
  const model = await provider(root, { stageB: true });
  const env = {
    ...process.env,
    MUSE_BIN: process.env.MUSE_BIN ?? 'muse',
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'meta',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  let daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
    env,
    stdio: 'ignore',
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const bridge = resolve('src-tauri/target/debug/spatial-constellation-desktop');
  let holdTranscript = false;
  let releaseTranscript: (() => void) | undefined;
  let transcriptHeld = false;
  let transcriptReturned = false;
  await context.exposeBinding('nativeBridge', async (_source, command, args) => {
    const input =
      command === 'connect_supervisor'
        ? { operation: 'status', params: {}, id: 'ui-connect' }
        : args;
    try {
      const { stdout } = await exec(bridge, ['--bridge-json', JSON.stringify(input)], {
        env,
        timeout: 35000,
        maxBuffer: 40 * 1024 * 1024,
      });
      const data = JSON.parse(stdout);
      if (data.error) throw new Error(data.error);
      if (input.operation === 'transcript' && holdTranscript) {
        transcriptHeld = true;
        await new Promise<void>((resolve) => {
          releaseTranscript = resolve;
        });
        transcriptReturned = true;
      }
      return data.result;
    } catch (e: any) {
      if (e.stdout) {
        const data = JSON.parse(e.stdout);
        throw new Error(data.error);
      }
      throw e;
    }
  });
  await context.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).nativeBridge(command, args),
    };
  });
  let page = await context.newPage();
  const status = () => request(directory, 'status');
  const ready = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const s = await status();
        if (s.pid === daemon.pid) return;
      } catch {}
      await delay(100);
    }
    throw new Error('Supervisor not ready');
  };
  const stop = async () => {
    if (daemon.exitCode !== null) return;
    const done = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await done;
  };
  try {
    await ready();
    await page.goto('/');
    await expect(page.getByText('Supervisor connected', { exact: true })).toBeVisible();
    const sessions: string[] = [];
    for (const marker of ['STAGE_B_IMPLEMENT', 'STAGE_B_TEST', 'STAGE_B_DELEGATE']) {
      await page.getByRole('button', { name: 'New session', exact: true }).click();
      await page.getByLabel('Existing repository path').fill(workspace);
      await page.getByLabel('Initial task').fill(marker);
      await page.getByRole('button', { name: 'Start session', exact: true }).click();
      await expect.poll(async () => (await status()).sessions.length).toBe(sessions.length + 1);
      const createdSession = (await status()).sessions.at(-1).id;

      if (marker === 'STAGE_B_IMPLEMENT') {
        await expect(
          page.getByRole('heading', { name: 'Permission decision', exact: true }),
        ).toBeVisible({ timeout: 20000 });
        const s = await status();
        const row = s.sessions.find((row: any) => row.id === createdSession);
        const approval = row.state.approvals[0].requested;
        const choice = approval.availableChoices.find((c: any) => c.decision === 'approved');
        await page
          .getByRole('button', {
            name: choice.label ?? choice.decision ?? choice.choiceId,
            exact: true,
          })
          .click();
      }
      await expect
        .poll(
          async () => {
            const s = await status();
            const row = s.sessions.find((row: any) => row.id === createdSession);
            return row.state.turns?.at(-1)?.terminal;
          },
          { timeout: 25000 },
        )
        .toBe('completed');
      sessions.push(createdSession);
    }
    await expect
      .poll(
        async () => {
          const value = await status();
          const workflow = value.sessions[2].state.items?.find(
            (item: any) => item.kind === 'workflow',
          );
          return workflow?.status === 'completed' ? workflow.children?.[0]?.terminal : undefined;
        },
        { timeout: 25000 },
      )
      .toBe('completed');
    await expect(
      page.getByRole('button', { name: /Workflow child.*completed, native/ }).first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: /Workflow child.*completed, native/ })
      .first()
      .click();
    await expect(
      page.getByRole('heading', { name: 'Native workflow child', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.command-area textarea')).toBeDisabled();
    await page.getByRole('button', { name: 'Open owning turn', exact: true }).click();

    expect(await readFile(join(workspace, 'sum.mjs'), 'utf8')).toContain('a + b');
    const s = await status();
    const testItem = s.sessions[1].state.items.find(
      (i: any) => i.tool === 'bash' && i.status === 'completed',
    );
    expect(testItem.visibleOutput).toContain('PASS sum(2,3)=5');
    await page.locator('.session-card').first().click();
    holdTranscript = true;
    await page.getByRole('button', { name: 'Browse history', exact: true }).click();
    await expect.poll(() => transcriptHeld).toBe(true);
    await page.locator('.session-card').nth(1).click();
    await expect(page.locator('.inspector-body')).toContainText('STAGE_B_TEST');
    releaseTranscript!();
    await expect.poll(() => transcriptReturned).toBe(true);
    await expect(page.locator('.inspector-body')).toContainText('STAGE_B_TEST');
    holdTranscript = false;
    await page.locator('.session-card').first().click();
    await page.getByRole('tab', { name: 'diff', exact: true }).click();
    await writeFile(
      join(workspace, 'unsafe.txt'),
      '<img src=x onerror=window.untrustedExecuted=true>',
    );
    await page.getByRole('button', { name: 'Capture working-tree diff', exact: true }).click();
    await expect(page.getByText('Untracked: sum.mjs', { exact: false })).toBeVisible();
    await expect(page.getByText('Current captured content', { exact: true })).toBeVisible();
    const captures = await request(directory, 'review/list', { sessionId: sessions[0] });
    const artifact = captures.artifacts[0];
    expect(await page.evaluate(() => (window as any).untrustedExecuted)).toBeUndefined();
    await expect(page.locator('.inspector-body img')).toHaveCount(0);
    expect(artifact.fingerprint).toMatch(/^sha256:/);
    await page.getByRole('tab', { name: 'evidence', exact: true }).click();
    await page.getByLabel('Native source item').selectOption(testItem.itemId);
    await page.getByLabel('Attesting user').fill('Lifecycle verifier');
    await page.getByLabel('Command or review scope').fill('node --input-type=module -e import sum');
    await page.getByLabel('Observed exit code').fill('0');
    await page.getByLabel('Execution environment').fill('macOS arm64 / Node 24 / real Muse bash');
    await page
      .getByLabel('Findings / result notes')
      .fill('Observed PASS sum(2,3)=5 in native tool output.');
    await page.getByRole('button', { name: 'Save revision-bound attestation' }).click();
    await expect(page.getByText('test: passed', { exact: true })).toBeVisible();
    await page.getByLabel('Evidence type').selectOption('review');
    await page
      .getByLabel('Native source item')
      .selectOption(
        s.sessions[2].state.items.find(
          (i: any) => i.kind === 'workflow' && i.status === 'completed',
        ).itemId,
      );
    await page.getByLabel('Reviewer', { exact: true }).fill('Human reviewer');
    await page.getByLabel('Command or review scope').fill('Inspected captured sum.mjs');
    await page
      .getByLabel('Findings / result notes')
      .fill('Addition implementation inspected at the displayed fingerprint.');
    await page.getByRole('button', { name: 'Save revision-bound attestation' }).click();
    await expect(page.getByText('review: approved', { exact: true })).toBeVisible();
    const savedEvidence = (
      await request(directory, 'review/list', { sessionId: sessions[0] })
    ).evidence.find((entry: any) => entry.params.kind === 'test');
    const evidenceId = savedEvidence.id.slice('evidence_'.length);
    expect((await request(directory, 'evidence/record', savedEvidence.params, evidenceId)).id).toBe(
      savedEvidence.id,
    );
    await expect(
      request(
        directory,
        'evidence/record',
        { ...savedEvidence.params, notes: 'Changed' },
        evidenceId,
      ),
    ).rejects.toThrow(/different payload/);
    await expect(
      request(
        directory,
        'evidence/record',
        { ...savedEvidence.params, sourceRevision: 999 },
        'obsolete-source',
      ),
    ).rejects.toThrow(/Source item changed/);
    await expect(
      request(
        directory,
        'evidence/record',
        { ...savedEvidence.params, exitCode: 1 },
        'wrong-outcome',
      ),
    ).rejects.toThrow(/does not match exit code/);
    const presentation = await request(directory, 'presentation/get');
    await expect(
      request(
        directory,
        'presentation/save',
        { expectedRevision: presentation.revision - 1, value: {} },
        'stale-layout',
      ),
    ).rejects.toThrow(/Presentation changed/);

    const retryParams = { expectedRevision: presentation.revision, value: presentation.value };
    const written = await request(directory, 'presentation/save', retryParams, 'layout-retry');
    expect(await request(directory, 'presentation/save', retryParams, 'layout-retry')).toEqual(
      written,
    );
    await expect(
      request(directory, 'presentation/save', { ...retryParams, value: {} }, 'layout-retry'),
    ).rejects.toThrow(/retry payload changed/);
    // Restore UI's expected revision by reloading through its normal bootstrap.
    await page.reload();
    await expect(page.getByText('Supervisor connected', { exact: true })).toBeVisible();
    await page.getByText('Task label, notes and relationships', { exact: true }).click();
    await page.getByLabel('Task label', { exact: true }).fill('Implement addition');
    await expect
      .poll(
        async () =>
          (await request(directory, 'presentation/get')).value.labels?.[
            `${sessions[0]}:${(await status()).sessions.find((s: any) => s.id === sessions[0]).state.turns[0].turnId}`
          ],
      )
      .toBe('Implement addition');
    await page.getByRole('button', { name: 'Pin / move right' }).click();
    await page
      .getByLabel('Target task')
      .selectOption(`${sessions[1]}:${s.sessions[1].state.turns[0].turnId}`);
    await page.getByRole('button', { name: 'Record user assertion' }).click();
    await expect(page.getByText(/depends on STAGE_B_TEST/)).toBeVisible();

    await page.getByRole('button', { name: 'List', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const p = await request(directory, 'presentation/get');
        return p.value.view;
      })
      .toBe('list');
    expect(
      (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
        .violations,
    ).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('stage-b-light.png'), fullPage: true });
    await page.close();
    page = await context.newPage();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Task map', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Implement addition/ }).first()).toBeVisible();
    expect((await status()).pid).toBe(daemon.pid);
    await page.getByRole('tab', { name: 'transcript', exact: true }).focus();
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { name: 'evidence', exact: true })).toBeFocused();
    await expect(page.getByText('test: passed', { exact: true })).toBeVisible();
    await writeFile(join(workspace, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
    await expect(page.getByText('Stale: repository changed', { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(
      page.getByRole('button', { name: 'Save revision-bound attestation' }),
    ).toBeDisabled();
    const evidence = (await request(directory, 'review/list', { sessionId: sessions[0] })).evidence;
    expect(evidence).toHaveLength(2);
    await expect(
      request(
        directory,
        'evidence/record',
        { ...evidence[0].params, notes: 'New stale attestation' },
        'stale-evidence',
      ),
    ).rejects.toThrow(/Artifact changed/);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });
    await page.getByRole('button', { name: 'Open command palette' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('stage-b-200-percent.png'), fullPage: true });
    await page.close();
    await stop();
    daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env,
      stdio: 'ignore',
    });
    await ready();
    await expect
      .poll(
        async () => {
          const value = await status();
          return value.sessions.every((s: any) => s.state.current);
        },
        { timeout: 25000 },
      )
      .toBe(true);
    expect(
      (await request(directory, 'review/list', { sessionId: sessions[0] })).evidence,
    ).toHaveLength(2);
    expect((await request(directory, 'presentation/get')).value.view).toBe('list');
    page = await context.newPage();
    await page.goto('/');
    await expect(page.getByText('Supervisor connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Quit & stop', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('registered sessions');
    await page.getByRole('button', { name: 'Stop all sessions', exact: true }).click();
    await expect(page.getByText('Disconnected', { exact: true })).toBeVisible();
    await expect.poll(() => daemon.exitCode, { timeout: 10000 }).toBe(0);
  } finally {
    releaseTranscript?.();
    try {
      await context.close();
    } finally {
      try {
        await stop();
      } finally {
        await model.close();
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
});
