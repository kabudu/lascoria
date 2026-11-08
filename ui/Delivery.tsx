import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { request } from './api';
import type { Json } from './types';

/** The next delivery step for one isolated worktree, derived only from supervisor state. */
export type StepAction =
  | 'runTests'
  | 'chooseTest'
  | 'askFix'
  | 'stageAll'
  | 'commit'
  | 'push'
  | 'pullRequest'
  | 'openPullRequest'
  | 'checkRemote';
export interface Step {
  kind: string;
  headline: string;
  detail?: string;
  action?: StepAction;
  label?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function testSummary(validation: Json): string {
  const run = validation?.run;
  const command = run?.command ? `\`${run.command}\`` : 'The test command';
  switch (validation?.state) {
    case 'passed':
      return `${command} passed on these exact files.`;
    case 'failed':
      return `${command} failed on these exact files.`;
    case 'stale':
      return `${command} ${run.outcome} earlier, but the files have changed since.`;
    case 'unverified':
      return `${command} ${run.outcome ?? 'ran'}, but files changed while it ran or it predates file tracking. Run it again to check these files.`;
    case 'running':
      return `${command} is running.`;
    case 'incomplete':
      return `${command} did not finish (${run.outcome ?? 'interrupted'}).`;
    default:
      return 'No test has run on these files.';
  }
}

/** Whether the reviewed commit is on the remote branch, as of the last check or push. */
export function pushed(d: Json) {
  return d.remoteBranch?.checked
    ? d.remoteBranch.head === d.head
    : d.trackingHead === d.head && d.trackingHead !== null;
}

/** The open pull request: from the last GitHub check, else the last pull-request command. */
export function openPullRequest(d: Json) {
  if (d.pullRequest?.checked) return d.pullRequest.open?.[0] ?? null;
  const last = d.last?.pullRequest;
  return last?.status === 'applied' ? (last.result?.pullRequest ?? null) : null;
}

export function deliveryStep(d: Json): Step {
  const last = [d.last?.push, d.last?.pullRequest].filter(Boolean);
  const sending = last.find((c: Json) => c.status === 'running');
  if (d.changes.conflicts)
    return {
      kind: 'conflicts',
      headline: 'Resolve merge conflicts first',
      detail: `${plural(d.changes.conflicts, 'file')} with conflicts. Resolve them with your Git client; delivery is paused.`,
    };
  if (sending)
    return {
      kind: 'sending',
      headline:
        sending === d.last.push ? `Pushing to ${d.remote?.name}…` : 'Opening the pull request…',
    };
  const latest = last.sort((a: Json, b: Json) => b.createdAtMillis - a.createdAtMillis)[0];
  if (latest?.status === 'outcomeUnknown' && !d.remoteBranch?.checked)
    return {
      kind: 'unknown',
      headline: 'Lascoria could not confirm the last delivery step',
      detail: latest.error?.message ?? 'Check the remote before trying again.',
      action: 'checkRemote',
      label: 'Check the remote',
    };
  if (d.validation.state === 'running')
    return { kind: 'testing', headline: testSummary(d.validation) };
  if (!d.clean) {
    if (d.validation.state === 'failed')
      return {
        kind: 'failed',
        headline: 'Tests fail on these changes',
        detail: testSummary(d.validation),
        action: 'askFix',
        label: 'Ask Muse to fix the failure',
      };
    if (d.validation.state !== 'passed')
      return {
        kind: 'check',
        headline: 'Check these changes',
        detail: testSummary(d.validation),
        ...(d.validation.run?.command
          ? { action: 'runTests' as const, label: `Run ${d.validation.run.command}` }
          : { action: 'chooseTest' as const, label: 'Choose a test command' }),
      };
    if (!d.changes.staged)
      return {
        kind: 'stage',
        headline: 'Ready to commit',
        detail: `${testSummary(d.validation)} Stage everything, or choose files and hunks below.`,
        action: 'stageAll',
        label: 'Stage all changes',
      };
    return {
      kind: 'commit',
      headline: 'Ready to commit',
      detail:
        d.changes.unstaged || d.changes.untracked
          ? `${testSummary(d.validation)} Only staged changes are committed; the test ran on every file, including what stays unstaged.`
          : testSummary(d.validation),
      action: 'commit',
      label: 'Commit staged changes…',
    };
  }
  if (!d.branchCommits.total) return { kind: 'empty', headline: 'No changes to deliver yet' };
  if (!d.remote)
    return d.remotes.length
      ? {
          kind: 'chooseRemote',
          headline: 'Choose where to push',
          detail: 'This repository has several remotes. Choose one under Destination.',
        }
      : {
          kind: 'noRemote',
          headline: 'Committed on this task branch',
          detail: 'This repository has no remote. Add one with your Git client to push from here.',
        };
  const remote = d.remoteBranch;
  if (remote?.checked && remote.head && remote.head !== d.head && (!remote.known || remote.behind))
    return {
      kind: 'diverged',
      headline: `${d.branch} on ${d.remote.name} has commits this branch does not have`,
      detail: 'Nothing will be pushed over them. Reconcile them with your Git client.',
    };
  if (!pushed(d))
    return {
      kind: 'push',
      headline: 'Ready to push',
      detail: `${plural(d.outgoing.total, 'commit')} to send to ${d.remote.name}. ${testSummary(d.validation)}`,
      action: 'push',
      label: `Push to ${d.remote.name}…`,
    };
  const pr = openPullRequest(d);
  if (pr)
    return {
      kind: 'delivered',
      headline: `Pull request #${pr.number} is open`,
      detail: pr.title,
      action: 'openPullRequest',
      label: 'Open pull request',
    };
  if (d.hosting?.kind !== 'github')
    return {
      kind: 'pushedElsewhere',
      headline: `Pushed to ${d.remote.name}`,
      detail: `Open a pull request on ${d.hosting?.host ?? 'your Git host'}.`,
    };
  if (!d.hosting.cli)
    return {
      kind: 'noCli',
      headline: `Pushed to ${d.remote.name}`,
      detail:
        'To open pull requests here, install the GitHub CLI (gh) and sign in with gh auth login.',
    };
  return {
    kind: 'pullRequest',
    headline: 'Pushed. Ready for review',
    detail: `${plural(d.branchCommits.total, 'commit')} on ${d.branch}.`,
    action: 'pullRequest',
    label: 'Open a pull request…',
  };
}

function Commits({ list }: { list: Json }) {
  return (
    <ol className="delivery-commits">
      {list.commits.map((c: Json) => (
        <li key={c.sha}>
          <code>{c.sha.slice(0, 7)}</code> {c.subject}
        </li>
      ))}
      {list.total > list.commits.length && <li>and {list.total - list.commits.length} more</li>}
    </ol>
  );
}

/**
 * Review to delivery for one isolated worktree: one contextual next step, with the facts it
 * depends on beneath. Every action names the revision the user reviewed; push and pull
 * requests show the destination, branch and outgoing commits before anything leaves.
 */
export function Delivery({
  sessionId,
  folderId,
  ready,
  busy,
  commands,
  version,
  mutate,
  changed,
  runTests,
  chooseTest,
  askFix,
  openCommit,
}: {
  sessionId: string;
  folderId?: string;
  ready: boolean;
  busy: boolean;
  commands: Json[];
  version: number;
  mutate: (operation: string, params: Json) => Promise<Json>;
  changed: () => void;
  runTests: (command: string) => void;
  chooseTest: () => void;
  askFix: (run: Json) => void;
  openCommit: () => void;
}) {
  const [d, setD] = useState<Json>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<'push' | 'pullRequest' | null>(null);
  const [remoteName, setRemoteName] = useState<string>();
  const [pr, setPr] = useState({ title: '', body: '', base: '', draft: true });
  const generation = useRef(0);
  const scope = folderId ? { folderId } : {};
  const params = { sessionId, ...scope, ...(remoteName ? { remote: remoteName } : {}) };

  async function load(checkRemote: boolean) {
    const current = ++generation.current;
    setLoading(true);
    try {
      const value = await request('workspace/delivery', { ...params, checkRemote });
      if (current !== generation.current) return;
      setD(value);
      setError('');
    } catch (e) {
      if (current === generation.current) setError(String(e));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  // Refresh when the files or delivery commands of this session change; ask the remote again
  // only when a push or pull request just finished.
  const mine = commands.filter(
    (c) =>
      c.sessionId === sessionId &&
      (c.params?.folderId ?? undefined) === folderId &&
      String(c.operation).startsWith('workspace/'),
  );
  const watch = mine.map((c) => `${c.id}:${c.status}`).join('|');
  const deliveryWatch = mine
    .filter((c) => ['workspace/push', 'workspace/pullRequest'].includes(c.operation))
    .map((c) => `${c.id}:${c.status}`)
    .join('|');
  const first = useRef(true);
  useEffect(() => {
    first.current = true;
    setConfirm(null);
    setD(null);
  }, [sessionId, folderId]);
  useEffect(() => {
    void load(first.current);
    first.current = false;
  }, [sessionId, folderId, remoteName, version, watch, ready]);
  useEffect(() => {
    if (deliveryWatch && !first.current) void load(true);
  }, [deliveryWatch]);

  if (!d)
    return (
      <section className="delivery" aria-labelledby="delivery-heading" aria-busy={loading}>
        <h3 id="delivery-heading">Deliver this work</h3>
        {error ? <p role="alert">{error}</p> : <p role="status">Checking this task branch…</p>}
      </section>
    );

  const step = deliveryStep(d);
  const latest = [d.last?.push, d.last?.pullRequest]
    .filter(Boolean)
    .sort((a: Json, b: Json) => b.createdAtMillis - a.createdAtMillis)[0];
  const refused = latest?.status === 'rejected' ? latest.error?.message : '';
  // Adding a failure to the task draft, checking the remote and opening a link never wait.
  const needsIdle = ['runTests', 'stageAll', 'commit', 'push', 'pullRequest'];
  const blocked = needsIdle.includes(step.action ?? '') && (!ready || busy);
  const openPr = openPullRequest(d);

  async function act() {
    setError('');
    switch (step.action) {
      case 'runTests':
        return runTests(d.validation.run.command);
      case 'chooseTest':
        return chooseTest();
      case 'askFix':
        return askFix(d.validation.run);
      case 'commit':
        return openCommit();
      case 'checkRemote':
        return load(true);
      case 'openPullRequest':
        return invoke('open_pull_request', { url: openPr.url }).catch((e) => setError(String(e)));
      case 'push':
        // Review against what the remote holds now; the push checks again before sending.
        await load(true);
        return setConfirm('push');
      case 'pullRequest':
        setPr({
          title: d.suggestedTitle ?? '',
          body: '',
          base: d.suggestedBase ?? '',
          draft: true,
        });
        return setConfirm('pullRequest');
      case 'stageAll': {
        // Stage what the staging view shows now, bound to its revision.
        const view = await request('workspace/changes', { sessionId, ...scope });
        const files = [...view.unstaged.map((f: Json) => f.path), ...view.untracked];
        const result = await mutate('workspace/stage', {
          sessionId,
          ...scope,
          revision: view.revision,
          action: 'stage',
          files,
          hunks: [],
        });
        if (result?.status === 'rejected') setError(result.error?.message ?? 'Nothing was staged.');
        changed();
      }
    }
  }

  async function send(operation: 'workspace/push' | 'workspace/pullRequest', extra: Json = {}) {
    const result = await mutate(operation, {
      sessionId,
      ...scope,
      revision: d.revision,
      head: d.head,
      remote: d.remote.name,
      ...extra,
    });
    if (result) setConfirm(null);
  }

  return (
    <section className="delivery" aria-labelledby="delivery-heading" aria-busy={loading}>
      <div className="staging-toolbar">
        <h3 id="delivery-heading">Deliver this work</h3>
        <button onClick={() => void load(true)} disabled={loading}>
          Check again
        </button>
      </div>
      <div className={`delivery-step step-${step.kind}`} role="status" aria-live="polite">
        <strong>{step.headline}</strong>
        {step.detail && <p>{step.detail}</p>}
      </div>
      {error && <p role="alert">{error}</p>}
      {refused && !confirm && <p role="alert">{refused}</p>}
      {step.action && !confirm && (
        <div className="row">
          <button className="primary" disabled={blocked} onClick={() => void act()}>
            {step.label}
          </button>
        </div>
      )}
      {blocked && !busy && (
        <small>Wait for a current, idle Muse session and any running test command.</small>
      )}
      {confirm === 'push' && (
        <form
          className="decision"
          aria-labelledby="push-heading"
          onSubmit={(e) => {
            e.preventDefault();
            void send('workspace/push');
          }}
        >
          <h4 id="push-heading">
            Push {plural(d.outgoing.total, 'commit')} to {d.remote.name}?
          </h4>
          <dl className="delivery-facts">
            <dt>Destination</dt>
            <dd>
              <code>{d.remote.url}</code>
            </dd>
            <dt>Branch</dt>
            <dd>
              <code>{d.branch}</code>
              {d.remoteBranch?.checked
                ? d.remoteBranch.head
                  ? ' (updates the existing branch)'
                  : ' (new branch)'
                : ' (not checked yet; checked again before pushing)'}
            </dd>
            <dt>Commit</dt>
            <dd>
              <code>{d.head.slice(0, 12)}</code>
            </dd>
          </dl>
          <Commits list={d.outgoing} />
          <p className="muted">
            Uses your own Git sign-in. Never force-pushes; repository hooks are not run. Uncommitted
            changes stay in this worktree.
          </p>
          <div className="row">
            <button className="primary" disabled={!ready || busy}>
              Push to {d.remote.name}
            </button>
            <button type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {confirm === 'pullRequest' && (
        <form
          className="decision"
          aria-labelledby="pr-heading"
          onSubmit={(e) => {
            e.preventDefault();
            void send('workspace/pullRequest', pr);
          }}
        >
          <h4 id="pr-heading">Open a pull request on {d.hosting.repository}?</h4>
          <dl className="delivery-facts">
            <dt>From</dt>
            <dd>
              <code>{d.branch}</code> at <code>{d.head.slice(0, 12)}</code>
            </dd>
          </dl>
          <label>
            Into branch
            <input
              required
              maxLength={250}
              value={pr.base}
              onChange={(e) => setPr({ ...pr, base: e.target.value })}
            />
          </label>
          <label>
            Title
            <input
              required
              maxLength={256}
              value={pr.title}
              onChange={(e) => setPr({ ...pr, title: e.target.value })}
            />
          </label>
          <label>
            Description
            <textarea
              maxLength={16000}
              rows={4}
              value={pr.body}
              onChange={(e) => setPr({ ...pr, body: e.target.value })}
            />
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={pr.draft}
              onChange={(e) => setPr({ ...pr, draft: e.target.checked })}
            />
            Open as a draft
          </label>
          <Commits list={d.branchCommits} />
          <p className="muted">
            Uses your GitHub CLI sign-in. If a pull request from this branch is already open,
            Lascoria shows it instead of opening another.
          </p>
          <div className="row">
            <button
              className="primary"
              disabled={!ready || busy || !pr.title.trim() || !pr.base.trim()}
            >
              Open pull request
            </button>
            <button type="button" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <details className="delivery-details">
        <summary>Details</summary>
        <dl className="delivery-facts">
          <dt>Changes</dt>
          <dd>
            {d.clean
              ? 'None uncommitted'
              : [
                  d.changes.staged && `${d.changes.staged} staged`,
                  d.changes.unstaged && `${d.changes.unstaged} not staged`,
                  d.changes.untracked && `${d.changes.untracked} new`,
                ]
                  .filter(Boolean)
                  .join(', ')}
          </dd>
          <dt>Tests</dt>
          <dd>{testSummary(d.validation)}</dd>
          <dt>Commits</dt>
          <dd>
            {plural(d.branchCommits.total, 'commit')} on <code>{d.branch}</code>
            {d.remote && `, ${d.outgoing.total} not on ${d.remote.name}`}
          </dd>
          {openPr && (
            <>
              <dt>Pull request</dt>
              <dd>
                <code>{openPr.url}</code>
              </dd>
            </>
          )}
          <dt>Destination</dt>
          <dd>
            {d.remotes.length > 1 ? (
              <label>
                Remote
                <select
                  value={d.remote?.name ?? ''}
                  onChange={(e) => setRemoteName(e.target.value || undefined)}
                >
                  {!d.remote && <option value="">Choose a remote</option>}
                  {d.remotes.map((r: Json) => (
                    <option key={r.name} value={r.name}>
                      {r.name} ({r.host})
                    </option>
                  ))}
                </select>
              </label>
            ) : d.remote ? (
              <>
                {d.remote.name} · <code>{d.remote.url}</code>
              </>
            ) : (
              'No remote'
            )}
            {d.remoteBranch?.error && <small role="alert">{d.remoteBranch.error}</small>}
            {d.pullRequest?.error && <small role="alert">{d.pullRequest.error}</small>}
          </dd>
        </dl>
      </details>
    </section>
  );
}
