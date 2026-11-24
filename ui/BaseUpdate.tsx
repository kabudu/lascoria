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
  const [error, setError] = useState<{ message: string; path?: string }>();
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
    setError(undefined);
  }, [observation?.head, observation?.baseHead, remote, folderId]);
  if (!pending && !offered && !preview && !loading) return null;

  async function review() {
    setLoading(true);
    setError(undefined);
    try {
      setPreview(
        await request('workspace/basePreview', { ...scope, remote, number: observation.number }),
      );
    } catch (e) {
      setError({ message: String(e) });
    } finally {
      setLoading(false);
    }
  }
  async function apply(operation: string, params: Json) {
    setLoading(true);
    setError(undefined);
    try {
      const result = await mutate(operation, { ...scope, ...params });
      if (result?.status === 'applied') {
        setPreview(undefined);
        setConfirm(undefined);
      } else if (result?.error) {
        setError({ message: result.error.message, path: params.path });
      }
      await refresh();
    } finally {
      setLoading(false);
    }
  }
  const disabled = !ready || loading;
  const conflictCount = pending?.conflicts.length ?? 0;
  const describeError = (message: string) => (
    <p className="base-update-error" role="alert">
      {message}
    </p>
  );
  return (
    <section className="base-update" aria-label="Pull request base update" aria-busy={loading}>
      {pending ? (
        <>
          <header className="base-update-heading" aria-live="polite">
            <p className="eyebrow">Base update</p>
            <h4>{conflictCount ? 'Resolve merge conflicts' : 'Review the merge'}</h4>
            <p className="base-update-revision">
              <strong>{pending.baseBranch}</strong>
              <code>{pending.baseHead.slice(0, 12)}</code>
            </p>
          </header>
          {conflictCount > 0 ? (
            <>
              <p className="muted">
                Resolve each file, then stage it to include the fix in the merge.
              </p>
              <ul className="base-paths" aria-label="Conflicting files">
                {pending.conflicts.map((path: string) => (
                  <li key={path}>
                    <code>{path}</code>
                    <div className="base-file-actions">
                      {openInEditor && (
                        <button
                          className="base-quiet"
                          aria-label={`Open in editor: ${path}`}
                          onClick={() => openInEditor(path)}
                        >
                          Open in editor
                        </button>
                      )}
                      <button
                        disabled={disabled || !!confirm}
                        aria-label={`Stage resolution for ${path}`}
                        onClick={() =>
                          void apply('workspace/baseStage', { revision: pending.revision, path })
                        }
                      >
                        Stage resolution
                      </button>
                    </div>
                    {error?.path === path && describeError(error.message)}
                  </li>
                ))}
              </ul>
              {!confirm && (
                <button
                  className="primary"
                  disabled={loading}
                  onClick={() =>
                    draft(
                      `Resolve the pending PR base update in this task worktree. Review these conflicting files: ${JSON.stringify(pending.conflicts)}. Preserve user changes and report the resolution for review.`,
                    )
                  }
                >
                  Ask Muse to resolve conflicts
                </button>
              )}
            </>
          ) : (
            <>
              {pending.unstaged.length > 0 && (
                <p className="muted">
                  Review and stage the remaining edits in your editor before committing.
                </p>
              )}
              <details>
                <summary>Files in the merge commit ({pending.staged.length})</summary>
                <ul>
                  {pending.staged.map((path: string) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              </details>
              {!confirm && (
                <button
                  className="primary"
                  disabled={disabled || pending.unstaged.length > 0}
                  onClick={() => setConfirm({ kind: 'finish', revision: pending.revision })}
                >
                  Review merge commit
                </button>
              )}
            </>
          )}
          {!confirm && (
            <div className="base-update-actions">
              <button className="base-quiet" disabled={loading} onClick={() => void refresh()}>
                Refresh merge status
              </button>
              <button
                className="base-quiet"
                disabled={disabled}
                onClick={() => {
                  setError(undefined);
                  setConfirm({ kind: 'abort', revision: pending.revision });
                }}
              >
                Abort base update…
              </button>
            </div>
          )}
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
                  ? 'This restores the task branch and discards your conflict-resolution edits.'
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
              {confirm.revision !== pending.revision &&
                describeError('The merge changed. Cancel and review the latest state.')}
              <div className="base-confirm-actions">
                <button
                  disabled={loading}
                  onClick={() => {
                    setError(undefined);
                    setConfirm(undefined);
                  }}
                >
                  Cancel
                </button>
                <button
                  className={confirm.kind === 'abort' ? 'danger' : 'primary'}
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
              </div>
            </section>
          )}
        </>
      ) : preview ? (
        <section className="decision" aria-label="Review base update">
          <h4 ref={heading} tabIndex={-1}>
            Review base update
          </h4>
          <p className="base-update-revision">
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
          <div className="base-confirm-actions">
            <button
              disabled={loading}
              onClick={() => {
                setError(undefined);
                setPreview(undefined);
              }}
            >
              Cancel
            </button>
            <button
              className="primary"
              disabled={disabled}
              onClick={() => void apply('workspace/baseApply', { preview })}
            >
              Apply base update
            </button>
          </div>
        </section>
      ) : (
        <button className="primary" disabled={disabled} onClick={() => void review()}>
          {loading ? 'Checking the base…' : 'Update from base…'}
        </button>
      )}
      {error && !error.path && describeError(error.message)}
    </section>
  );
}
