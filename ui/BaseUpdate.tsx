import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Json } from './types';

export function BaseUpdate({
  sessionId,
  folderId,
  remote,
  observation,
  pending,
  ready,
  mutate,
  refresh,
  openInEditor,
  draft,
}: {
  sessionId: string;
  folderId?: string;
  remote?: string;
  observation: Json;
  pending: Json;
  ready: boolean;
  mutate: (operation: string, params: Json) => Promise<Json>;
  refresh: () => Promise<void>;
  openInEditor?: (path: string) => void;
  draft: (text: string) => void;
}) {
  const [preview, setPreview] = useState<Json>();
  const [confirm, setConfirm] = useState<{ kind: 'abort' | 'finish'; revision: string }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const scope = { sessionId, ...(folderId ? { folderId } : {}) };
  const offered =
    observation?.state === 'OPEN' &&
    observation.baseHead &&
    ['BEHIND', 'DIRTY'].includes(observation.mergeState);
  useEffect(() => {
    if (preview || confirm) heading.current?.focus();
  }, [preview, confirm]);
  useEffect(() => {
    setPreview(undefined);
    setConfirm(undefined);
    setError('');
  }, [observation?.head, observation?.baseHead, remote, folderId]);
  if (!pending && !offered && !preview && !loading) return null;

  async function review() {
    setLoading(true);
    setError('');
    try {
      setPreview(
        await request('workspace/basePreview', { ...scope, remote, number: observation.number }),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  async function apply(operation: string, params: Json) {
    setLoading(true);
    setError('');
    try {
      const result = await mutate(operation, { ...scope, ...params });
      if (result?.status === 'applied') {
        setPreview(undefined);
        setConfirm(undefined);
      } else if (result?.error) {
        setError(result.error.message);
      }
      await refresh();
    } finally {
      setLoading(false);
    }
  }
  const disabled = !ready || loading;
  return (
    <section className="base-update" aria-label="Pull request base update" aria-busy={loading}>
      {pending ? (
        <>
          <h4>Base update in progress</h4>
          {!pending.owned ? (
            <p>Finish the pending merge with your Git client.</p>
          ) : (
            <>
              <p className="muted">
                {pending.baseBranch} · {pending.baseHead.slice(0, 12)}
              </p>
              {pending.conflicts.length ? (
                <>
                  <p>Resolve the files below, then stage each resolution.</p>
                  <ul className="base-paths">
                    {pending.conflicts.map((path: string) => (
                      <li key={path}>
                        <code>{path}</code>
                        {openInEditor && (
                          <button onClick={() => openInEditor(path)}>Open in editor</button>
                        )}
                        <button
                          disabled={disabled}
                          onClick={() =>
                            void apply('workspace/baseStage', { revision: pending.revision, path })
                          }
                        >
                          Stage resolution
                        </button>
                      </li>
                    ))}
                  </ul>
                  <button
                    disabled={loading}
                    onClick={() =>
                      draft(
                        `Resolve the pending PR base update in this task worktree. Review these conflicting files: ${JSON.stringify(pending.conflicts)}. Preserve user changes and report the resolution for review.`,
                      )
                    }
                  >
                    Ask Muse to resolve conflicts
                  </button>
                </>
              ) : (
                <>
                  {pending.unstaged.length > 0 && (
                    <p>
                      Review remaining unstaged edits in your editor before completing this update.
                    </p>
                  )}
                  <details>
                    <summary>Files in the proposed merge commit ({pending.staged.length})</summary>
                    <ul>
                      {pending.staged.map((path: string) => (
                        <li key={path}>
                          <code>{path}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <button
                    disabled={disabled || pending.unstaged.length > 0}
                    onClick={() => setConfirm({ kind: 'finish', revision: pending.revision })}
                  >
                    Review merge commit
                  </button>
                </>
              )}
              <div className="row">
                <button disabled={loading} onClick={() => void refresh()}>
                  Refresh merge status
                </button>
                <button
                  disabled={disabled}
                  onClick={() => setConfirm({ kind: 'abort', revision: pending.revision })}
                >
                  Abort base update…
                </button>
              </div>
              {confirm && (
                <section
                  className="decision"
                  aria-label={confirm.kind === 'abort' ? 'Confirm abort' : 'Confirm merge commit'}
                >
                  <h4 ref={heading} tabIndex={-1}>
                    {confirm.kind === 'abort' ? 'Abort this update?' : 'Commit this base update?'}
                  </h4>
                  <p>
                    {confirm.kind === 'abort'
                      ? 'Git will restore the task branch to its pre-update state and discard edits made to resolve this merge.'
                      : 'The reviewed changes will be committed to this task branch. Run fresh checks before pushing.'}
                  </p>
                  {confirm.kind === 'finish' && (
                    <details>
                      <summary>Staged diff</summary>
                      {pending.stagedPatch === null ? (
                        <p>The diff exceeds this preview. Inspect it with your Git client.</p>
                      ) : (
                        <pre>{pending.stagedPatch || 'No staged file changes.'}</pre>
                      )}
                    </details>
                  )}
                  {confirm.revision !== pending.revision && (
                    <p role="alert">The merge changed. Cancel and review the latest state.</p>
                  )}
                  <button disabled={loading} onClick={() => setConfirm(undefined)}>
                    Cancel
                  </button>
                  <button
                    disabled={disabled || confirm.revision !== pending.revision}
                    onClick={() =>
                      void apply(
                        confirm.kind === 'abort' ? 'workspace/baseAbort' : 'workspace/baseFinish',
                        { revision: confirm.revision },
                      )
                    }
                  >
                    {confirm.kind === 'abort' ? 'Abort update' : 'Commit base update'}
                  </button>
                </section>
              )}
            </>
          )}
        </>
      ) : preview ? (
        <section className="decision" aria-label="Review base update">
          <h4 ref={heading} tabIndex={-1}>
            Review base update
          </h4>
          <p>
            {preview.repository} · {preview.baseBranch} ·{' '}
            <code>{preview.baseHead.slice(0, 12)}</code>
          </p>
          <p>
            Apply to this task branch. The update stays open for review before committing or
            pushing.
          </p>
          <details open>
            <summary>Incoming paths ({preview.paths.length})</summary>
            <ul>
              {preview.paths.map((path: string) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          </details>
          <details>
            <summary>Incoming commits{preview.moreCommits ? ' (first 20)' : ''}</summary>
            <ul>
              {preview.commits.map((commit: string) => (
                <li key={commit}>{commit}</li>
              ))}
            </ul>
          </details>
          <button disabled={loading} onClick={() => setPreview(undefined)}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={disabled}
            onClick={() => void apply('workspace/baseApply', { preview })}
          >
            Apply base update
          </button>
        </section>
      ) : (
        <button className="primary" disabled={disabled} onClick={() => void review()}>
          {loading ? 'Checking the base…' : 'Update from base…'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
