import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Json } from './types';

export interface TaskRef {
  sessionId: string;
  turnId: string;
  folderId?: string;
}
export interface HandoffTarget extends TaskRef {
  label: string;
}
export interface HandoffLink {
  id: string;
  source: TaskRef;
  target: TaskRef;
}
type EvidenceChoice = 'decision' | 'test' | 'diff';

export const taskKey = (task: TaskRef) => `${task.sessionId}:${task.turnId}`;
export const taskRef = (task: TaskRef) => ({
  sessionId: task.sessionId,
  turnId: task.turnId,
  ...(task.folderId ? { folderId: task.folderId } : {}),
});

function draftText(evidence: Json) {
  const quote = evidence.body
    .split('\n')
    .map((line: string) => '> ' + line)
    .join('\n');
  return `\n\nTask handoff (source revision ${evidence.revision}):\n${quote}`;
}

export function TaskHandoffs({
  source,
  targets,
  reveal,
  append,
  changed,
}: {
  source: TaskRef;
  targets: HandoffTarget[];
  reveal?: boolean;
  append: (task: TaskRef, value: string) => void;
  changed: () => void;
}) {
  const [open, setOpen] = useState(Boolean(reveal));
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<EvidenceChoice>('decision');
  const [note, setNote] = useState('');
  const [capture, setCapture] = useState('');
  const [artifacts, setArtifacts] = useState<Json[]>([]);
  const [handoffs, setHandoffs] = useState<Json[]>([]);
  const [review, setReview] = useState<Json>();
  const [inspected, setInspected] = useState<Json>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const ref = useRef<HTMLDetailsElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = taskKey(source);
  const selected = targets.find((item) => taskKey(item) === target);
  const label = (ref: TaskRef) =>
    targets.find((item) => taskKey(item) === taskKey(ref))?.label ?? ref.turnId.slice(-8);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [reveal]);
  useEffect(() => {
    if (review || inspected) heading.current?.focus();
  }, [review, inspected]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void request<{ handoffs: Json[] }>('handoff/list', { task: taskRef(source) })
      .then((value) => {
        if (!cancelled) setHandoffs(value.handoffs);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, current]);
  useEffect(() => {
    if (!open || kind !== 'diff') return;
    let cancelled = false;
    void request('review/list', { sessionId: source.sessionId })
      .then((value) => {
        if (!cancelled)
          setArtifacts(
            value.artifacts.filter(
              (item: Json) =>
                item.taskId === source.turnId && (item.folder?.id ?? undefined) === source.folderId,
            ),
          );
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, source.sessionId, source.turnId, source.folderId]);

  async function perform(action: () => Promise<void>) {
    setError('');
    setLoading(true);
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  const mine = handoffs.filter((link) =>
    [link.source, link.target].some((end) => taskKey(end) === current),
  );
  return (
    <details
      ref={ref}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="task-handoffs"
    >
      <summary>Task handoffs{mine.length ? ` (${mine.length})` : ''}</summary>
      {mine.length > 0 && (
        <ul className="handoff-list" aria-label="Saved task handoffs" role="list">
          {mine.map((link) => {
            const incoming = taskKey(link.target) === current;
            return (
              <li key={link.id}>
                <span className="handoff-endpoint">
                  <span>{incoming ? 'From' : 'To'}</span>
                  <strong>{label(incoming ? link.source : link.target)}</strong>
                </span>
                <button
                  className="coordination-action"
                  disabled={loading}
                  onClick={() =>
                    void perform(async () =>
                      setInspected(await request('handoff/check', { handoffId: link.id })),
                    )
                  }
                >
                  Review handoff
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {inspected && (
        <section className="handoff-review" aria-label="Saved handoff">
          <h4 ref={heading} tabIndex={-1}>
            Saved handoff
          </h4>
          <p className={`handoff-status ${inspected.current ? 'current' : 'stale'}`} role="status">
            {inspected.current
              ? 'Source revision verified'
              : 'Source changed or is unavailable. Review and share fresh evidence.'}
          </p>
          <pre>{draftText(inspected.handoff.evidence).trimStart()}</pre>
          <div className="handoff-actions">
            <button disabled={loading} onClick={() => setInspected(undefined)}>
              Close handoff
            </button>
            {inspected.current && (
              <button
                className="primary"
                disabled={loading}
                onClick={() =>
                  void perform(async () => {
                    const checked: Json = await request('handoff/check', {
                      handoffId: inspected.handoff.id,
                    });
                    setInspected(checked);
                    if (!checked.current) return;
                    append(checked.handoff.target, draftText(checked.handoff.evidence));
                  })
                }
              >
                Add to receiving draft
              </button>
            )}
          </div>
        </section>
      )}
      {review ? (
        <section className="handoff-review" aria-label="Preview handoff">
          <h4 ref={heading} tabIndex={-1}>
            Review handoff to {selected?.label}
          </h4>
          <pre>{draftText(review.evidence).trimStart()}</pre>
          {review.evidence.truncated && <p>This is the first 4,000 bytes of the captured diff.</p>}
          <div className="handoff-actions">
            <button disabled={loading} onClick={() => setReview(undefined)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={loading}
              onClick={() =>
                void perform(async () => {
                  const saved = await request('handoff/save', review.params, review.id);
                  setHandoffs((previous) => [
                    saved,
                    ...previous.filter((link) => link.id !== saved.id),
                  ]);
                  setReview(undefined);
                  changed();
                })
              }
            >
              Save handoff
            </button>
          </div>
        </section>
      ) : (
        targets.some((item) => item.sessionId !== source.sessionId) && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!selected) return;
              void perform(async () => {
                const params = {
                  source: taskRef(source),
                  target: taskRef(selected),
                  selection:
                    kind === 'decision'
                      ? { kind, note }
                      : kind === 'diff'
                        ? { kind, id: capture }
                        : { kind },
                };
                const evidence = await request('handoff/preview', params);
                setReview({ id: crypto.randomUUID(), evidence, params: { ...params, evidence } });
              });
            }}
          >
            <label>
              Receiving task
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose a task</option>
                {targets
                  .filter((item) => item.sessionId !== source.sessionId)
                  .map((item) => (
                    <option key={taskKey(item)} value={taskKey(item)}>
                      {item.label}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Evidence to share
              <select value={kind} onChange={(e) => setKind(e.target.value as EvidenceChoice)}>
                <option value="decision">Decision note</option>
                <option value="test">Latest verified test result in this folder</option>
                <option value="diff">Captured diff excerpt</option>
              </select>
            </label>
            {kind === 'decision' && (
              <label>
                Decision note
                <textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
              </label>
            )}
            {kind === 'diff' && (
              <label>
                Captured diff
                <select value={capture} onChange={(e) => setCapture(e.target.value)}>
                  <option value="">Choose a capture</option>
                  {artifacts.map((item) => (
                    <option key={item.id} value={item.id}>
                      {String(item.head).slice(0, 12)} ·{' '}
                      {new Date(item.capturedAtMillis).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              disabled={
                loading ||
                !selected ||
                (kind === 'decision' && !note.trim()) ||
                (kind === 'diff' && !capture)
              }
            >
              Preview handoff
            </button>
          </form>
        )
      )}
      {error && (
        <p className="base-update-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}

export interface FileOverlap {
  path: string;
  owners: Array<{ sessionId: string; folderId?: string | null; turnId?: string | null }>;
}
export interface OverlapScan {
  matches: FileOverlap[];
  incomplete: boolean;
  observedAtMillis?: number;
}

export function FileOverlaps({
  sessionId,
  folderId,
  scan,
  targets,
  reveal,
  jump,
  refresh,
}: {
  sessionId: string;
  folderId?: string;
  scan?: OverlapScan;
  targets: HandoffTarget[];
  reveal?: boolean;
  jump: (target: TaskRef) => void;
  refresh: () => void;
}) {
  const mine =
    scan?.matches.filter((item) =>
      item.owners.some(
        (owner) => owner.sessionId === sessionId && (owner.folderId ?? undefined) === folderId,
      ),
    ) ?? [];
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (reveal && ref.current) {
      ref.current.open = true;
      ref.current.scrollIntoView({ block: 'nearest' });
    }
  }, [reveal]);
  return (
    <details className="file-overlaps" ref={ref}>
      <summary>File overlap{mine.length ? ` (${mine.length})` : ''}</summary>
      {!scan?.observedAtMillis ? (
        <p className="muted">No current overlap observation. Refresh to compare open worktrees.</p>
      ) : (
        <p className="muted">
          {mine.length
            ? 'These paths also changed in another task worktree.'
            : 'No overlapping changes observed.'}{' '}
          As of {new Date(scan.observedAtMillis).toLocaleTimeString()}.
        </p>
      )}
      {scan?.incomplete && <p className="muted">Some open worktrees could not be compared.</p>}
      {mine.length > 0 && (
        <ul className="overlap-list" aria-label="Overlapping files" role="list">
          {mine.map((item) => (
            <li key={item.path}>
              <code>{item.path}</code>
              <ul>
                {item.owners
                  .filter((owner) => owner.sessionId !== sessionId)
                  .map((owner) => {
                    const target = targets.find(
                      (task) => task.sessionId === owner.sessionId && task.turnId === owner.turnId,
                    );
                    return (
                      <li key={`${owner.sessionId}:${owner.folderId ?? ''}`}>
                        {target ? (
                          <button
                            className="coordination-action"
                            onClick={() =>
                              jump({ ...target, folderId: owner.folderId ?? undefined })
                            }
                          >
                            {target.label}
                          </button>
                        ) : (
                          <span>Another open worktree</span>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </li>
          ))}
        </ul>
      )}
      <button className="coordination-action" onClick={refresh}>
        Refresh file overlap
      </button>
    </details>
  );
}
