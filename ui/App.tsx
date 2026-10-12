import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { FormEvent } from 'react';
import { connect, request } from './api';
import { tasks, attention, questionAnswers } from './model';
import type { Status, SessionRow, Task, Prefs, Artifact, Evidence, Item, Json } from './types';
const empty: Status = { pid: 0, sessions: [], commands: [] };
const text = (value: Json) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const short = (value: string) => value.slice(-8);
export function App() {
  const [status, setStatus] = useState<Status>(empty),
    [prefs, setPrefs] = useState<Prefs>({ theme: 'light', view: 'map' });
  const [connected, setConnected] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<'start' | 'stop' | 'palette' | null>(null),
    [tab, setTab] = useState('transcript');
  const [review, setReview] = useState<{
    artifacts: Artifact[];
    evidence: Evidence[];
    nextOffset?: number | null;
    totalEvidence?: number;
  }>({
    artifacts: [],
    evidence: [],
  });
  const [artifactId, setArtifactId] = useState(''),
    [fresh, setFresh] = useState<{ fresh: boolean; checkedAtMillis: number } | null>(null);
  const [history, setHistory] = useState<Item[] | null>(null),
    [offset, setOffset] = useState(0),
    [total, setTotal] = useState(0);
  const revision = useRef(0),
    loaded = useRef(false),
    dirty = useRef(false),
    modalRef = useRef<HTMLDialogElement>(null),
    mapRef = useRef<HTMLDivElement>(null);
  const latestPrefs = useRef(prefs);

  const pendingPrefs = useRef<{ id: string; params: Json } | null>(null);
  const saving = useRef<Promise<void> | null>(null);
  const mutationPending = useRef(false);
  const lastCommand = useRef<{ id: string; operation: string; params: Json } | null>(null);
  const session = status.sessions.find((s) => s.id === prefs.sessionId) ?? status.sessions[0];
  const selectedSession = useRef<string | undefined>(session?.id);
  selectedSession.current = session?.id;
  const nodes = session ? tasks(session, prefs) : [];
  const task = nodes.find((t) => t.id === prefs.selection) ?? nodes[0];
  const selectedTask = useRef(task?.id);
  selectedTask.current = task?.id;
  const queue = attention(status, prefs);
  const candidate =
    review.artifacts.find((a) => a.id === artifactId) ??
    review.artifacts.filter((a) => a.taskId === task?.turnId).at(-1);
  const [capturedArtifact, setCapturedArtifact] = useState<Artifact>();
  const artifact = capturedArtifact?.id === candidate?.id ? capturedArtifact : undefined;
  useEffect(() => {
    let alive = true;
    setCapturedArtifact(undefined);
    if (candidate && session)
      void request<Artifact>('artifact/read', { sessionId: session.id, artifactId: candidate.id })
        .then((value) => {
          if (alive) setCapturedArtifact(value);
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    return () => {
      alive = false;
    };
  }, [candidate?.id, session?.id]);
  useEffect(() => {
    let alive = true;
    if (candidate && session) {
      setReview((previous) => ({ ...previous, evidence: [], nextOffset: null }));
      void request('review/list', { sessionId: session.id, artifactId: candidate.id })
        .then((value) => {
          if (alive) setReview(value);
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    }
    return () => {
      alive = false;
    };
  }, [candidate?.id, session?.id]);
  const available = connected && !!session?.state.current && session.lifecycle === 'connected';
  async function refresh() {
    const value = await request<Status>('status');
    setStatus(value);
    setConnected(true);
    return value;
  }
  async function boot() {
    try {
      setStatus(await connect());
      setConnected(true);
      const saved = await request('presentation/get');
      revision.current = saved.revision;
      if (dirty.current) {
        throw new Error('Unsaved layout retained. Save it before reconnecting.');
      }
      latestPrefs.current = { theme: 'light', view: 'map', ...saved.value };
      setPrefs(latestPrefs.current);
      loaded.current = true;
      setError('');
    } catch (e) {
      setError(String(e));
      setConnected(false);
    }
  }
  useEffect(() => {
    void boot();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!cancelled) {
          const value = await request<Status>('status');
          if (!cancelled) {
            setStatus(value);
            setConnected(true);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setConnected(false);
          setError(`Disconnected: ${String(e)}`);
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, 1000);
      }
    };
    timer = setTimeout(poll, 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  function updatePrefs(patch: Partial<Prefs>) {
    dirty.current = true;
    const previous = latestPrefs.current;
    const next = {
      ...previous,
      ...patch,
      selection:
        patch.sessionId && patch.selection === undefined
          ? previous.selections?.[patch.sessionId]
          : (patch.selection ?? previous.selection),
      selections:
        patch.selection && patch.sessionId
          ? { ...previous.selections, [patch.sessionId]: patch.selection }
          : previous.selections,
    };
    latestPrefs.current = next;
    setPrefs(next);
  }

  async function flushPrefs() {
    if (saving.current) return saving.current;
    saving.current = (async () => {
      while (loaded.current && dirty.current) {
        dirty.current = false;
        try {
          pendingPrefs.current ??= {
            id: crypto.randomUUID(),
            params: { expectedRevision: revision.current, value: latestPrefs.current },
          };
          const pending = pendingPrefs.current;
          const saved = await request('presentation/save', pending.params, pending.id);
          pendingPrefs.current = null;
          if (pending.params.value !== latestPrefs.current) dirty.current = true;
          revision.current = saved.revision;
        } catch (error) {
          dirty.current = true;
          throw error;
        }
      }
    })();
    try {
      await saving.current;
    } finally {
      saving.current = null;
    }
  }
  useEffect(() => {
    if (!loaded.current || !dirty.current) return;
    const timer = setTimeout(() => {
      void flushPrefs().catch((e) => setError(`Layout was not saved: ${String(e)}`));
    }, 600);
    return () => clearTimeout(timer);
  }, [prefs]);
  useEffect(() => {
    // Native window close flushes presentation only; execution belongs to the supervisor.
    if (!(window as any).__TAURI_INTERNALS__?.metadata) return;
    let disposed = false;
    let unlisten: undefined | (() => void);
    void getCurrentWindow()
      .onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await flushPrefs();
          await getCurrentWindow().destroy();
        } catch (e) {
          setError(`Close paused because layout could not be saved: ${String(e)}`);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = prefs.theme ?? 'light';
  }, [prefs.theme]);
  useEffect(() => {
    if (modal) modalRef.current?.showModal();
    else modalRef.current?.close();
  }, [modal]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setModal('palette');
      }
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (mapRef.current && prefs.viewport) {
      mapRef.current.scrollLeft = prefs.viewport.x;
      mapRef.current.scrollTop = prefs.viewport.y;
    }
  }, [prefs.view, session?.id]);
  async function loadReview() {
    if (!session) return;
    const value = await request('review/list', {
      sessionId: session.id,
      ...(candidate ? { artifactId: candidate.id } : {}),
    });
    if (selectedSession.current === session.id) setReview(value);
  }
  useEffect(() => {
    setArtifactId('');
    setFresh(null);
    setReview({ artifacts: [], evidence: [] });
    let alive = true;
    if (session)
      void request('review/list', { sessionId: session.id })
        .then((value) => {
          if (alive) setReview(value);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    return () => {
      alive = false;
    };
  }, [session?.id, task?.id]);
  useEffect(() => {
    let alive = true;
    setFresh(null);
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      if (!artifact || !session) return;
      try {
        const value = await request('artifact/check', {
          sessionId: session.id,
          artifactId: artifact.id,
        });
        if (alive) setFresh(value);
      } catch (e) {
        if (alive) {
          setFresh(null);
          setError(String(e));
        }
      } finally {
        if (alive) timer = setTimeout(check, 3000);
      }
    };
    if (tab === 'diff' || tab === 'evidence') void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [artifact?.id, session?.id, tab]);
  useEffect(() => {
    setHistory(null);
    setOffset(0);
    setTotal(session?.state.totalItems ?? 0);
  }, [task?.id]);
  async function mutate(operation: string, params: Json) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    setError('');
    const id = crypto.randomUUID();
    lastCommand.current = { id, operation, params };
    try {
      const result = await request(operation, params, id);
      setNotice(`${operation}: ${result.status ?? 'saved'} · request ${id}`);
      if (operation !== 'stop') await refresh();
      if (operation === 'turn' && result.result?.turnId)
        updatePrefs({
          selection: `${params.sessionId}:${result.result.turnId}`,
          sessionId: params.sessionId,
        });
      return result;
    } catch (e) {
      setError(
        `${String(e)} Request ${id}. Inspect the journal before repeating an uncertain action.`,
      );
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }
  function select(node: Task) {
    updatePrefs({ selection: node.id, sessionId: node.sessionId });
    setTab('transcript');
  }
  async function page() {
    if (!session) return;
    const taskId = task?.id;
    const sessionId = session.id;
    try {
      const value = await request('transcript', {
        sessionId: session.id,
        ...(task?.childSessionId ? { childSessionId: task.childSessionId } : {}),
        offset,
      });
      if (selectedTask.current !== taskId || selectedSession.current !== sessionId) return;
      setHistory(value.items);
      setTotal(value.totalItems);
      setOffset(value.nextOffset ?? 0);
    } catch (e) {
      setError(String(e));
    }
  }
  const items = (history ?? (task?.childSessionId ? [] : (session?.state.items ?? []))).filter(
    (i) => task?.childSessionId || !task?.turnId || i.turnId === task.turnId,
  );
  const visible = nodes.filter(
    (n) =>
      (!prefs.collapsed?.includes(n.id) || n.id === task?.id) &&
      n.label.toLowerCase().includes((prefs.search ?? '').toLowerCase()),
  );
  const position = (node: Task, index: number) =>
    prefs.positions?.[node.id] ?? {
      x: 40 + (index % 3) * 260,
      y: 40 + Math.floor(index / 3) * 154,
    };
  async function capture() {
    if (!session || !task?.turnId) return;
    const value = await mutate('artifact/capture', { sessionId: session.id, taskId: task.turnId });
    if (value) {
      await loadReview();
      setArtifactId(value.id);
      setTab('diff');
    }
  }
  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="#workspace">
          <span className="mark">✳</span> CONSTELLATION <span className="edition">WORKSPACE</span>
        </a>
        <div className="top-actions">
          <span className={`connection ${connected ? 'live' : ''}`}>
            {connected ? 'Supervisor connected' : 'Disconnected'}
          </span>
          <button onClick={() => setModal('palette')} aria-label="Open command palette">
            ⌘ K
          </button>
          <button
            onClick={() => updatePrefs({ theme: prefs.theme === 'light' ? 'dark' : 'light' })}
          >
            {prefs.theme === 'light' ? 'Dark' : 'Light'}
          </button>
          <button onClick={() => setModal('stop')}>Quit &amp; stop</button>
        </div>
      </header>
      <aside className="sidebar">
        <div className="section-heading">
          <h2>Sessions</h2>
          <button onClick={() => setModal('start')} aria-label="Start a session">
            ＋
          </button>
        </div>
        <nav aria-label="Sessions">
          {status.sessions.map((s) => (
            <button
              key={s.id}
              className={`session-card ${session?.id === s.id ? 'selected' : ''}`}
              onClick={() => updatePrefs({ sessionId: s.id, selection: undefined })}
            >
              <span className="eyebrow">{s.workspace.split('/').at(-1)}</span>
              <strong>{short(s.id)}</strong>
              <span>
                {s.state.current ? (s.state.activeTurnId ? 'Running' : 'Idle') : s.lifecycle} ·{' '}
                {queue.filter((q) => q.sessionId === s.id).length} attention
              </span>
            </button>
          ))}
        </nav>
        <section className="attention" aria-labelledby="attention-heading">
          <div className="section-heading">
            <h2 id="attention-heading">Attention</h2>
            <span className="count">{queue.length}</span>
          </div>
          {queue.length === 0 ? (
            <p className="muted">Nothing needs attention.</p>
          ) : (
            queue.map((entry) => (
              <button
                key={entry.id}
                className="attention-row"
                onClick={() => {
                  updatePrefs({ sessionId: entry.sessionId, selection: entry.target });
                  setTab(entry.kind === 'review' ? 'diff' : 'transcript');
                }}
              >
                <span className={`attention-icon ${entry.kind}`}>
                  {entry.kind === 'approval'
                    ? '!'
                    : entry.kind === 'question'
                      ? '?'
                      : entry.kind === 'review'
                        ? '↗'
                        : '×'}
                </span>
                <span>
                  <small>
                    {entry.kind} · {short(entry.sessionId)}
                  </small>
                  <strong>{entry.label}</strong>
                </span>
              </button>
            ))
          )}
        </section>
        <div className="sidebar-foot">
          LOCAL EXECUTION
          <br />
          <span>Muse 1.4.6 · Rust control plane</span>
        </div>
      </aside>
      <main id="workspace">
        <div className="workspace-title">
          <div>
            <p className="eyebrow">{session?.workspace ?? 'YOUR LOCAL WORKSPACE'}</p>
            <h1>{session?.workspace.split('/').at(-1) ?? 'Bring your work into view.'}</h1>
            <p className="muted">Tasks, decisions and the evidence behind a change.</p>
          </div>
          <button className="primary" onClick={() => setModal('start')}>
            New session
          </button>
        </div>
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button onClick={() => void boot()}>Reconnect</button>
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            {notice}
            <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
              ×
            </button>
          </div>
        )}
        {!session ? (
          <section className="empty-state">
            <span className="large-mark">✳</span>
            <h2>One place to follow the work.</h2>
            <p>
              Open an existing Git repository, give Muse a task, and keep its decisions and changes
              in view.
            </p>
            <button className="primary" onClick={() => setModal('start')}>
              Start your first session
            </button>
          </section>
        ) : (
          <>
            {!available && (
              <div className="banner error">
                State is unavailable. Controls are disabled until recovery completes.
                <button
                  disabled={busy}
                  onClick={() => void mutate('resume', { sessionId: session.id })}
                >
                  Recover session
                </button>
              </div>
            )}
            <div className="workspace-grid">
              <section className="task-surface">
                <div className="surface-toolbar">
                  <div className="segmented">
                    <button
                      aria-pressed={prefs.view !== 'list'}
                      onClick={() => updatePrefs({ view: 'map' })}
                    >
                      Task map
                    </button>
                    <button
                      aria-pressed={prefs.view === 'list'}
                      onClick={() => updatePrefs({ view: 'list' })}
                    >
                      List
                    </button>
                  </div>
                  <label className="search">
                    <span>Search tasks</span>
                    <input
                      value={prefs.search ?? ''}
                      onChange={(e) => updatePrefs({ search: e.target.value })}
                      placeholder="Filter tasks…"
                    />
                  </label>
                  <button
                    onClick={() =>
                      updatePrefs({
                        collapsed: nodes.filter((n) => n.status === 'completed').map((n) => n.id),
                      })
                    }
                  >
                    Collapse completed
                  </button>
                  <button onClick={() => updatePrefs({ collapsed: [] })}>Expand</button>
                </div>
                {prefs.view === 'list' ? (
                  <ul className="task-list" aria-label="Task list">
                    {visible.map((node) => (
                      <li key={node.id}>
                        <button aria-current={task?.id === node.id} onClick={() => select(node)}>
                          <span className={`status-dot ${node.status}`} />
                          <strong>{node.label}</strong>
                          <span>{node.status}</span>
                          <small>
                            {node.provenance === 'derived' ? 'Turn grouping' : node.item?.kind} ·{' '}
                            {node.provenance === 'derived'
                              ? 'session owner'
                              : (node.item?.role ?? 'owner unavailable')}
                          </small>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div
                    className="map-scroll"
                    ref={mapRef}
                    onScroll={(e) =>
                      updatePrefs({
                        viewport: { x: e.currentTarget.scrollLeft, y: e.currentTarget.scrollTop },
                      })
                    }
                  >
                    <div
                      className="task-map"
                      style={{ height: Math.max(420, Math.ceil(visible.length / 3) * 154 + 80) }}
                      aria-label="Task map"
                    >
                      <svg className="edges" width="100%" height="100%" aria-hidden="true">
                        {visible.flatMap((node, index) => {
                          const parent = visible.findIndex((n) => n.id === node.parentId);
                          if (parent < 0) return [];
                          const a = position(visible[parent], parent),
                            b = position(node, index);
                          return [
                            <path
                              key={node.id}
                              d={`M ${a.x + 110} ${a.y + 114} L ${b.x + 110} ${b.y}`}
                              className="native-edge"
                            />,
                          ];
                        })}
                        {(prefs.edges ?? []).map((edge) => {
                          const a = visible.findIndex((n) => n.id === edge.from),
                            b = visible.findIndex((n) => n.id === edge.to);
                          if (a < 0 || b < 0) return null;
                          const p = position(visible[a], a),
                            q = position(visible[b], b);
                          return (
                            <g key={edge.id}>
                              <path
                                d={`M ${p.x + 220} ${p.y + 55} L ${q.x} ${q.y + 55}`}
                                className="asserted-edge"
                              />
                              <text x={(p.x + 220 + q.x) / 2} y={(p.y + q.y) / 2 + 45}>
                                {edge.kind} · user
                              </text>
                            </g>
                          );
                        })}
                      </svg>
                      {visible.map((node, index) => {
                        const p = position(node, index);
                        return (
                          <button
                            key={node.id}
                            className={`task-node ${task?.id === node.id ? 'selected' : ''}`}
                            style={{ left: p.x, top: p.y }}
                            onClick={() => select(node)}
                            onKeyDown={(e) => {
                              if (
                                ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)
                              ) {
                                e.preventDefault();
                                const next =
                                  visible[
                                    (index +
                                      (['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1) +
                                      visible.length) %
                                      visible.length
                                  ];
                                select(next);
                                document.getElementById(`node-${next.id}`)?.focus();
                              }
                            }}
                            id={`node-${node.id}`}
                            aria-label={`${node.label}, ${node.status}, ${node.provenance}`}
                          >
                            <small>
                              {node.provenance === 'native' ? node.item?.kind : 'DERIVED TURN TASK'}
                            </small>
                            <strong>{node.label}</strong>
                            <span>
                              <i className={`status-dot ${node.status}`} />
                              {node.status}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="surface-foot">
                  <span>
                    {visible.length} tasks · {nodes.length - visible.length} hidden
                  </span>
                  <span>Solid: native parentage · Dashed: user assertion</span>
                </div>
                {task && (
                  <details className="layout-controls">
                    <summary>Task label, notes and relationships</summary>
                    <label>
                      Task label
                      <input
                        key={task.id + 'label'}
                        value={prefs.labels?.[task.id] ?? task.label}
                        onChange={(e) =>
                          updatePrefs({
                            labels: { ...prefs.labels, [task.id]: e.target.value.slice(0, 200) },
                          })
                        }
                      />
                    </label>
                    <label>
                      Annotation
                      <textarea
                        key={task.id + 'annotation'}
                        value={prefs.annotations?.[task.id] ?? ''}
                        onChange={(e) =>
                          updatePrefs({
                            annotations: {
                              ...prefs.annotations,
                              [task.id]: e.target.value.slice(0, 2000),
                            },
                          })
                        }
                      />
                    </label>
                    <div className="row">
                      <button
                        onClick={() => {
                          const p = position(
                            task,
                            visible.findIndex((n) => n.id === task.id),
                          );
                          updatePrefs({
                            positions: { ...prefs.positions, [task.id]: { x: p.x + 20, y: p.y } },
                          });
                        }}
                      >
                        Pin / move right
                      </button>
                      <button
                        onClick={() => {
                          const p = position(
                            task,
                            visible.findIndex((n) => n.id === task.id),
                          );
                          updatePrefs({
                            positions: { ...prefs.positions, [task.id]: { x: p.x, y: p.y + 20 } },
                          });
                        }}
                      >
                        Move down
                      </button>
                    </div>
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        updatePrefs({
                          edges: [
                            ...(prefs.edges ?? []),
                            {
                              id: crypto.randomUUID(),
                              from: task.id,
                              to: String(data.get('target')),
                              kind: String(data.get('kind')),
                              provenance: 'userAsserted',
                              revision: 1,
                            },
                          ],
                        });
                      }}
                    >
                      <label>
                        Relationship
                        <select name="kind">
                          <option>depends on</option>
                          <option>handed off to</option>
                        </select>
                      </label>
                      <label>
                        Target task
                        <select name="target">
                          {status.sessions
                            .flatMap((s) => tasks(s, prefs))
                            .filter((n) => n.id !== task.id)
                            .map((n) => (
                              <option key={n.id} value={n.id}>
                                {n.label}
                              </option>
                            ))}
                        </select>
                      </label>
                      <button disabled={status.sessions.flatMap((s) => tasks(s, prefs)).length < 2}>
                        Record user assertion
                      </button>
                    </form>
                    <ul>
                      {prefs.edges
                        ?.filter((e) => e.from === task.id)
                        .map((e) => (
                          <li key={e.id}>
                            {e.kind}{' '}
                            {status.sessions
                              .flatMap((s) => tasks(s, prefs))
                              .find((n) => n.id === e.to)?.label ?? e.to}{' '}
                            · user asserted r{e.revision}
                            <button
                              onClick={() =>
                                updatePrefs({ edges: prefs.edges?.filter((v) => v.id !== e.id) })
                              }
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
              </section>
              <section className="inspector" aria-label="Selected task inspector">
                <div className="inspector-heading">
                  <p className="eyebrow">SELECTED TASK</p>
                  <h2>{task?.label ?? 'No tasks yet'}</h2>
                  <p className="muted">
                    {task?.provenance === 'native'
                      ? 'Native Muse item'
                      : 'Derived grouping by native turn ID'}{' '}
                    · {task?.status ?? 'idle'}
                  </p>
                </div>
                {task?.provenance === 'native' &&
                  nodes.some((node) => node.id === session.id + ':' + task.turnId) && (
                    <button
                      onClick={() =>
                        select(nodes.find((node) => node.id === session.id + ':' + task.turnId)!)
                      }
                    >
                      Open owning turn
                    </button>
                  )}
                <div className="tabs" role="tablist">
                  {['transcript', 'diff', 'evidence'].map((name) => (
                    <button
                      key={name}
                      id={`tab-${name}`}
                      aria-controls="inspector-panel"
                      role="tab"
                      aria-selected={tab === name}
                      tabIndex={tab === name ? 0 : -1}
                      onKeyDown={(event) => {
                        const names = ['transcript', 'diff', 'evidence'];
                        const index = names.indexOf(name);
                        const target =
                          event.key === 'ArrowRight'
                            ? names[(index + 1) % 3]
                            : event.key === 'ArrowLeft'
                              ? names[(index + 2) % 3]
                              : event.key === 'Home'
                                ? names[0]
                                : event.key === 'End'
                                  ? names[2]
                                  : undefined;
                        if (target) {
                          event.preventDefault();
                          setTab(target);
                          document.getElementById(`tab-${target}`)?.focus();
                        }
                      }}
                      onClick={() => setTab(name)}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <div
                  className="inspector-body"
                  id="inspector-panel"
                  role="tabpanel"
                  aria-labelledby={`tab-${tab}`}
                >
                  {tab === 'transcript' && (
                    <>
                      {task?.nativeChild && (
                        <section className="decision">
                          <h3>Native workflow child</h3>
                          <pre>{text(task.nativeChild)}</pre>
                          <p className="muted">
                            The runtime supplies this child's identity, attempt, outcome and result
                            reference. It does not supply a child-session transcript ID on this
                            workflow envelope.
                          </p>
                        </section>
                      )}
                      <DecisionPanels
                        session={session}
                        disabled={!available || busy}
                        mutate={mutate}
                      />
                      <div className="transcript-tools">
                        <span>
                          {history !== null ? total : session.state.totalItems} session items ·
                          current page only
                        </span>
                        <button disabled={!available || busy} onClick={() => void page()}>
                          {history !== null ? 'Next / first page' : 'Browse history'}
                        </button>
                      </div>
                      {items.map((item) => (
                        <article key={item.itemId} className="transcript-item">
                          <header>
                            <strong>{item.tool ?? item.kind}</strong>
                            <small>
                              {item.status} · r{item.revision}
                            </small>
                          </header>
                          <pre>
                            {(item.status === 'inProgress'
                              ? session.state.provisionalText?.[item.itemId]
                              : undefined) ??
                              item.text ??
                              item.objective ??
                              item.fallbackText ??
                              item.finalSummary ??
                              (item.kind === 'toolCall'
                                ? (item.statusLine ?? 'Tool execution')
                                : text(item))}
                          </pre>
                          <details>
                            <summary>Native provenance</summary>
                            <pre>
                              {text(
                                session.state.itemProvenance?.[item.itemId] ??
                                  'Source cursor and event range unavailable',
                              )}
                            </pre>
                          </details>
                          {item.args && (
                            <details>
                              <summary>Arguments</summary>
                              <pre>{item.args}</pre>
                            </details>
                          )}
                          {(item.outputRef || item.patchRef) && (
                            <StoredOutput
                              key={`${session.id}:${item.itemId}:${item.revision}`}
                              sessionId={session.id}
                              item={item}
                              disabled={!available || busy || !!task?.childSessionId}
                            />
                          )}
                          {item.visibleOutput && (
                            <details open>
                              <summary>Tool output</summary>
                              <pre>{item.visibleOutput}</pre>
                            </details>
                          )}
                          <small className="muted">
                            {item.itemId} {item.recordedAt ?? 'provisional'}
                          </small>
                        </article>
                      ))}
                      {items.length === 0 && (
                        <p className="muted">Send a task to begin its transcript.</p>
                      )}
                    </>
                  )}
                  {tab === 'diff' && (
                    <>
                      <div className="row">
                        <button
                          className="primary"
                          disabled={!available || busy || !task?.turnId}
                          onClick={() => void capture()}
                        >
                          Capture working-tree diff
                        </button>
                        <button onClick={() => void loadReview()}>Refresh captures</button>
                      </div>
                      <p className="muted">
                        Captures include HEAD, tracked changes and untracked files. Producing-task
                        association is your assertion.
                      </p>
                      <label>
                        Captured revision
                        <select
                          value={candidate?.id ?? ''}
                          onChange={(e) => setArtifactId(e.target.value)}
                        >
                          <option value="">Select a capture</option>
                          {review.artifacts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {short(a.fingerprint.slice(7))} ·{' '}
                              {new Date(a.capturedAtMillis).toLocaleTimeString()}
                            </option>
                          ))}
                        </select>
                      </label>
                      {artifact ? (
                        <>
                          <RevisionBadge artifact={artifact} fresh={fresh} />
                          <DiffView key={artifact.id} patch={artifact.patch} />
                          {artifact.untracked.map((f) => (
                            <details key={f.path} open>
                              <summary>
                                Untracked: {f.path} · {f.bytes} bytes
                              </summary>
                              <pre>{f.text ?? `Binary file · ${f.sha256}`}</pre>
                            </details>
                          ))}
                        </>
                      ) : (
                        <p className="muted">
                          Capture a diff to inspect an exact repository revision.
                        </p>
                      )}
                    </>
                  )}
                  {tab === 'evidence' && (
                    <>
                      {artifact ? (
                        <>
                          <RevisionBadge artifact={artifact} fresh={fresh} />
                          <p className="muted">
                            Completion, test results, review and acceptance are distinct. Records
                            below are explicit user attestations with a native source item, not
                            automatic verification.
                          </p>
                          <EvidenceForm
                            key={artifact.id}
                            artifact={artifact}
                            items={status.sessions
                              .filter((s) => s.workspace === session.workspace)
                              .flatMap((s) =>
                                (s.state.items ?? []).map((item) => ({
                                  ...item,
                                  sourceSessionId: s.id,
                                })),
                              )}
                            disabled={!available || busy || fresh?.fresh !== true}
                            record={async (params) => {
                              await mutate('evidence/record', {
                                ...params,
                                sessionId: session.id,
                                artifactId: artifact.id,
                                fingerprint: artifact.fingerprint,
                              });
                              await loadReview();
                            }}
                          />
                          {review.nextOffset != null && (
                            <button
                              onClick={async () => {
                                const value = await request('review/list', {
                                  sessionId: session.id,
                                  artifactId: artifact.id,
                                  offset: review.nextOffset,
                                });
                                if (
                                  selectedSession.current === session.id &&
                                  selectedTask.current === task?.id
                                )
                                  setReview(value);
                              }}
                            >
                              Older evidence records
                            </button>
                          )}
                          {review.evidence
                            .filter((e) => e.artifactId === artifact.id)
                            .map((e) => (
                              <article className="evidence-card" key={e.id}>
                                <strong>
                                  {e.params.kind}: {e.params.outcome}
                                </strong>
                                <span>
                                  {e.provenance === 'userAttested'
                                    ? 'User attestation; revision association unverified'
                                    : e.provenance}{' '}
                                  ·{' '}
                                  {fresh?.fresh === true
                                    ? 'current revision'
                                    : fresh?.fresh === false
                                      ? 'stale revision'
                                      : 'freshness unknown'}
                                </span>
                                <p>{e.params.notes}</p>
                                <code>
                                  {e.params.command} · exit {e.params.exitCode ?? 'not applicable'}
                                </code>
                                <small>
                                  {e.params.author} · {e.params.environment} · source r
                                  {e.source.revision}
                                </small>
                              </article>
                            ))}
                        </>
                      ) : (
                        <p className="muted">
                          Capture and inspect a diff before recording revision-bound evidence.
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div className="command-area">
                  <details>
                    <summary>Runtime and interruption history</summary>
                    <pre>
                      {text({
                        generation: session.generation,
                        lifecycle: session.lifecycle,
                        handshake: session.handshake,
                        interruptions: session.interruptions,
                      })}
                    </pre>
                    {session.interruptions?.length > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          updatePrefs({
                            acknowledgedInterruptions: [
                              ...new Set([
                                ...(prefs.acknowledgedInterruptions ?? []),
                                ...session.interruptions.map(
                                  (i) => session.id + ':interrupt:' + i.atMillis + ':' + i.kind,
                                ),
                              ]),
                            ],
                          })
                        }
                      >
                        Mark interruptions seen
                      </button>
                    )}
                  </details>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      const message = String(data.get('message'));
                      await mutate(session.state.activeTurnId ? 'steer' : 'turn', {
                        sessionId: session.id,
                        text: message,
                        ...(session.state.activeTurnId
                          ? { turnId: session.state.activeTurnId }
                          : {}),
                      });
                    }}
                  >
                    <label htmlFor="message">
                      {session.state.activeTurnId
                        ? 'Steer current turn'
                        : 'New task for this session'}
                    </label>
                    <textarea
                      id="message"
                      name="message"
                      required
                      maxLength={16000}
                      placeholder="Describe the next step…"
                      disabled={!available || busy || task?.provenance === 'native'}
                    />
                    <div className="row">
                      <span className="muted">
                        Target session: {short(session.id)}
                        {session.state.activeTurnId
                          ? ' · turn ' + short(session.state.activeTurnId)
                          : ''}
                        {task?.childSessionId ? ' · child is read-only' : ''}
                      </span>
                      <button
                        className="primary"
                        disabled={!available || busy || task?.provenance === 'native'}
                      >
                        {session.state.activeTurnId ? 'Send steering' : 'Start turn'}
                      </button>
                      {session.state.activeTurnId && (
                        <button
                          type="button"
                          disabled={!available || busy || task?.provenance === 'native'}
                          onClick={() =>
                            void mutate('cancel', {
                              sessionId: session.id,
                              turnId: session.state.activeTurnId,
                            })
                          }
                        >
                          Cancel turn
                        </button>
                      )}
                    </div>
                  </form>
                  <details>
                    <summary>Command acknowledgements</summary>
                    {status.commands
                      .filter((c) => c.sessionId === session.id)
                      .slice(0, 10)
                      .map((c) => (
                        <p key={c.id}>
                          <strong>
                            {c.operation}: {c.status}
                          </strong>
                          <small>Request {c.id}</small>
                          {c.error && <pre>{text(c.error)}</pre>}
                        </p>
                      ))}
                    {lastCommand.current && (
                      <button
                        disabled={busy}
                        onClick={async () => {
                          const last = lastCommand.current!;
                          setBusy(true);
                          try {
                            const r = await request(last.operation, last.params, last.id);
                            setNotice(
                              `${last.operation}: ${r.status ?? 'saved'} · same request ID`,
                            );
                            await refresh();
                          } catch (e) {
                            setError(String(e));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Query / retry last request with same ID
                      </button>
                    )}
                  </details>
                </div>
              </section>
            </div>
          </>
        )}
      </main>
      <dialog ref={modalRef} onCancel={() => setModal(null)} aria-labelledby="dialog-heading">
        <div className="dialog-heading">
          <h2 id="dialog-heading">
            {modal === 'start'
              ? 'Start a Muse session'
              : modal === 'stop'
                ? 'Stop execution and quit'
                : 'Command palette'}
          </h2>
          <button onClick={() => setModal(null)} aria-label="Close dialog">
            ×
          </button>
        </div>
        {modal === 'start' && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const result = await mutate('start', { workspace: String(form.get('workspace')) });
              if (result && result.status === 'applied') {
                updatePrefs({ sessionId: result.sessionId, selection: undefined });
                setModal(null);
                const message = String(form.get('initial'));
                if (message) await mutate('turn', { sessionId: result.sessionId, text: message });
              }
            }}
          >
            <label>
              Existing repository path
              <input name="workspace" required placeholder="/Users/you/projects/repository" />
            </label>
            <label>
              Initial task
              <textarea
                name="initial"
                required
                maxLength={16000}
                placeholder="What should Muse work on?"
              />
            </label>
            <p className="muted">
              Muse controls tool permissions. Closing this window leaves the supervisor and sessions
              running.
            </p>
            <button className="primary" disabled={busy}>
              Start session
            </button>
          </form>
        )}
        {modal === 'stop' && (
          <>
            <p>
              This stops the supervisor and drains all {status.sessions.length} registered sessions.
              It can interrupt active work.
            </p>
            <ul>
              {status.sessions.map((s) => (
                <li key={s.id}>
                  {s.workspace} · {short(s.id)}
                </li>
              ))}
            </ul>
            <div className="row">
              <button onClick={() => setModal(null)}>Keep running</button>
              <button
                className="danger"
                disabled={busy}
                onClick={async () => {
                  try {
                    await flushPrefs();
                  } catch (error) {
                    setError(String(error));
                    return;
                  }
                  const result = await mutate('stop', {
                    sessions: status.sessions.map((s) => s.id),
                  });
                  if (result) {
                    if ((window as any).__TAURI_INTERNALS__?.metadata) {
                      await getCurrentWindow().destroy();
                      return;
                    }
                    setModal(null);
                    setConnected(false);
                    setNotice(
                      'Supervisor stopped. Close the window or reconnect to recover durable sessions.',
                    );
                  }
                }}
              >
                Stop all sessions
              </button>
            </div>
          </>
        )}
        {modal === 'palette' && (
          <>
            <button
              onClick={() => {
                setModal('start');
              }}
            >
              Start a new session
            </button>
            <button
              onClick={() => {
                setModal(null);
                updatePrefs({ view: 'list' });
              }}
            >
              Show task list
            </button>
            <button
              onClick={() => {
                setModal(null);
                setTab('diff');
              }}
            >
              Inspect selected diff
            </button>
            {status.sessions
              .flatMap((s) => tasks(s, prefs))
              .map((node) => (
                <button
                  key={node.id}
                  onClick={() => {
                    select(node);
                    setModal(null);
                  }}
                >
                  {node.label} · {short(node.sessionId)}
                </button>
              ))}
          </>
        )}
      </dialog>
    </div>
  );
}
function StoredOutput({
  sessionId,
  item,
  disabled,
}: {
  sessionId: string;
  item: Item;
  disabled: boolean;
}) {
  const [page, setPage] = useState<Json>(),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const ref = (item.patchRef ?? item.outputRef)!;
  async function read(offsetBytes: number) {
    setPending(true);
    try {
      setPage(
        await request('output', {
          sessionId,
          itemId: item.itemId,
          revision: item.revision,
          outputRef: ref.id,
          offsetBytes,
        }),
      );
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  }
  return (
    <details>
      <summary>Stored {item.patchRef ? 'native patch' : 'full output'}</summary>
      <p className="muted">
        {ref.mediaType} · {ref.byteLen} bytes
      </p>
      <button
        disabled={disabled || pending}
        onClick={() => void read(page && !page.eof ? page.offsetBytes + page.byteLen : 0)}
      >
        {page && !page.eof ? 'Next output page' : 'Read first output page'}
      </button>
      {error && <p role="alert">{error}</p>}
      {page && (
        <pre>
          {page.encoding === 'utf8'
            ? page.content
            : `Binary page (${page.byteLen} bytes, base64): ${page.content}`}
        </pre>
      )}
    </details>
  );
}
function DiffView({ patch }: { patch: string }) {
  const [page, setPage] = useState(0);
  const lines = patch.split('\n');
  const size = 200;
  return (
    <section aria-label="Captured diff">
      <div className="row">
        <span className="muted">
          Lines {page * size + 1}–{Math.min((page + 1) * size, lines.length)} of {lines.length}
        </span>
        <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous diff page
        </button>
        <button disabled={(page + 1) * size >= lines.length} onClick={() => setPage((p) => p + 1)}>
          Next diff page
        </button>
      </div>
      <pre className="diff">
        {patch
          ? lines.slice(page * size, (page + 1) * size).map((line, index) => (
              <span
                className={
                  line.startsWith('+')
                    ? 'added'
                    : line.startsWith('-')
                      ? 'removed'
                      : line.startsWith('@@')
                        ? 'hunk'
                        : ''
                }
                key={index}
              >
                <i>{page * size + index + 1}</i>
                {line}
                {'\n'}
              </span>
            ))
          : 'No tracked changes in this capture.'}
      </pre>
    </section>
  );
}
function RevisionBadge({
  artifact,
  fresh,
}: {
  artifact: Artifact;
  fresh: { fresh: boolean; checkedAtMillis: number } | null;
}) {
  return (
    <div className={`revision-badge ${fresh?.fresh === false ? 'stale' : ''}`}>
      <strong>
        {fresh
          ? fresh.fresh
            ? 'Current captured content'
            : 'Stale: repository changed'
          : 'Freshness unknown'}
      </strong>
      <code>{artifact.fingerprint}</code>
      <small>
        Base / HEAD: {artifact.base} · task association: {artifact.provenance}
        {fresh ? ` · checked ${new Date(fresh.checkedAtMillis).toLocaleTimeString()}` : ''}
      </small>
    </div>
  );
}
function DecisionPanels({
  session,
  disabled,
  mutate,
}: {
  session: SessionRow;
  disabled: boolean;
  mutate: (operation: string, params: Json) => Promise<Json>;
}) {
  return (
    <>
      {(session.state.approvals ?? []).map((entry) => {
        const a = entry.requested;
        return (
          <section className="decision" key={a.approvalId}>
            <h3>Permission decision</h3>
            <p>Workspace: {session.workspace}</p>
            <p>
              <strong>{a.toolName}</strong> · {text(a.subject)}
            </p>
            <pre>{a.rawArgs}</pre>
            {a.subagentOrigin && <p>Delegated origin: {text(a.subagentOrigin)}</p>}
            <details>
              <summary>Request identity and provenance</summary>
              <pre>{text(a)}</pre>
            </details>
            <div className="row">
              {a.availableChoices.map((choice: Json) => (
                <button
                  key={choice.choiceId}
                  disabled={disabled}
                  onClick={() =>
                    void mutate('decide', {
                      sessionId: session.id,
                      approvalId: a.approvalId,
                      requirementId: a.currentRequirementId,
                      choiceId: choice.choiceId,
                    })
                  }
                >
                  {choice.label ?? choice.decision ?? choice.choiceId}
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {(session.state.userInputs ?? []).map((input) => (
        <form
          className="decision"
          key={input.userInputId}
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            void mutate('answer', {
              sessionId: session.id,
              userInputId: input.userInputId,
              answers: questionAnswers(input.questions, data),
            });
          }}
        >
          <h3>Muse needs an answer</h3>
          {input.questions.map((q: Json) => (
            <label key={q.id}>
              {q.question}
              {q.options?.length ? (
                <select
                  name={q.id}
                  multiple={q.selection?.mode === 'multiple'}
                  required
                  disabled={disabled}
                >
                  {q.options.map((o: Json) => (
                    <option key={o.label}>{o.label}</option>
                  ))}
                </select>
              ) : (
                <input name={q.id} required maxLength={500} disabled={disabled} />
              )}
            </label>
          ))}
          <button disabled={disabled}>Submit answer</button>
        </form>
      ))}
    </>
  );
}
function EvidenceForm({
  artifact,
  items,
  disabled,
  record,
}: {
  artifact: Artifact;
  items: Item[];
  disabled: boolean;
  record: (params: Json) => Promise<void>;
}) {
  const [kind, setKind] = useState('test');
  const sources = items.filter((i) => i.status !== 'inProgress');
  return (
    <form
      className="evidence-form"
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const source = sources.find((i) => i.itemId === data.get('source'));
        if (!source) return;
        await record({
          kind,
          outcome: String(data.get('outcome')),
          sourceItemId: source.itemId,
          sourceSessionId: source.sourceSessionId,
          sourceRevision: source.revision,
          author: String(data.get('author')),
          notes: String(data.get('notes')),
          command: String(data.get('command')),
          environment: String(data.get('environment')),
          exitCode: kind === 'test' ? Number(data.get('exit')) : null,
        });
      }}
    >
      <h3>Record evidence for {short(artifact.fingerprint.slice(7))}</h3>
      <label>
        Evidence type
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="test">Test result</option>
          <option value="review">Review</option>
          <option value="acceptance">User acceptance</option>
        </select>
      </label>
      <label>
        Native source item
        <select name="source" required>
          {sources.map((i) => (
            <option key={i.itemId} value={i.itemId}>
              {i.tool ?? i.kind} · r{i.revision} · {short(i.itemId)} · session{' '}
              {short(i.sourceSessionId ?? '')}
            </option>
          ))}
        </select>
      </label>
      <label>
        Outcome
        <select key={kind} name="outcome">
          {(kind === 'test'
            ? ['passed', 'failed']
            : kind === 'review'
              ? ['approved', 'changesRequested']
              : ['accepted', 'rejected']
          ).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label>
        {kind === 'review' ? 'Reviewer' : 'Attesting user'}
        <input name="author" required maxLength={200} />
      </label>
      <label>
        Command or review scope
        <input name="command" required maxLength={8000} />
      </label>
      {kind === 'test' && (
        <label>
          Observed exit code
          <input name="exit" type="number" required step="1" />
        </label>
      )}
      <label>
        Execution environment
        <input
          name="environment"
          required
          maxLength={8000}
          placeholder="macOS arm64, Node 24, local workspace"
        />
      </label>
      <label>
        Findings / result notes
        <textarea name="notes" required maxLength={8000} />
      </label>
      <button className="primary" disabled={disabled || sources.length === 0}>
        Save revision-bound attestation
      </button>
    </form>
  );
}
