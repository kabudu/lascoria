import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Json, SessionRow } from './types';

export function Workspace({
  session,
  commands,
  busy,
  mutate,
  attach,
}: {
  session: SessionRow;
  commands: Json[];
  busy: boolean;
  mutate: (operation: string, params: Json) => Promise<Json>;
  attach: (text: string) => void;
}) {
  const [preview, setPreview] = useState<Json>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  const [file, setFile] = useState<Json>(null);
  const [confirmation, setConfirmation] = useState('');
  const [action, setAction] = useState<'commit' | 'discard' | 'archive' | null>(null);
  const generation = useRef(0);
  const runs = commands.filter(
    (c) => c.sessionId === session.id && c.operation === 'workspace/run',
  );
  const running = runs.some((c) => c.status === 'running');
  const archived = session.lifecycle === 'archived';
  const removed = session.workspaceDiscarded === true;
  const canArchive = !busy && !running && (!session.state.current || !session.state.activeTurnId);
  const ready =
    session.state.current && !session.state.activeTurnId && !running && !busy && !archived;
  const canDiscard = !busy && !running && (ready || archived);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(false);
    setPreview(null);
    setFile(null);
    setAction(null);
    setError('');
    const timer = setTimeout(() => {
      void request('workspace/files', { sessionId: session.id, query })
        .then((r) => {
          if (generation.current === current) setPaths(r.paths);
        })
        .catch((e) => {
          if (generation.current === current) setError(String(e));
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [session.id, query]);
  async function inspect() {
    setLoading(true);
    setError('');
    const current = generation.current;
    try {
      const value = await request('workspace/inspect', { sessionId: session.id });
      if (current === generation.current) setPreview(value);
    } catch (e) {
      if (current === generation.current) setError(String(e));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  return (
    <div className="developer-workspace">
      <section>
        <span className="eyebrow">Task workspace</span>
        <h3>{session.managedWorkspace?.branch ?? 'Existing checkout'}</h3>
        <code className="workspace-path">{session.workspace}</code>
        <p className="muted">
          {session.managedWorkspace
            ? 'Isolated from your original checkout. Commits stay on this task branch.'
            : 'Muse works directly in this checkout. Isolate a new task to enable commit and discard controls.'}
        </p>
        {archived && <p role="status">Archived. History is retained; execution is disabled.</p>}
        {error && <p role="alert">{error}</p>}
        <button onClick={() => void inspect()} disabled={loading || busy || removed}>
          Refresh change preview
        </button>
        {preview && (
          <>
            <p>
              <strong>{preview.branch || 'Detached HEAD'}</strong> · {preview.head?.slice(0, 12)}
            </p>
            <details open>
              <summary>Tracked changes</summary>
              <pre>{preview.patch || 'No tracked changes.'}</pre>
            </details>
            <details>
              <summary>New files ({preview.untracked?.length ?? 0})</summary>
              {preview.untracked?.map((f: Json) => (
                <details key={f.path}>
                  <summary>{f.path}</summary>
                  <pre>{f.text ?? 'Binary content'}</pre>
                </details>
              ))}
            </details>
            <small>
              Content fingerprint {preview.fingerprint?.slice(0, 16)}. Mutations recheck this
              preview.
            </small>
          </>
        )}
      </section>
      {removed && (
        <p>The worktree was removed. Committed history is retained on the task branch.</p>
      )}
      {!removed && (
        <section>
          <h3>Repository context</h3>
          <label>
            Find a file
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter repository paths"
            />
          </label>
          <div className="repository-files">
            {paths.map((path) => (
              <button
                key={path}
                onClick={async () => {
                  const current = generation.current;
                  try {
                    const value = await request('workspace/file', { sessionId: session.id, path });
                    if (current === generation.current) setFile(value);
                  } catch (e) {
                    if (current === generation.current) setError(String(e));
                  }
                }}
              >
                {path}
              </button>
            ))}
          </div>
          <small>
            Up to 200 Git-visible files. Filter to narrow the list; ignored files are excluded.
          </small>
          {file && (
            <details open>
              <summary>{file.path}</summary>
              <pre>{file.text}</pre>
              <button
                disabled={busy || archived}
                onClick={() => attach(`\nRepository context: ${file.path}\n\n${file.text}\n`)}
              >
                Add file to task draft
              </button>
            </details>
          )}
        </section>
      )}
      <section>
        <h3>Run tests</h3>
        <p className="muted">
          Runs directly as your macOS user in this checkout, outside Muse's sandbox. No interactive
          stdin. Deadline: 120 seconds; output: 64 KiB per stream.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const command = String(new FormData(e.currentTarget).get('command'));
            await mutate('workspace/run', { sessionId: session.id, command });
            setPreview(null);
          }}
        >
          <label>
            Test command
            <input name="command" required maxLength={4000} placeholder="npm test" />
          </label>
          <button className="primary" disabled={!ready}>
            Run command
          </button>
        </form>
        {!ready && !archived && (
          <small>Wait for a current, idle Muse session and any running test command.</small>
        )}
        {runs.map((run) => (
          <details key={run.id} open={run.status === 'running'}>
            <summary>
              {run.result?.outcome ?? run.status} · {run.params.command}
            </summary>
            <p>Exit: {run.result?.exitCode ?? 'unavailable'} · developer-executed</p>
            <p className="muted">
              Content {run.result?.fingerprint?.slice(0, 20) ?? 'unavailable'} ·{' '}
              {preview && run.result?.contentUnchanged === true
                ? preview.fingerprint === run.result.fingerprint
                  ? 'Matches this change preview'
                  : 'Different from this change preview'
                : 'Refresh the change preview to compare'}
            </p>
            <p className="muted">
              {run.result?.contentUnchanged === true
                ? 'Captured content was unchanged across execution. This is not a hermetic test environment.'
                : 'Content association is unverified or changed during execution.'}
            </p>
            <pre>{run.result?.stdout}</pre>
            <pre>{run.result?.stderr}</pre>
            {(run.error || run.result?.error) && (
              <pre>{JSON.stringify(run.error ?? run.result.error)}</pre>
            )}
          </details>
        ))}
      </section>
      {(!archived || (session.managedWorkspace && !removed)) && (
        <section>
          <h3>Finish task</h3>
          <div className="row">
            <button
              disabled={!ready || !preview || !session.managedWorkspace}
              onClick={() => setAction('commit')}
            >
              Commit changes…
            </button>
            <button disabled={!canArchive || archived} onClick={() => setAction('archive')}>
              Archive session…
            </button>
            <button
              className="danger"
              disabled={!canDiscard || !preview || !session.managedWorkspace}
              onClick={() => {
                setAction('discard');
                setConfirmation('');
              }}
            >
              Discard worktree…
            </button>
          </div>
          {action === 'commit' && (
            <form
              className="decision"
              onSubmit={async (e) => {
                e.preventDefault();
                const message = String(new FormData(e.currentTarget).get('message'));
                const r = await mutate('workspace/commit', {
                  sessionId: session.id,
                  fingerprint: preview.fingerprint,
                  message,
                });
                if (r?.status === 'applied') {
                  setAction(null);
                  await inspect();
                }
              }}
            >
              <h4>Commit all Git-visible changes</h4>
              <p>
                Stages tracked changes and non-ignored new files on this isolated branch. Hooks and
                signing are disabled for this bounded operation. Nothing is pushed.
              </p>
              <label>
                Commit message
                <input name="message" required maxLength={4000} />
              </label>
              <button disabled={!ready}>Commit changes</button>
              <button type="button" onClick={() => setAction(null)}>
                Cancel
              </button>
            </form>
          )}
          {action === 'archive' && (
            <div className="decision">
              <h4>Archive this session?</h4>
              <p>
                Stops its Muse host and frees an active session slot. Keeps history, evidence,
                worktree and commits. Archived sessions are read-only.
              </p>
              <button
                disabled={!canArchive}
                onClick={async () => {
                  const r = await mutate('session/archive', { sessionId: session.id });
                  if (r?.status === 'applied') setAction(null);
                }}
              >
                Archive session
              </button>
              <button onClick={() => setAction(null)}>Keep session</button>
            </div>
          )}
          {action === 'discard' && (
            <div className="decision">
              <h4>Discard this isolated worktree?</h4>
              <p>
                Archives the session and permanently removes uncommitted files, including ignored
                files, from {session.workspace}. Committed history stays on{' '}
                {session.managedWorkspace?.branch}. The original checkout is retained.
              </p>
              <label>
                Type session ID to confirm: <code>{session.id}</code>
                <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
              </label>
              <button
                className="danger"
                disabled={!canDiscard || confirmation !== session.id}
                onClick={async () => {
                  const r = await mutate('workspace/discard', {
                    sessionId: session.id,
                    fingerprint: preview.fingerprint,
                    confirmation,
                  });
                  if (r?.status === 'applied') {
                    setAction(null);
                    setPreview(null);
                  }
                }}
              >
                Discard worktree
              </button>
              <button onClick={() => setAction(null)}>Keep worktree</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
