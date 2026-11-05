import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Json } from './types';

type Side = 'staged' | 'unstaged';
type Change = {
  path: string;
  change: string;
  wholeOnly: string | null;
  hunks: { id: string; text: string }[];
};

const label: Record<string, string> = {
  modified: 'Modified',
  added: 'New',
  deleted: 'Deleted',
  binary: 'Binary',
  untracked: 'New',
};

/** Selection keys: a whole file, or one hunk of a file. */
const fileKey = (path: string) => `f\u0000${path}`;
const hunkKey = (path: string, id: string) => `h\u0000${path}\u0000${id}`;

function Diff({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <pre className="staging-diff">
      {lines.map((line, index) => (
        <span
          key={index}
          className={
            index === 0
              ? 'diff-header'
              : line.startsWith('+')
                ? 'diff-add'
                : line.startsWith('-')
                  ? 'diff-remove'
                  : undefined
          }
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/**
 * Selective staging for one isolated worktree (one Project folder at a time). Every action
 * names the revision of the view it was chosen from; the supervisor refuses anything that
 * changed since, so a stale or repeated click never stages something the user did not see.
 */
export function Staging({
  sessionId,
  folderId,
  isolated,
  ready,
  busy,
  mutate,
}: {
  sessionId: string;
  folderId?: string;
  isolated: boolean;
  ready: boolean;
  busy: boolean;
  mutate: (operation: string, params: Json) => Promise<Json>;
}) {
  const [changes, setChanges] = useState<Json>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Record<Side, Set<string>>>({
    staged: new Set(),
    unstaged: new Set(),
  });
  const [committing, setCommitting] = useState(false);
  const [message, setMessage] = useState('');
  const generation = useRef(0);
  const scope = folderId ? { folderId } : {};

  async function load(keepSelection = false) {
    const current = ++generation.current;
    setLoading(true);
    try {
      const value = await request('workspace/changes', { sessionId, ...scope });
      if (current !== generation.current) return;
      setChanges(value);
      setError('');
      // Keep only selections that still name something in the refreshed view.
      setSelected((previous) => {
        if (!keepSelection) return { staged: new Set(), unstaged: new Set() };
        const valid = (side: Side) => {
          const keys = new Set<string>();
          for (const f of value[side] as Change[]) {
            keys.add(fileKey(f.path));
            for (const h of f.hunks) keys.add(hunkKey(f.path, h.id));
          }
          if (side === 'unstaged') for (const p of value.untracked) keys.add(fileKey(p));
          return new Set([...previous[side]].filter((k) => keys.has(k)));
        };
        return { staged: valid('staged'), unstaged: valid('unstaged') };
      });
    } catch (e) {
      if (current === generation.current) {
        setChanges(null);
        setError(String(e));
      }
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    setChanges(null);
    setCommitting(false);
    setSelected({ staged: new Set(), unstaged: new Set() });
    if (isolated) void load();
    else generation.current++;
  }, [sessionId, folderId, isolated]);

  if (!isolated)
    return (
      <section aria-labelledby="staging-heading">
        <h3 id="staging-heading">Stage and commit</h3>
        <p className="muted">
          Staging and commits are available in isolated task worktrees. Muse works directly in this
          checkout, so use your own Git client here.
        </p>
      </section>
    );

  const toggle = (side: Side, key: string) =>
    setSelected((previous) => {
      const next = new Set(previous[side]);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...previous, [side]: next };
    });

  async function act(side: Side, keys: string[]) {
    const files: string[] = [];
    const hunks: { path: string; id: string }[] = [];
    for (const key of keys) {
      const [kind, path, id] = key.split('\u0000');
      if (kind === 'f') files.push(path);
      else hunks.push({ path, id });
    }
    const result = await mutate('workspace/stage', {
      sessionId,
      ...scope,
      revision: changes.revision,
      action: side === 'unstaged' ? 'stage' : 'unstage',
      files,
      hunks,
    });
    // Whatever happened, show the index as it is now.
    await load(result?.status !== 'applied');
    if (result?.status === 'rejected') setError(result.error?.message ?? 'Nothing was changed.');
    else if (result && result.status !== 'applied')
      setError('The outcome is unknown. The view below shows the index as it is now.');
  }

  const conflicts: string[] = changes?.conflicts ?? [];
  const staged: Change[] = changes?.staged ?? [];
  const unstaged: Change[] = [
    ...(changes?.unstaged ?? []),
    ...(changes?.untracked ?? []).map((path: string) => ({
      path,
      change: 'untracked',
      wholeOnly: 'New files are staged whole',
      hunks: [],
    })),
  ];
  const disabled = !ready || busy || loading;

  function list(side: Side, items: Change[]) {
    const verb = side === 'unstaged' ? 'Stage' : 'Unstage';
    const chosen = selected[side];
    return (
      <div className="staging-side" role="group" aria-labelledby={`staging-${side}`}>
        <div className="staging-toolbar">
          <h4 id={`staging-${side}`}>
            {side === 'staged' ? 'Staged' : 'Not staged'} ({items.length})
          </h4>
          <button
            disabled={disabled || chosen.size === 0}
            onClick={() => void act(side, [...chosen])}
          >
            {verb} selected{chosen.size ? ` (${chosen.size})` : ''}
          </button>
          {side === 'unstaged' && (
            <button
              disabled={disabled || items.length === 0}
              onClick={() =>
                void act(
                  side,
                  items.map((f) => fileKey(f.path)),
                )
              }
            >
              Stage all
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className="muted">
            {side === 'staged' ? 'Nothing staged yet.' : 'No unstaged changes.'}
          </p>
        ) : (
          <ul className="staging-files">
            {items.map((f) => {
              const whole = chosen.has(fileKey(f.path));
              return (
                <li key={f.path}>
                  <label className="staging-file">
                    <input
                      type="checkbox"
                      checked={whole}
                      disabled={disabled}
                      onChange={() => toggle(side, fileKey(f.path))}
                      aria-label={`${verb} all of ${f.path}`}
                    />
                    <span className="staging-path">{f.path}</span>
                    <span className="staging-badge">{label[f.change] ?? f.change}</span>
                  </label>
                  {f.wholeOnly && <small className="muted">{f.wholeOnly}.</small>}
                  {f.hunks.length > 0 && (
                    <details>
                      <summary>
                        {f.hunks.length} hunk{f.hunks.length === 1 ? '' : 's'} in {f.path}
                      </summary>
                      {f.hunks.map((h, index) => (
                        <div className="staging-hunk" key={h.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={whole || chosen.has(hunkKey(f.path, h.id))}
                              disabled={disabled || whole}
                              onChange={() => toggle(side, hunkKey(f.path, h.id))}
                            />
                            {verb} hunk {index + 1} of {f.path}
                          </label>
                          <Diff text={h.text} />
                        </div>
                      ))}
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return (
    <section aria-labelledby="staging-heading" className="staging" aria-busy={loading}>
      <div className="staging-toolbar">
        <h3 id="staging-heading">Stage and commit</h3>
        <button onClick={() => void load(true)} disabled={loading}>
          Refresh changes
        </button>
      </div>
      <p className="muted">
        Choose whole files or individual hunks. A commit records only what is staged; everything
        else stays in this worktree. Renames appear as a removed and a new file.
      </p>
      {loading && <p role="status">Loading changes…</p>}
      {error && <p role="alert">{error}</p>}
      {busy && changes && <p role="status">Applying the change…</p>}
      {!ready && !busy && changes && (
        <small>Wait for a current, idle Muse session and any running test command to stage.</small>
      )}
      {changes && conflicts.length > 0 && (
        <p role="alert">
          {conflicts.length} file{conflicts.length === 1 ? ' has' : 's have'} merge conflicts (
          {conflicts.join(', ')}). Resolve them with your Git client; staging here is paused.
        </p>
      )}
      {changes && conflicts.length === 0 && (
        <>
          {list('unstaged', unstaged)}
          {list('staged', staged)}
          <div className="row">
            <button
              className="primary"
              disabled={disabled || staged.length === 0}
              onClick={() => {
                setCommitting(true);
                setMessage('');
              }}
            >
              Commit staged changes…
            </button>
          </div>
          {committing && (
            <form
              className="decision"
              aria-labelledby="commit-staged-heading"
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await mutate('workspace/commit', {
                  sessionId,
                  ...scope,
                  revision: changes.revision,
                  message,
                });
                if (result?.status === 'applied') setCommitting(false);
                await load();
                if (result?.status === 'rejected')
                  setError(result.error?.message ?? 'Nothing was committed.');
                else if (result && result.status !== 'applied')
                  setError(
                    'The commit outcome is unknown. Check the task branch before committing again.',
                  );
              }}
            >
              <h4 id="commit-staged-heading">
                Commit {staged.length} staged file{staged.length === 1 ? '' : 's'}
              </h4>
              <p>
                Records exactly the content below on {changes.branch}. Unstaged edits and new files
                stay in the worktree. Hooks and commit signing are not run. Nothing is pushed.
              </p>
              <ul className="staging-commit-files">
                {staged.map((f) => (
                  <li key={f.path}>
                    {label[f.change] ?? f.change}: {f.path}
                  </li>
                ))}
              </ul>
              <details open>
                <summary>Exact commit content</summary>
                <pre className="staging-diff">{changes.stagedPatch}</pre>
              </details>
              <label>
                Commit message
                <input
                  name="message"
                  required
                  maxLength={4000}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                />
              </label>
              <div className="row">
                <button className="primary" disabled={disabled || !message.trim()}>
                  Commit staged changes
                </button>
                <button type="button" onClick={() => setCommitting(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
