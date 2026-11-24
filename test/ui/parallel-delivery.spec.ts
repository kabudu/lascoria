import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { request } from '../../src/client.js';
import { provider } from '../../testing/provider.js';

const exec = promisify(execFile);

test('three Muse tasks hand off evidence, detect overlap and deliver a recovered PR conflict', async ({
  browser,
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The controlled GitHub CLI uses a POSIX fixture');
  test.setTimeout(180_000);
  const root = await mkdtemp('/tmp/lsc-coord-');
  const repo = join(root, 'source');
  const contributor = join(root, 'contributor');
  const remote = join(root, 'origin.git');
  const state = join(root, 'state');
  const gh = join(root, 'gh');
  const prFile = join(root, 'pr.json');
  const viewFile = join(root, 'view.json');
  const git = (path: string, ...args: string[]) =>
    exec('git', ['-C', path, ...args]).then(({ stdout }) => stdout.trim());
  const initial = 'export const sum = (a, b) => 0;\n';
  const change = (expression: string) => `export const sum = (a, b) => ${expression};\n`;
  await mkdir(repo);
  await mkdir(remote);
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await git(remote, 'init', '-q', '--bare', '-b', 'main');
  await writeFile(join(repo, 'sum.mjs'), initial);
  await writeFile(join(repo, 'design.md'), 'Initial behaviour\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'Start from a shared base');
  await git(repo, 'remote', 'add', 'origin', 'https://github.com/fixture/parallel.git');
  await git(repo, 'config', 'remote.origin.pushurl', remote);
  await git(repo, 'push', '-q', 'origin', 'main');
  const originalHead = await git(repo, 'rev-parse', 'HEAD');
  await exec('git', ['clone', '-q', remote, contributor]);
  await git(contributor, 'config', 'user.name', 'Fixture');
  await git(contributor, 'config', 'user.email', 'fixture@example.invalid');
  const realGit = (await exec('which', ['git'])).stdout.trim();
  const gitBin = join(root, 'git');
  // Preserve production remote identity checks. Only fetches to the fixture host are
  // routed to its bare repository, and the Git worktree operations remain real.
  await writeFile(
    gitBin,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = fetch ]; then
    exec '${realGit}' -c 'url.${remote}.insteadOf=https://github.com/fixture/parallel.git' "$@"
  fi
done
exec '${realGit}' "$@"
`,
  );
  await chmod(gitBin, 0o755);

  await writeFile(prFile, '[]');
  await writeFile(
    gh,
    `#!/bin/sh
case "$1 $2" in
  'pr view') cat '${viewFile}' ;;
  'pr list') cat '${prFile}' ;;
  'pr create') cat >/dev/null; sed 's/^/[/;s/$/]/' '${viewFile}' > '${prFile}'; echo https://github.com/fixture/parallel/pull/17 ;;
esac
`,
  );
  await chmod(gh, 0o755);
  const model = await provider(root, { stageB: true });
  const env = {
    ...process.env,
    ...model.env,
    PATH: root + ':' + process.env.PATH,
    SCH_STATE_DIR: state,
    SCH_PROVIDER: 'meta',
    SCH_AUTH_MANAGED: '0',
    SCH_GH_BIN: gh,
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  const supervisor = resolve('supervisor/target/debug/constellation-supervisor');
  let daemon = spawn(supervisor, [], { env, stdio: 'ignore' });
  const stop = async () => {
    if (daemon.exitCode !== null || daemon.signalCode !== null) return;
    const done = new Promise((resolve) => daemon.once('exit', resolve));
    daemon.kill();
    await done;
  };
  const pool = await browser.newContext({ viewport: { width: 1440, height: 990 } });
  const call = (operation: string, params: object = {}, id?: string) =>
    request(state, operation, params, id);
  const status = () => call('status');
  const row = async (id: string) => (await status()).sessions.find((item: any) => item.id === id);
  const turn = async (id: string, text: string) => {
    const prior = (await row(id)).state.turns?.length ?? 0;
    await call('turn', { sessionId: id, text });
    await expect
      .poll(async () => (await row(id)).state.turns?.[prior]?.terminal, { timeout: 30000 })
      .toBe('completed');
    return (await row(id)).state.turns[prior].turnId;
  };
  const receipt = async (id: string) =>
    (await status()).commands.find((item: any) => item.id === id);
  try {
    await expect.poll(async () => (await status().catch(() => ({}))).pid).toBe(daemon.pid);
    const sessions = await Promise.all(
      ['Design', 'Implementation', 'Verification'].map(async (name) => {
        const { sessionId } = await call('start', { workspace: repo, isolated: true, name });
        return {
          name,
          sessionId,
          worktree: (await row(sessionId)).managedWorkspace.path as string,
        };
      }),
    );
    const [a, b, c] = await Promise.all(
      sessions.map(async (session) => ({
        ...session,
        turnId: await turn(session.sessionId, `${session.name} task`),
      })),
    );
    await writeFile(join(a.worktree, 'design.md'), 'Use conventional addition for the sum.\n');
    await call(
      'workspace/run',
      { sessionId: a.sessionId, command: 'grep -q addition design.md' },
      'design-check',
    );
    await expect.poll(async () => (await receipt('design-check'))?.result?.outcome).toBe('passed');
    await writeFile(join(b.worktree, 'sum.mjs'), change('a - b'));
    await git(b.worktree, 'add', 'sum.mjs');
    await git(b.worktree, 'commit', '-qm', 'Implement the initial proposal');
    await writeFile(join(c.worktree, 'sum.mjs'), change('a * b'));
    const bScope = { sessionId: b.sessionId };
    const initialDelivery = await call('workspace/delivery', bScope);
    await call(
      'workspace/push',
      {
        ...bScope,
        revision: initialDelivery.revision,
        head: initialDelivery.head,
        remote: 'origin',
      },
      'first-push',
    );
    await expect
      .poll(async () => (await receipt('first-push'))?.status, { timeout: 25000 })
      .toBe('applied');
    const writePr = async (mergedState: string, status: string) => {
      await writeFile(
        viewFile,
        JSON.stringify({
          number: 17,
          url: 'https://github.com/fixture/parallel/pull/17',
          title: 'Implement sum',
          state: 'OPEN',
          headRefName: initialDelivery.branch,
          headRefOid: await git(b.worktree, 'rev-parse', 'HEAD'),
          baseRefName: 'main',
          baseRefOid: await git(contributor, 'rev-parse', 'HEAD'),
          mergeStateStatus: mergedState,
          isCrossRepository: false,
          isDraft: false,
          reviewDecision: status === 'success' ? 'REVIEW_REQUIRED' : '',
          statusCheckRollup: [
            {
              name: 'Build',
              status: status === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
              ...(status === 'success' ? { conclusion: 'SUCCESS' } : {}),
            },
          ],
        }),
      );
    };
    await writePr('CLEAN', 'pending');
    await call(
      'workspace/pullRequest',
      {
        ...bScope,
        revision: initialDelivery.revision,
        head: initialDelivery.head,
        remote: 'origin',
        base: 'main',
        title: 'Implement sum',
        body: 'Synthetic pull request',
        draft: false,
        linkedTaskId: `${b.sessionId}:${b.turnId}`,
      },
      'open-pr',
    );
    await expect
      .poll(async () => (await receipt('open-pr'))?.status, { timeout: 25000 })
      .toBe('applied');

    await pool.exposeBinding('nativeBridge', async (_source, command, args) => {
      const input =
        command === 'connect_supervisor'
          ? { operation: 'status', params: {}, id: 'connect' }
          : args;
      const { stdout } = await exec(
        resolve('src-tauri/target/debug/spatial-constellation-desktop'),
        ['--bridge-json', JSON.stringify(input)],
        { env, timeout: 65_000, maxBuffer: 40 * 1024 * 1024 },
      ).catch((error) => {
        if (error.code === 1 && error.stdout) return { stdout: error.stdout };
        throw error;
      });
      const result = JSON.parse(stdout);
      if (result.error) throw Error(result.error);
      return result.result;
    });
    await pool.addInitScript(() => {
      (window as any).__TAURI_INTERNALS__ = {
        invoke: (command: string, args: any) => (window as any).nativeBridge(command, args),
      };
    });
    const page = await pool.newPage();
    await page.goto('/');
    const workspace = () => page.getByRole('tabpanel', { name: 'workspace' });
    const pick = (name: string) => page.locator('.session-card').filter({ hasText: name }).click();
    const openWorkspace = () => page.getByRole('tab', { name: 'workspace' }).click();

    // A chooses a verified result and sends it to B's draft without starting a turn.
    await pick('Design');
    await openWorkspace();
    await workspace().getByText('Task handoffs', { exact: true }).click();
    await workspace().getByLabel('Receiving task').selectOption(`${b.sessionId}:${b.turnId}`);
    await workspace().getByLabel('Evidence to share').selectOption('test');
    await workspace().getByRole('button', { name: 'Preview handoff' }).click();
    const preview = workspace().getByRole('region', { name: 'Preview handoff' });
    await expect(preview).toContainText('grep -q addition design.md');
    await preview.getByRole('button', { name: 'Save handoff' }).click();
    await workspace().getByRole('button', { name: 'Review handoff', exact: true }).click();
    const handoff = workspace().getByRole('region', { name: 'Saved handoff' });
    await expect(handoff).toContainText('Source revision verified');
    await handoff.getByRole('button', { name: 'Add to receiving draft' }).click();
    await expect(page.getByRole('textbox', { name: 'New task for this session' })).toHaveValue(
      /Workspace test: grep -q addition design.md/,
    );
    expect((await row(b.sessionId)).state.turns).toHaveLength(1);
    const saved = (
      await call('handoff/list', { task: { sessionId: a.sessionId, turnId: a.turnId } })
    ).handoffs[0];
    await writeFile(join(a.worktree, 'design.md'), 'The source decision has changed.\n');
    expect((await call('handoff/check', { handoffId: saved.id })).current).toBe(false);
    const reverse = {
      source: { sessionId: b.sessionId, turnId: b.turnId },
      target: { sessionId: a.sessionId, turnId: a.turnId },
      selection: { kind: 'decision', note: 'This would close the dependency loop.' },
    };
    const reverseEvidence = await call('handoff/preview', reverse);
    await expect(call('handoff/save', { ...reverse, evidence: reverseEvidence })).rejects.toThrow(
      'depend on one another',
    );

    // B and C have actual edits on this path, including B's already committed change.
    await openWorkspace();
    const overlap = workspace().locator('.file-overlaps');
    await overlap.getByText(/File overlap/).click();
    await overlap.getByRole('button', { name: 'Refresh file overlap' }).click();
    await expect(overlap).toContainText('sum.mjs');
    await overlap.getByRole('button', { name: 'Verification · Verification task' }).click();
    await expect(page.getByRole('heading', { name: 'Verification', exact: true })).toBeVisible();
    await expect(workspace().locator('.file-overlaps')).toContainText('sum.mjs');
    await pick('Implementation');
    await openWorkspace();
    const delivery = workspace().getByRole('region', { name: 'Deliver this work' });
    await delivery.getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('.task-node[data-delivery="Waiting on CI"]')).toHaveCount(1);

    // The PR base moves while C retains its independent edit.
    await writeFile(join(contributor, 'sum.mjs'), change('a + b + 1'));
    await git(contributor, 'add', 'sum.mjs');
    await git(contributor, 'commit', '-qm', 'Change the same file on the PR base');
    await git(contributor, 'push', '-q', 'origin', 'main');
    const baseHead = await git(contributor, 'rev-parse', 'HEAD');
    await expect(git(b.worktree, 'cat-file', '-e', baseHead)).rejects.toThrow();
    const trackingBefore = await git(b.worktree, 'rev-parse', 'origin/main');
    await writePr('DIRTY', 'pending');
    await delivery.getByRole('button', { name: 'Check again' }).click();
    const cue = page.locator('.task-node[data-delivery="PR has conflicts"]');
    await expect(cue).toHaveCount(1);
    await expect(
      page.locator('.attention').getByRole('button', { name: /PR #17 · PR has conflicts/ }),
    ).toBeVisible();
    await cue.focus();
    await page.keyboard.press('Enter');
    await expect(delivery.getByRole('button', { name: 'Update from base…' })).toBeVisible();
    await delivery.getByRole('button', { name: 'Update from base…' }).click();
    const baseReview = delivery.getByRole('region', { name: 'Review base update' });
    await expect(baseReview).toContainText(baseHead.slice(0, 12));
    await git(b.worktree, 'cat-file', '-e', baseHead);
    expect(await git(b.worktree, 'rev-parse', 'origin/main')).toBe(trackingBefore);
    await expect(baseReview).toContainText('sum.mjs');
    const stale = await call('workspace/basePreview', { ...bScope, remote: 'origin', number: 17 });
    await writeFile(join(b.worktree, 'unrelated.local'), 'Keep this untracked edit.\n');
    const refused = await call('workspace/baseApply', { ...bScope, preview: stale });
    expect(refused.status).toBe('rejected');
    expect(refused.error.message).toContain('local changes');
    expect(await readFile(join(b.worktree, 'unrelated.local'), 'utf8')).toBe(
      'Keep this untracked edit.\n',
    );
    await rm(join(b.worktree, 'unrelated.local'));

    await baseReview.getByRole('button', { name: 'Apply base update' }).click();
    const basePanel = delivery.getByRole('region', { name: 'Pull request base update' });
    await expect(basePanel.getByText('Base update in progress')).toBeVisible();
    await expect(basePanel.getByRole('button', { name: 'Stage resolution' })).toBeVisible();
    await page.setViewportSize({ width: 820, height: 700 });
    expect(await basePanel.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
    const a11y = await new AxeBuilder({ page }).include('.base-update').analyze();
    expect(a11y.violations).toEqual([]);
    await basePanel.screenshot({ path: testInfo.outputPath('conflict-review.png') });
    await page.setViewportSize({ width: 1440, height: 990 });

    await basePanel.getByRole('button', { name: 'Stage resolution' }).click();
    await expect(basePanel.getByRole('alert')).toContainText('Remove conflict markers');
    expect(await git(b.worktree, 'rev-parse', 'HEAD')).toBe(initialDelivery.head);
    // The unrelated session can continue while Git preserves B's merge in progress.
    await turn(c.sessionId, 'Continue verification while the other task is blocked');
    expect((await row(c.sessionId)).state.turns).toHaveLength(2);
    expect(await readFile(join(c.worktree, 'sum.mjs'), 'utf8')).toBe(change('a * b'));

    await basePanel.getByRole('button', { name: 'Abort base update…' }).click();
    await basePanel.getByRole('button', { name: 'Abort update', exact: true }).click();
    await expect(basePanel.getByRole('button', { name: 'Update from base…' })).toBeVisible();
    expect(await readFile(join(b.worktree, 'sum.mjs'), 'utf8')).toBe(change('a - b'));
    expect(await git(b.worktree, 'status', '--porcelain')).toBe('');

    await basePanel.getByRole('button', { name: 'Update from base…' }).click();
    await baseReview.getByRole('button', { name: 'Apply base update' }).click();
    await basePanel.getByRole('button', { name: 'Ask Muse to resolve conflicts' }).click();
    const composer = page.getByRole('textbox', { name: 'New task for this session' });
    await expect(composer).toHaveValue(/Resolve the pending PR base update/);
    // The marker makes the controlled provider issue the real Muse shell tool for the fix.
    await composer.fill('STAGE_B_IMPLEMENT\nResolve the pending PR base update in sum.mjs.');
    await page.getByRole('button', { name: 'Start turn', exact: true }).click();
    await expect
      .poll(async () => (await row(b.sessionId)).state.approvals?.[0]?.requested?.approvalId, {
        timeout: 20000,
      })
      .not.toBeUndefined();
    const bRow = await row(b.sessionId);
    const requested = bRow.state.approvals[0].requested;
    const once =
      requested.availableChoices.find(
        (choice: any) => choice.decision === 'approved' && choice.scope === 'once',
      ) ?? requested.availableChoices.find((choice: any) => choice.decision === 'approved');
    await call('decide', {
      sessionId: b.sessionId,
      requirementId: requested.currentRequirementId,
      approvalId: requested.approvalId,
      choiceId: once.choiceId,
    });
    await expect
      .poll(async () => (await row(b.sessionId)).state.turns.at(-1).terminal, { timeout: 25000 })
      .toBe('completed');
    expect(await readFile(join(b.worktree, 'sum.mjs'), 'utf8')).toBe(change('a + b'));
    expect(await readFile(join(c.worktree, 'sum.mjs'), 'utf8')).toBe(change('a * b'));

    await openWorkspace();
    await basePanel.getByRole('button', { name: 'Stage resolution' }).click();
    await basePanel.getByRole('button', { name: 'Review merge commit' }).click();
    await basePanel.getByRole('button', { name: 'Commit base update' }).click();
    await expect(delivery.getByText('Check this base update')).toBeVisible();
    const merged = await call('workspace/delivery', bScope);
    expect(await git(b.worktree, 'show', '-s', '--format=%P')).toBe(
      `${initialDelivery.head} ${baseHead}`,
    );
    await expect(
      call('workspace/push', {
        ...bScope,
        revision: merged.revision,
        head: merged.head,
        remote: 'origin',
      }),
    ).rejects.toThrow('Run fresh passing checks');

    await workspace()
      .getByLabel('Test command')
      .fill(
        'node --input-type=module -e "import {sum} from \'./sum.mjs\'; if(sum(2,3)!==5) process.exit(1)"',
      );
    await workspace().getByLabel('Test command').press('Enter');
    await expect(delivery.getByText('Ready to push', { exact: true })).toBeVisible({
      timeout: 25000,
    });
    await delivery.getByRole('button', { name: 'Push to origin…' }).click();
    await delivery.getByRole('button', { name: 'Push to origin', exact: true }).click();
    await expect
      .poll(() => git(remote, 'rev-parse', initialDelivery.branch), { timeout: 25000 })
      .toBe(merged.head);
    await writePr('CLEAN', 'success');
    await delivery.getByRole('button', { name: 'Check again' }).click();
    await expect(page.locator('.task-node[data-delivery="Ready for review"]')).toHaveCount(1);
    expect(await git(repo, 'rev-parse', 'HEAD')).toBe(originalHead);
    // A clean base update is still a reviewable merge, with no automatic commit.
    await writeFile(join(contributor, 'design.md'), 'An independent base update.\n');
    await git(contributor, 'add', 'design.md');
    await git(contributor, 'commit', '-qm', 'Advance the base without overlap');
    await git(contributor, 'push', '-q', 'origin', 'main');
    await writePr('BEHIND', 'success');
    await delivery.getByRole('button', { name: 'Check again' }).click();
    await basePanel.getByRole('button', { name: 'Update from base…' }).click();
    await baseReview.getByRole('button', { name: 'Apply base update' }).click();
    await expect(basePanel.getByRole('button', { name: 'Review merge commit' })).toBeVisible();
    expect(await git(b.worktree, 'rev-parse', 'HEAD')).toBe(merged.head);
    await basePanel.getByRole('button', { name: 'Abort base update…' }).click();
    await basePanel.getByRole('button', { name: 'Abort update', exact: true }).click();
    await expect(basePanel.getByRole('button', { name: 'Update from base…' })).toBeVisible();
    expect(await git(b.worktree, 'status', '--porcelain')).toBe('');

    expect(await readFile(join(c.worktree, 'sum.mjs'), 'utf8')).toBe(change('a * b'));
    await pool.close();
    await stop();
    daemon = spawn(supervisor, [], { env, stdio: 'ignore' });
    await expect.poll(async () => (await status().catch(() => ({}))).pid).toBe(daemon.pid);
    expect(
      (
        await call('handoff/list', { task: { sessionId: a.sessionId, turnId: a.turnId } })
      ).handoffs.map((item: any) => item.id),
    ).toContain(saved.id);
  } finally {
    await pool.close();
    await stop();
    await model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
