import { useEffect, useState } from 'react';
import { request } from './api';
import type { SessionRow } from './types';

type Folder = { id: string; name: string; path: string };
type Project = { id: string; name: string; revision: number; folders: Folder[] };

/** What changed between the folders this session uses and the saved Project. */
export function folderChanges(applied: Folder[], saved: Folder[]) {
  const before = new Map(applied.map((f) => [f.id, f]));
  const after = new Map(saved.map((f) => [f.id, f]));
  const added = saved.filter((f) => !before.has(f.id)).map((f) => f.name);
  const removed = applied.filter((f) => !after.has(f.id)).map((f) => f.name);
  const kept = saved.filter((f) => before.has(f.id));
  const renamed = kept.filter((f) => before.get(f.id)!.name !== f.name).map((f) => f.name);
  const moved = kept.filter((f) => before.get(f.id)!.path !== f.path).map((f) => f.name);
  const order = applied.filter((f) => after.has(f.id)).map((f) => f.id);
  const reordered = kept.some((f, i) => order[i] !== f.id);
  return {
    added,
    removed,
    renamed,
    moved,
    reordered,
    defaultChanged: applied[0]?.path !== saved[0]?.path,
  };
}

/**
 * Offers a saved Project's newer folders for the next task of an existing session. Reading the
 * saved Project is local and read-only; nothing changes until the user starts a task with the
 * box ticked, and the supervisor revalidates the exact revision then.
 */
export function ProjectUpdate({
  session,
  busy,
  chosen,
  choose,
}: {
  session: SessionRow;
  busy: boolean;
  chosen: number | undefined;
  choose: (revision: number | undefined) => void;
}) {
  const [saved, setSaved] = useState<Project | null>(null);
  const applied = session.projectContext;
  const appliedRevision = applied?.revision ?? 0;
  useEffect(() => {
    if (!applied) return;
    let cancelled = false;
    const load = () =>
      void request<{ projects: Project[] }>('project/list').then(
        (result) => {
          if (!cancelled) setSaved(result.projects.find((p) => p.id === applied.id) ?? null);
        },
        () => {
          // The offer is optional; an unavailable list just leaves the session as it is.
          if (!cancelled) setSaved(null);
        },
      );
    load();
    // Saved Projects change only through explicit edits; recheck when the window regains focus.
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
    };
  }, [applied?.id, appliedRevision, session.id]);
  // A choice for a revision that is no longer current is dropped rather than sent.
  useEffect(() => {
    if (chosen !== undefined && (!saved || saved.revision !== chosen)) choose(undefined);
  }, [saved?.revision, chosen]);
  const pending = session.projectContextPending;
  if (!applied || !saved || saved.revision <= appliedRevision) {
    return pending?.status === 'outcomeUnknown' ? (
      <p className="project-update muted" role="status">
        The last Project folder change may not have reached Muse.
      </p>
    ) : null;
  }
  const change = folderChanges(applied.folders, saved.folders);
  const parts = [
    change.added.length && `added ${change.added.join(', ')}`,
    change.removed.length && `removed ${change.removed.join(', ')}`,
    change.moved.length && `new location for ${change.moved.join(', ')}`,
    change.renamed.length && `renamed ${change.renamed.join(', ')}`,
    change.reordered && 'new order',
  ].filter(Boolean);
  const active = Boolean(session.state.activeTurnId);
  return (
    <div className="project-update" role="group" aria-label="Project folder changes">
      <p>
        <strong>{saved.name}</strong> changed since this session’s folders were set
        {parts.length ? `: ${parts.join('; ')}` : ''}.
      </p>
      {pending?.status === 'outcomeUnknown' && pending.revision === saved.revision && (
        <p className="muted">
          The last attempt may not have reached Muse. The folders shown above are the last confirmed
          ones; applying again is safe.
        </p>
      )}
      {change.defaultChanged ? (
        <p className="muted">
          The default folder changed, so these folders can only be used by a new session.
        </p>
      ) : (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={chosen === saved.revision}
            disabled={busy || active}
            onChange={(event) => choose(event.target.checked ? saved.revision : undefined)}
          />
          Use the updated folders for this task
          {active ? ' (available after the current task)' : ''}
        </label>
      )}
    </div>
  );
}
