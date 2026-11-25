import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { request } from '../../src/client.js';
import { provider } from '../../testing/provider.js';

const exec = promisify(execFile);

test('a mission recovers stale dependencies, resolves a rehearsal conflict and gates delivery', async ({
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), 'lsc-mission-'));
  const repo = join(root, 'source');
  const remote = join(root, 'origin.git');
  const directory = join(root, 'state');
  const file = 'sum.mjs';
  const change = (expression: string) => `export const sum = (a, b) => ${expression};\n`;
  const git = (path: string, ...args: string[]) =>
    exec('git', ['-C', path, ...args]).then(({ stdout }) => stdout.trim());
  await mkdir(repo);
  await mkdir(remote);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Mission Fixture');
  await git(repo, 'config', 'user.email', 'mission@example.invalid');
  await git(remote, 'init', '--bare', '-b', 'main');
  await writeFile(join(repo, file), change('0'));
  await git(repo, 'add', file);
  await git(repo, 'commit', '-qm', 'Establish base');
  await git(repo, 'remote', 'add', 'origin', remote.replaceAll('\\', '/'));
  await git(repo, 'push', '-q', 'origin', 'main');
  const base = await git(repo, 'rev-parse', 'HEAD');

  const model = await provider(root, { stageB: true });
  const env = {
    ...process.env,
    ...model.env,
    SCH_STATE_DIR: directory,
    SCH_PROVIDER: 'meta',
    SCH_AUTH_MANAGED: '0',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const launchSupervisor = () =>
    spawn(resolve('supervisor/target/debug/constellation-supervisor' + suffix), [], {
      env,
      stdio: 'ignore',
    });
  let daemon = launchSupervisor();
  const stop = async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const done = new Promise((done) => daemon.once('exit', done));
    daemon.kill();
    await done;
  };
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const call = (op: string, params: object = {}, id?: string) => request(directory, op, params, id);
  const status = () => call('status');
  const row = async (id: string) => (await status()).sessions.find((s: any) => s.id === id);
  const projectId = randomUUID();
  const folder = { id: randomUUID(), name: 'App', path: repo };
  const mission = () => call('mission/get', { projectId });
  const act = async (op: string, params: object = {}, id?: string) =>
    call(`mission/${op}`, { projectId, revision: (await mission()).plan.revision, ...params }, id);
  const command = async (id: string) => (await status()).commands.find((c: any) => c.id === id);
  const start = async (name: string, permissionProfile = ':ask-me') => {
    const { sessionId } = await call('start', {
      projectId,
      projectRevision: 1,
      name,
      isolated: true,
      permissionProfile,
    });
    return {
      sessionId: sessionId as string,
      worktree: (await row(sessionId)).managedWorkspace.path,
    };
  };
  const commit = async (worktree: string, expr: string) => {
    await writeFile(join(worktree, file), change(expr));
    await git(worktree, 'add', file);
    await git(worktree, 'commit', '-qm', `Change expression to ${expr}`);
    return git(worktree, 'rev-parse', 'HEAD');
  };
  const accept = async (taskId: string, sessionId: string, note: string) => {
    const params = { taskId, sessionId, note, handoffId: null };
    const preview = await act('evidencePreview', params);
    await act('accept', { ...params, preview });
  };
  const taskState = async (index: number, state: string) => {
    await expect
      .poll(async () => (await mission()).tasks[index].state, { timeout: 35000 })
      .toBe(state);
  };
  try {
    await expect.poll(async () => (await status().catch(() => ({}))).pid).toBe(daemon.pid);
    await call('project/save', {
      id: projectId,
      expectedRevision: 0,
      name: 'Arithmetic project',
      folders: [folder],
    });
    const a = await start('Addition design');
    const b = await start('Implementation isolate');
    const verify = await start('Verification isolate');
    const integration = await start('Integration isolate');
    const [aId, bId, verifyId] = [randomUUID(), randomUUID(), randomUUID()];
    const tasks = [
      { id: aId, title: 'Design the sum', dependsOn: [], sessionId: a.sessionId },
      { id: bId, title: 'Implement sum', dependsOn: [], sessionId: b.sessionId },
      {
        id: verifyId,
        title: 'Verify both tasks',
        dependsOn: [aId, bId],
        sessionId: verify.sessionId,
      },
    ].map((task) => ({
      ...task,
      brief: 'Work on the arithmetic interface.',
      criteria: 'Adding 2 and 3 gives 5.',
    }));
    const goal = 'Make addition reliable';
    await expect(
      act('save', { goal, tasks: [{ ...tasks[0], dependsOn: [verifyId] }, ...tasks.slice(1)] }),
    ).rejects.toThrow(/cycl/i);
    await act('save', { goal, tasks });
    await expect(act('save', { revision: 0, goal, tasks })).rejects.toThrow(/changed/i);
    await expect(act('launch', { taskId: verifyId, sessionId: verify.sessionId })).rejects.toThrow(
      /upstream/i,
    );

    await context.exposeBinding('missionBridge', async (_source, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop' + suffix),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 65000, maxBuffer: 12 * 1024 * 1024 },
      ).catch((error) => {
        if (error.code === 1 && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const message = JSON.parse(stdout);
      if (message.error) throw Error(message.error);
      return message.result;
    });
    await context.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (command: string, args: any) => (window as any).missionBridge(command, args),
      };
    });
    const page = await context.newPage();
    await page.goto('/');
    await page.locator('.session-card').filter({ hasText: 'Addition design' }).click();
    await page.getByRole('button', { name: 'Project Mission', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Project Mission' });
    const pick = (title: string) => dialog.getByRole('button', { name: new RegExp('^' + title) });
    const btn = (name: string) => dialog.getByRole('button', { name, exact: true });
    const refresh = () => btn('Refresh mission').click();
    await expect(dialog.getByRole('heading', { name: goal })).toBeVisible();
    await expect(dialog.locator('.mission-connector')).toHaveCount(2);
    await btn('Edit plan').click();
    await pick('Design the sum').click();
    await dialog
      .getByRole('textbox', { name: /^Brief/ })
      .fill('STAGE_A_INPUT Choose how to verify the interface.');
    await btn('Save plan').click();
    await expect(btn('Edit plan')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('mission-plan-light.png') });
    await page.setViewportSize({ width: 820, height: 720 });
    const map = dialog.getByRole('region', { name: 'Mission task map' });
    const detail = dialog.getByRole('region', { name: 'Mission task detail' });
    const mapBounds = (await map.boundingBox())!;
    const detailBounds = (await detail.boundingBox())!;
    const dependentBounds = (await pick('Verify both tasks').boundingBox())!;
    expect(detailBounds.y).toBeGreaterThanOrEqual(mapBounds.y + mapBounds.height);
    expect(dependentBounds.x + dependentBounds.width).toBeLessThanOrEqual(
      mapBounds.x + mapBounds.width,
    );
    await page.setViewportSize({ width: 1440, height: 960 });
    await pick('Design the sum').click();
    await btn('Start this task').click();
    await taskState(0, 'needsInput');
    await refresh();
    await btn('Needs your input').click();
    await expect(dialog).toHaveCount(0);
    const focusedAnswer = page.locator('form.decision:focus-within');
    await expect(
      focusedAnswer.getByRole('heading', { name: 'Muse needs an answer' }),
    ).toBeFocused();
    await focusedAnswer.getByLabel('Choose a test value').selectOption('Alpha');
    await focusedAnswer.getByRole('button', { name: 'Submit answer' }).click();
    await taskState(0, 'readyToAccept');
    await page.getByRole('button', { name: 'Project Mission', exact: true }).click();
    await pick('Design the sum').click();
    const headA = await commit(a.worktree, 'a - b');
    await refresh();
    await dialog.getByLabel('Evidence summary').fill('The sum interface takes two numbers.');
    await btn('Preview evidence').click();
    await btn('Accept this evidence').click();
    await taskState(0, 'accepted');

    const bParams = { taskId: bId, sessionId: b.sessionId };
    await act('launch', bParams, 'mission-implementation');
    await taskState(1, 'readyToAccept');
    await act('launch', bParams, 'mission-implementation');
    expect((await row(b.sessionId)).state.turns).toHaveLength(1);
    const headB = await commit(b.worktree, 'a * b');
    await accept(bId, b.sessionId, 'Compared the implementation interface.');
    const verifyParams = { taskId: verifyId, sessionId: verify.sessionId };
    await act('launch', verifyParams);
    await taskState(2, 'readyToAccept');
    await writeFile(join(a.worktree, 'interface.md'), 'One upstream interface changed.\n');
    await taskState(2, 'stale');
    await expect(act('evidencePreview', { ...verifyParams, note: 'Old output' })).rejects.toThrow(
      /upstream/i,
    );
    await git(a.worktree, 'add', 'interface.md');
    await git(a.worktree, 'commit', '-qm', 'Revise the upstream interface');
    const revisedA = await git(a.worktree, 'rev-parse', 'HEAD');
    expect(revisedA).not.toBe(headA);
    await accept(aId, a.sessionId, 'The upstream interface changed and was rechecked.');
    await taskState(2, 'stale');
    await act('reopen', verifyParams);
    await act('launch', verifyParams);
    await taskState(2, 'readyToAccept');
    await accept(verifyId, verify.sessionId, 'The current upstream interface was verified.');

    const selection = { sessionId: integration.sessionId, taskIds: [aId, bId] };
    const rehearsal = await act('integrationPreview', selection);
    expect(rehearsal.base).toBe(base);
    expect(rehearsal.sources.map((item: any) => item.head)).toEqual([revisedA, headB]);
    await act('assemble', { ...selection, preview: rehearsal }, 'rehearse-arithmetic');
    expect((await mission()).integration.status).toBe('conflict');
    await expect(
      call('turn', { sessionId: integration.sessionId, text: 'Unexpected Muse edit' }),
    ).rejects.toThrow(/reserved/i);

    // Restart with Git's pending merge still on disk and no reliance on the WebView.
    await stop();
    daemon = launchSupervisor();
    await expect.poll(async () => (await status().catch(() => ({}))).pid).toBe(daemon.pid);
    expect((await mission()).integration.status).toBe('conflict');
    const scope = { sessionId: integration.sessionId };
    expect((await row(integration.sessionId)).state.current).toBe(false);
    const conflict = await act('conflictPreview', scope);
    expect(conflict.conflicts).toEqual([file]);
    await expect(act('stage', { ...scope, path: file, conflict })).rejects.toThrow(
      /conflict markers/i,
    );
    await writeFile(join(integration.worktree, file), change('a + b'));
    await expect(act('stage', { ...scope, path: file, conflict })).rejects.toThrow(/changed/i);
    await act('stage', { ...scope, path: file, conflict: await act('conflictPreview', scope) });
    const staged = await act('conflictPreview', scope);
    expect(staged.conflicts).toEqual([]);
    expect(staged.patch).toContain('a + b');
    await act('continue', { ...scope, conflict: staged });
    expect((await mission()).integration.status).toBe('assembled');
    expect(await git(integration.worktree, 'status', '--porcelain')).toBe('');
    expect((await git(integration.worktree, 'show', '-s', '--format=%P')).split(' ')).toHaveLength(
      2,
    );

    const check =
      'node -e "import(\'./sum.mjs\').then(m => { if (m.sum(2, 3) !== 5) process.exit(1) })"';
    await refresh();
    await btn('Integration & review').click();
    await btn('Open integration workspace').click();
    const workspace = page.getByRole('tabpanel', { name: 'Workspace' });
    await workspace.getByLabel('Test command').fill(check);
    await workspace.getByRole('button', { name: 'Run command', exact: true }).click();
    await expect.poll(async () => (await mission()).integration.test?.command).toBe(check);
    await page.getByRole('button', { name: 'Project Mission', exact: true }).click();
    const delivery = await call('workspace/delivery', scope);
    const push = { ...scope, revision: delivery.revision, head: delivery.head, remote: 'origin' };
    await expect(call('workspace/push', push, 'push-before-review')).rejects.toThrow(/review/i);
    await expect(act('reviewPreview', { sessionId: b.sessionId })).rejects.toThrow(/separate/i);
    const reviewer = await start('Review isolate', ':read-only');
    const reviewScope = { sessionId: reviewer.sessionId };
    const packet = await act('reviewPreview', reviewScope);
    expect(packet.text).toContain('a + b');
    expect(packet.text).toContain(tasks[0].criteria);
    expect(packet.head).toBe(delivery.head);
    await act('review', { ...reviewScope, preview: packet }, 'arithmetic-review');
    await expect
      .poll(async () => (await mission()).integration.review?.terminal, { timeout: 35000 })
      .toBe('completed');
    await act('finding', { taskId: aId, note: 'Document negative inputs in the interface.' });
    await expect(act('acceptReview')).rejects.toThrow(/findings/i);

    await refresh();
    await expect(pick('Design the sum')).toHaveAccessibleName(/1 open review finding/);
    await pick('Design the sum').click();
    await btn('Open review findings').click();
    await expect(dialog.getByText('Document negative inputs in the interface.')).toBeVisible();
    await page.setViewportSize({ width: 820, height: 720 });
    const audit = () => new AxeBuilder({ page }).include('.mission-dialog').analyze();
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect((await audit()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('mission-review-light.png') });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    expect((await audit()).violations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('mission-review-dark.png') });
    await btn('Add to task draft').click();
    await expect(page.getByRole('dialog', { name: 'Project Mission' })).toHaveCount(0);
    await expect(page.locator('textarea').filter({ visible: true })).toHaveValue(
      /Document negative inputs/,
    );
    const finding = (await mission()).plan.rehearsal.review.findings[0];
    await act('resolveFinding', { findingId: finding.id });
    await act('acceptReview');
    await call('workspace/push', push, 'push-reviewed-mission');
    await expect.poll(async () => (await command('push-reviewed-mission'))?.status).toBe('applied');
    expect(await git(remote, 'rev-parse', delivery.branch)).toBe(delivery.head);
    expect(await git(a.worktree, 'rev-parse', 'HEAD')).toBe(revisedA);
    expect(await git(b.worktree, 'rev-parse', 'HEAD')).toBe(headB);
    expect(await readFile(join(repo, file), 'utf8')).toBe(change('0'));
  } finally {
    await context.close();
    await stop();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
});
