import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { connectionCurve } from './constellation';
import type { Json, SessionRow } from './types';

type TaskSpec = {
  id: string;
  title: string;
  brief: string;
  criteria: string;
  dependsOn: string[];
  sessionId: string | null;
};
type StoredTask = {
  spec: TaskSpec;
  launch?: { requestId: string } | null;
  evidence?: { note: string; revision: string } | null;
};
type DecisionTarget = { kind: 'approval' | 'question'; id: string };
type TaskStatus = {
  state: string;
  waitingFor: string[];
  turnId?: string;
  decision?: DecisionTarget;
};
const stateLabels: Record<string, string> = {
  unassigned: 'Assign a session',
  waiting: 'Waiting on evidence',
  ready: 'Ready to start',
  running: 'Muse is working',
  needsInput: 'Needs your input',
  readyToAccept: 'Review evidence',
  accepted: 'Evidence accepted',
  stale: 'Evidence needs review',
  stopped: 'Task stopped',
  sessionUnavailable: 'Session unavailable',
  sessionBusy: 'Wait for the session',
  startUnconfirmed: 'Check session history',
};

type MissionAction = { operation: string; params: Json; id: string };
type Finding = { id: string; taskId: string; note: string; resolved: boolean };

function MissionGraph({
  tasks,
  states,
  findingCounts,
  sessionName,
  selected,
  select,
}: {
  tasks: TaskSpec[];
  states: TaskStatus[];
  findingCounts: ReadonlyMap<string, number>;
  sessionName: (id: string) => string;
  selected: string | null;
  select: (id: string) => void;
}) {
  const positions = new Map<string, { x: number; y: number; depth: number }>();
  const stacks = new Map<number, number>();
  const ids = new Set(tasks.map((task) => task.id));
  for (let pass = 0; pass < tasks.length; pass++) {
    for (const task of tasks) {
      const dependencies = task.dependsOn.filter((id) => ids.has(id));
      if (positions.has(task.id) || !dependencies.every((id) => positions.has(id))) continue;
      const depth = Math.max(0, ...dependencies.map((id) => positions.get(id)!.depth + 1));
      const row = stacks.get(depth) ?? 0;
      stacks.set(depth, row + 1);
      positions.set(task.id, { x: 24 + depth * 284, y: 24 + row * 174, depth });
    }
  }
  // Local edits can temporarily have a cyclic dependency. Show every card so it stays editable.
  for (const task of tasks.filter((task) => !positions.has(task.id))) {
    const depth = stacks.size;
    const row = stacks.get(-1) ?? 0;
    stacks.set(-1, row + 1);
    positions.set(task.id, { x: 24 + depth * 284, y: 24 + row * 174, depth });
  }
  const width = Math.max(510, ...Array.from(positions.values(), (p) => p.x + 244));
  const height = Math.max(360, ...Array.from(positions.values(), (p) => p.y + 164));
  if (!tasks.length)
    return (
      <div className="mission-empty">
        <strong>Start with a task</strong>
        <p>Add an outcome for Muse to work towards, then link tasks that depend on it.</p>
      </div>
    );
  return (
    <div className="mission-map" role="region" aria-label="Mission task map">
      <div className="mission-map-stage" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker
              id="mission-arrow"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <path d="M0 0 L6 3 L0 6" />
            </marker>
          </defs>
          {tasks.flatMap((task) =>
            task.dependsOn.flatMap((id) => {
              const from = positions.get(id);
              const to = positions.get(task.id);
              return from && to && from.depth < to.depth
                ? [
                    <path
                      key={id + task.id}
                      className="mission-connector"
                      markerEnd="url(#mission-arrow)"
                      d={connectionCurve(from, to)}
                    />,
                  ]
                : [];
            }),
          )}
        </svg>
        {tasks.map((task, i) => {
          const position = positions.get(task.id)!;
          const state = states[i]?.state ?? 'planned';
          const status = stateLabels[state] ?? 'Planned task';
          const findings = findingCounts.get(task.id) ?? 0;
          return (
            <button
              key={task.id}
              className="mission-node"
              style={{ left: position.x, top: position.y }}
              type="button"
              aria-pressed={selected === task.id}
              aria-label={`${task.title || 'New task'}, ${status}${findings ? `, ${findings} open review ${findings === 1 ? 'finding' : 'findings'}` : ''}`}
              data-state={state}
              onClick={() => select(task.id)}
            >
              <strong>{task.title || 'New task'}</strong>
              <span>{status}</span>
              {findings > 0 ? (
                <small>
                  {findings} open review {findings === 1 ? 'finding' : 'findings'}
                </small>
              ) : task.sessionId ? (
                <small className="mission-owner">{sessionName(task.sessionId)}</small>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ProjectMission({
  projectId,
  sessions,
  canStart,
  refreshStatus,
  openSession,
  sendFinding,
}: {
  projectId: string;
  sessions: SessionRow[];
  canStart: boolean;
  refreshStatus: () => Promise<unknown>;
  openSession: (
    sessionId: string,
    turnId?: string,
    destination?: 'workspace' | DecisionTarget,
  ) => void;
  sendFinding: (sessionId: string, turnId: string, note: string) => void;
}) {
  const [data, setData] = useState<Json>();
  const [edit, setEdit] = useState<{ goal: string; tasks: TaskSpec[] }>();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'plan' | 'integration'>('plan');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<MissionAction>();
  const [newSession, setNewSession] = useState<{ name: string; reviewer: boolean }>();
  const [review, setReview] = useState<{ operation: string; params: Json; data: Json }>();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const [note, setNote] = useState('');
  const [handoffs, setHandoffs] = useState<{ id: string; target: Json }[]>([]);
  const [handoffId, setHandoffId] = useState('');
  const [integration, setIntegration] = useState('');
  const [inputs, setInputs] = useState<string[]>([]);
  const [reviewer, setReviewer] = useState('');
  const [owner, setOwner] = useState('');
  const [finding, setFinding] = useState('');

  const projectSessions = sessions.filter(
    (row) =>
      row.projectContext?.id === projectId &&
      row.lifecycle !== 'archived' &&
      !row.workspaceDiscarded,
  );
  const sessionName = (id: string) =>
    projectSessions.find((row) => row.id === id)?.displayName || 'Project session';
  const currentTasks: StoredTask[] = data?.plan.tasks ?? [];
  const states: TaskStatus[] = data?.tasks ?? [];
  const tasks = edit?.tasks ?? currentTasks.map((task) => task.spec);
  const index = tasks.findIndex((t) => t.id === selected);
  const task = tasks[index];
  const current = currentTasks[index];
  const outcome = states[index];
  const state = data?.integration;
  const assembled = data?.plan.rehearsal;
  const active =
    states.some((s) => s.state === 'running' || s.state === 'needsInput') ||
    (!!state?.review &&
      !state.review.terminal &&
      ['sending', 'accepted', 'applied'].includes(state.review.commandStatus));

  async function load() {
    setData(await request('mission/get', { projectId }));
  }
  useEffect(() => {
    let disposed = false;
    const fetch = () =>
      request('mission/get', { projectId })
        .then((value) => {
          if (!disposed && !inFlight.current) setData(value);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    void fetch();
    const timer = active
      ? window.setInterval(() => {
          if (!inFlight.current) void fetch();
        }, 4500)
      : undefined;
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [projectId, active]);
  useEffect(() => {
    setNote('');
    setHandoffId('');
    setHandoffs([]);
    const turnId = outcome?.turnId;
    const sessionId = task?.sessionId;
    if (!turnId || !sessionId || !['readyToAccept', 'stale', 'accepted'].includes(outcome?.state))
      return;
    let disposed = false;
    void request('handoff/list', { task: { sessionId, turnId } })
      .then((value) => {
        if (!disposed)
          setHandoffs(
            value.handoffs.filter(
              (packet: Json) =>
                packet.source.sessionId === sessionId && packet.source.turnId === turnId,
            ),
          );
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [outcome?.turnId, outcome?.state, task?.sessionId]);
  useEffect(() => {
    if (review) reviewHeading.current?.focus();
  }, [review]);

  async function act(
    operation: string,
    params: Json = {},
    inspect?: (result: Json) => void,
    saved?: () => void,
  ) {
    if (!data || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    const wire = { projectId, revision: data.plan.revision, ...params };
    let action = retry;
    if (
      !action ||
      action.operation !== operation ||
      JSON.stringify(action.params) !== JSON.stringify(wire)
    )
      action = { operation, params: wire, id: crypto.randomUUID() };
    try {
      const result = await request(operation, wire, action.id);
      setRetry(undefined);
      if (result.status === 'rejected' || result.status === 'outcomeUnknown')
        throw Error(result.error?.message ?? 'Refresh and check the recorded result.');
      if (inspect) inspect(result);
      else {
        setReview(undefined);
        saved?.();
        await refreshStatus();
        await load();
      }
    } catch (e) {
      setRetry(action);
      setError(String(e instanceof Error ? e.message : e));
      if (!inspect) {
        try {
          await load();
        } catch {
          /* keep the action error */
        }
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function preview(operation: string, params: Json) {
    void act(operation, params, (result) => setReview({ operation, params, data: result }));
  }
  function workOn(id: string, turnId?: string, destination?: 'workspace' | DecisionTarget) {
    openSession(id, turnId, destination);
  }
  function updateTask(change: Partial<TaskSpec>) {
    if (edit && task)
      setEdit({
        ...edit,
        tasks: edit.tasks.map((item) => (item.id === task.id ? { ...item, ...change } : item)),
      });
  }
  function addTask() {
    const draft = edit ?? { goal: data.plan.goal, tasks };
    const item = {
      id: crypto.randomUUID(),
      title: '',
      brief: '',
      criteria: '',
      dependsOn: [],
      sessionId: null,
    };
    setEdit({ ...draft, tasks: [...draft.tasks, item] });
    setSelected(item.id);
  }
  function createSession(name: string, readOnly: boolean) {
    void act(
      'start',
      {
        projectRevision: data.projectRevision,
        isolated: true,
        name,
        permissionProfile: readOnly ? ':read-only' : ':ask-me',
      },
      (result) => {
        if (result.status !== 'applied' || !result.sessionId)
          throw Error('Check the session list to see whether the session started.');
        setNewSession(undefined);
        void refreshStatus();
        if (readOnly) setReviewer(result.sessionId);
        else if (view === 'integration') setIntegration(result.sessionId);
        else if (edit && task) updateTask({ sessionId: result.sessionId });
      },
    );
  }

  if (!data)
    return <p role={error ? 'alert' : 'status'}>{error || 'Loading the project mission…'}</p>;
  const pendingInput = currentTasks.findIndex((_, i) => states[i]?.state === 'needsInput');
  const contributing = currentTasks.filter(
    (t, i) => states[i]?.state === 'accepted' && t.spec.sessionId,
  );
  const free = projectSessions.filter(
    (row) =>
      row.managedWorkspace &&
      row.id !== assembled?.sessionId &&
      !(data.plan.supersededIntegrations ?? []).includes(row.id) &&
      !currentTasks.some((t) => t.spec.sessionId === row.id),
  );
  const findings: Finding[] = assembled?.review?.findings ?? [];
  const findingCounts = new Map<string, number>();
  for (const finding of findings) {
    if (!finding.resolved) {
      findingCounts.set(finding.taskId, (findingCounts.get(finding.taskId) ?? 0) + 1);
    }
  }
  return (
    <div className="project-mission" aria-busy={busy}>
      <header className="mission-header">
        <div>
          <p className="eyebrow">{data.projectName}</p>
          <h3>{data.plan.goal || 'Give the project a shared goal'}</h3>
        </div>
        <div className="mission-actions">
          <button
            className="quiet-button"
            disabled={busy}
            onClick={() => {
              void act('mission/get', {}, setData);
            }}
          >
            Refresh mission
          </button>
          {pendingInput >= 0 && (
            <button
              className="primary"
              onClick={() =>
                workOn(
                  currentTasks[pendingInput].spec.sessionId!,
                  states[pendingInput].turnId,
                  states[pendingInput].decision,
                )
              }
            >
              Needs your input
            </button>
          )}
        </div>
      </header>
      {error && !review && (
        <p className="mission-error" role="alert">
          {error}
        </p>
      )}
      <div className="segmented" role="group" aria-label="Mission view">
        <button
          aria-pressed={view === 'plan'}
          onClick={() => {
            setView('plan');
            setReview(undefined);
          }}
        >
          Plan
        </button>
        <button
          aria-pressed={view === 'integration'}
          disabled={!!edit}
          onClick={() => {
            setView('integration');
            setReview(undefined);
          }}
        >
          Integration &amp; review
        </button>
      </div>
      {view === 'plan' && (
        <>
          <div className="mission-actions mission-plan-tools">
            {edit ? (
              <>
                <button
                  disabled={busy}
                  onClick={() => {
                    setEdit(undefined);
                    setError('');
                  }}
                >
                  Cancel edit
                </button>
                <button disabled={busy || tasks.length >= 12} onClick={addTask}>
                  Add task
                </button>
                <button
                  className="primary"
                  disabled={busy || !edit.goal.trim()}
                  onClick={() =>
                    void act('mission/save', edit, undefined, () => setEdit(undefined))
                  }
                >
                  Save plan
                </button>
              </>
            ) : (
              <button
                className={tasks.length ? 'quiet-button' : 'primary'}
                disabled={busy}
                onClick={() =>
                  tasks.length ? setEdit({ goal: data.plan.goal, tasks }) : addTask()
                }
              >
                {tasks.length ? 'Edit plan' : 'Create plan'}
              </button>
            )}
          </div>
          {edit && (
            <label className="mission-goal">
              Mission goal
              <textarea
                maxLength={2400}
                value={edit.goal}
                readOnly={currentTasks.some((item) => !!item.launch)}
                onChange={(e) => setEdit({ ...edit, goal: e.target.value })}
              />
              {currentTasks.some((item) => !!item.launch) && (
                <small className="muted">Reopen started tasks to change the mission goal.</small>
              )}
            </label>
          )}
          <div className={task ? 'mission-plan-layout' : 'mission-plan-layout mission-plan-wide'}>
            <MissionGraph
              tasks={tasks}
              states={edit ? [] : states}
              findingCounts={findingCounts}
              sessionName={sessionName}
              selected={selected}
              select={(id) => {
                setSelected(id);
                setReview(undefined);
              }}
            />
            {task && (
              <section className="mission-inspector" aria-label="Mission task detail">
                {edit ? (
                  <>
                    <h4>{task.title || 'New task'}</h4>
                    {currentTasks.some((item) => item.spec.id === task.id && item.launch) ? (
                      <p className="muted">
                        Cancel editing and reopen this task before changing it.
                      </p>
                    ) : (
                      <>
                        <label>
                          Task title
                          <input
                            maxLength={96}
                            value={task.title}
                            onChange={(e) => updateTask({ title: e.target.value })}
                          />
                        </label>
                        <label>
                          Brief
                          <textarea
                            maxLength={2400}
                            value={task.brief}
                            onChange={(e) => updateTask({ brief: e.target.value })}
                          />
                        </label>
                        <label>
                          Acceptance criteria
                          <textarea
                            maxLength={1200}
                            value={task.criteria}
                            onChange={(e) => updateTask({ criteria: e.target.value })}
                          />
                        </label>
                        <label>
                          Assigned session
                          <select
                            value={task.sessionId ?? ''}
                            onChange={(e) => updateTask({ sessionId: e.target.value || null })}
                          >
                            <option value="">Unassigned</option>
                            {projectSessions
                              .filter(
                                (row) =>
                                  row.id !== assembled?.sessionId &&
                                  row.id !== assembled?.review?.sessionId,
                              )
                              .map((row) => (
                                <option key={row.id} value={row.id}>
                                  {sessionName(row.id)}
                                </option>
                              ))}
                          </select>
                        </label>
                        <button
                          className="quiet-button"
                          disabled={busy || !canStart}
                          onClick={() =>
                            setNewSession({ name: task.title || 'Mission task', reviewer: false })
                          }
                        >
                          Create isolated session
                        </button>
                        {tasks.length > 1 && (
                          <fieldset>
                            <legend>Depends on</legend>
                            {tasks
                              .filter((t) => t.id !== task.id)
                              .map((other) => (
                                <label className="row" key={other.id}>
                                  <input
                                    type="checkbox"
                                    checked={task.dependsOn.includes(other.id)}
                                    onChange={(e) =>
                                      updateTask({
                                        dependsOn: e.target.checked
                                          ? [...task.dependsOn, other.id]
                                          : task.dependsOn.filter((id) => id !== other.id),
                                      })
                                    }
                                  />
                                  {other.title || 'New task'}
                                </label>
                              ))}
                          </fieldset>
                        )}
                        <button
                          className="quiet-button"
                          onClick={() => {
                            setEdit({
                              ...edit,
                              tasks: edit.tasks
                                .filter((t) => t.id !== task.id)
                                .map((t) => ({
                                  ...t,
                                  dependsOn: t.dependsOn.filter((id) => id !== task.id),
                                })),
                            });
                            setSelected(null);
                          }}
                        >
                          Remove task
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <h4>{task.title}</h4>
                    <p className="mission-task-state">{stateLabels[outcome?.state] ?? 'Planned'}</p>
                    <p>{task.brief}</p>
                    <h5>Acceptance criteria</h5>
                    <p>{task.criteria}</p>
                    {outcome?.waitingFor.length > 0 && (
                      <p className="muted">
                        Waiting for{' '}
                        {outcome.waitingFor
                          .map((id) => tasks.find((t) => t.id === id)?.title)
                          .filter(Boolean)
                          .join(', ')}
                        .
                      </p>
                    )}
                    {task.sessionId && (
                      <p className="muted">Session · {sessionName(task.sessionId)}</p>
                    )}
                    {task.sessionId && outcome?.state === 'ready' && (
                      <button
                        className="primary"
                        disabled={busy || !canStart}
                        onClick={() =>
                          void act('mission/launch', { taskId: task.id, sessionId: task.sessionId })
                        }
                      >
                        Start this task
                      </button>
                    )}
                    {task.sessionId && outcome?.turnId && (
                      <button
                        className="quiet-button"
                        onClick={() => workOn(task.sessionId!, outcome.turnId)}
                      >
                        Open task in session
                      </button>
                    )}
                    {findingCounts.has(task.id) && (
                      <button className="quiet-button" onClick={() => setView('integration')}>
                        Open review findings
                      </button>
                    )}
                    {task.sessionId &&
                      current?.launch &&
                      [
                        'stopped',
                        'stale',
                        'startUnconfirmed',
                        'sessionUnavailable',
                        'readyToAccept',
                        'accepted',
                      ].includes(outcome?.state) && (
                        <details>
                          <summary>Run this task again</summary>
                          <p>This clears its evidence and makes dependent work require review.</p>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void act('mission/reopen', {
                                taskId: task.id,
                                sessionId:
                                  outcome?.state === 'sessionUnavailable' ? null : task.sessionId,
                              })
                            }
                          >
                            Reopen task
                          </button>
                        </details>
                      )}
                    {current?.evidence && (
                      <p className="mission-evidence">{current.evidence.note}</p>
                    )}
                    {task.sessionId &&
                      (outcome?.state === 'readyToAccept' ||
                        outcome?.state === 'accepted' ||
                        (outcome?.state === 'stale' && !!current?.evidence)) && (
                        <details open={outcome.state === 'readyToAccept'}>
                          <summary>
                            {current?.evidence
                              ? 'Replace accepted evidence'
                              : 'Accept task evidence'}
                          </summary>
                          <label>
                            Evidence summary
                            <textarea
                              maxLength={1600}
                              value={note}
                              onChange={(e) => setNote(e.target.value)}
                            />
                          </label>
                          {!!handoffs.length && (
                            <label>
                              Include existing handoff
                              <select
                                value={handoffId}
                                onChange={(e) => setHandoffId(e.target.value)}
                              >
                                <option value="">Summary only</option>
                                {handoffs.map((packet, i) => (
                                  <option key={packet.id} value={packet.id}>
                                    {sessionName(packet.target.sessionId)} · handoff {i + 1}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                          <button
                            disabled={busy || !note.trim()}
                            onClick={() =>
                              preview('mission/evidencePreview', {
                                taskId: task.id,
                                sessionId: task.sessionId,
                                note,
                                handoffId: handoffId || null,
                              })
                            }
                          >
                            Preview evidence
                          </button>
                        </details>
                      )}
                  </>
                )}
              </section>
            )}
          </div>
        </>
      )}
      {view === 'integration' && (
        <div className="mission-integration">
          <section className="mission-inspector" aria-label="Integration rehearsal">
            <h4>Integration rehearsal</h4>
            {(!assembled || ['assembled', 'aborted', 'unavailable'].includes(state?.status)) && (
              <details open={!assembled}>
                <summary>{assembled ? 'Prepare another rehearsal' : 'Select changes'}</summary>
                <p className="muted">
                  Choose accepted tasks with committed changes in the same repository. The rehearsal
                  uses a fresh isolated session.
                </p>
                <label>
                  Integration session
                  <select value={integration} onChange={(e) => setIntegration(e.target.value)}>
                    <option value="">Choose a session</option>
                    {free
                      .filter(
                        (row) =>
                          !(row.state.turns ?? []).length &&
                          row.id !== assembled?.review?.sessionId,
                      )
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {sessionName(row.id)}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  className="quiet-button"
                  disabled={busy || !canStart}
                  onClick={() => setNewSession({ name: 'Integration rehearsal', reviewer: false })}
                >
                  Create integration session
                </button>
                <fieldset>
                  <legend>Contributing tasks</legend>
                  {contributing.length ? (
                    contributing.map((t) => (
                      <label key={t.spec.id} className="row">
                        <input
                          type="checkbox"
                          checked={inputs.includes(t.spec.id)}
                          onChange={(e) =>
                            setInputs(
                              e.target.checked
                                ? [...inputs, t.spec.id]
                                : inputs.filter((id) => id !== t.spec.id),
                            )
                          }
                        />
                        {t.spec.title}
                      </label>
                    ))
                  ) : (
                    <p className="muted">Accept evidence from contributing tasks first.</p>
                  )}
                </fieldset>
                <button
                  className="primary"
                  disabled={busy || !integration || !inputs.length}
                  onClick={() =>
                    preview('mission/integrationPreview', {
                      sessionId: integration,
                      taskIds: inputs,
                    })
                  }
                >
                  Preview integration
                </button>
              </details>
            )}
            {assembled && (
              <div className="mission-integration-state">
                <p>
                  {state?.status === 'conflict'
                    ? 'Resolve merge conflicts'
                    : state?.status === 'assembled'
                      ? 'Changes assembled'
                      : state?.status === 'aborted'
                        ? 'Rehearsal stopped'
                        : state?.status === 'unavailable'
                          ? 'Integration session unavailable'
                          : 'Rehearsal interrupted'}
                </p>
                <ul>
                  {assembled.preview.sources.map((item: Json, i: number) => (
                    <li key={item.taskId}>
                      <strong>{item.title}</strong>
                      <span>{i < assembled.next ? 'Included' : 'Waiting'}</span>
                    </li>
                  ))}
                </ul>
                <div className="mission-actions">
                  {state?.status === 'conflict' && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() =>
                        preview('mission/conflictPreview', { sessionId: assembled.sessionId })
                      }
                    >
                      Inspect conflicts
                    </button>
                  )}
                  {state?.status === 'interrupted' && (
                    <>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() =>
                          void act('mission/continue', { sessionId: assembled.sessionId })
                        }
                      >
                        Continue rehearsal
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act('mission/abandon', { sessionId: assembled.sessionId })
                        }
                      >
                        Stop and keep worktree
                      </button>
                    </>
                  )}
                  {state?.status !== 'unavailable' && (
                    <button
                      className="quiet-button"
                      onClick={() => workOn(assembled.sessionId, undefined, 'workspace')}
                    >
                      Open integration workspace
                    </button>
                  )}
                </div>
                {state?.status === 'assembled' && (
                  <p className={state.test ? 'mission-evidence' : 'muted'}>
                    {state.sourcesCurrent === false
                      ? 'A contributing task changed. Prepare a new rehearsal.'
                      : state.test
                        ? `Passed · ${state.test.command}`
                        : 'Run fresh tests in the integration workspace before requesting review.'}
                  </p>
                )}
              </div>
            )}
          </section>
          <section className="mission-inspector" aria-label="Independent review">
            <h4>Independent review</h4>
            {state?.test ? (
              <>
                <p className="muted">
                  Review the exact tested diff in a separate, read-only Muse session.
                </p>
                <label>
                  Reviewer session
                  <select value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
                    <option value="">Choose a reviewer</option>
                    {free.map((row) => (
                      <option key={row.id} value={row.id}>
                        {sessionName(row.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="quiet-button"
                  disabled={busy || !canStart}
                  onClick={() => setNewSession({ name: 'Independent review', reviewer: true })}
                >
                  Create read-only reviewer
                </button>
                <button
                  className="primary"
                  disabled={busy || !reviewer || !canStart}
                  onClick={() => preview('mission/reviewPreview', { sessionId: reviewer })}
                >
                  Preview review
                </button>
              </>
            ) : (
              <p className="muted">A passing test on the integration revision unlocks review.</p>
            )}
            {assembled?.review && (
              <>
                <p className="mission-task-state">
                  {!state.reviewCurrent
                    ? 'Review evidence is out of date'
                    : assembled.review.accepted
                      ? 'Review accepted'
                      : state.review?.terminal === 'completed'
                        ? 'Review complete'
                        : state.review?.terminal
                          ? 'Review stopped'
                          : 'Review in progress'}
                </p>
                <button
                  className="quiet-button"
                  onClick={() => workOn(assembled.review.sessionId, state.review?.turnId)}
                >
                  Open review transcript
                </button>
                {findings.length > 0 && (
                  <ul className="mission-findings">
                    {findings.map((f) => {
                      const i = tasks.findIndex((t) => t.id === f.taskId);
                      const linked = tasks[i];
                      const turnId = states[i]?.turnId;
                      return (
                        <li key={f.id}>
                          <strong>{linked?.title ?? 'Earlier task'}</strong>
                          <p>{f.note}</p>
                          <div className="mission-actions">
                            {linked?.sessionId && turnId && (
                              <button
                                disabled={busy}
                                onClick={() => sendFinding(linked.sessionId!, turnId, f.note)}
                              >
                                Add to task draft
                              </button>
                            )}
                            <button
                              disabled={busy || f.resolved || !state.reviewCurrent}
                              onClick={() =>
                                void act('mission/resolveFinding', { findingId: f.id })
                              }
                            >
                              {f.resolved ? 'Resolved' : 'Mark resolved'}
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {state.reviewCurrent && state.review?.terminal === 'completed' && (
                  <details>
                    <summary>Record a finding</summary>
                    <label>
                      Owning task
                      <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                        <option value="">Choose a task</option>
                        {assembled.preview.sources.map((t: Json) => (
                          <option key={t.taskId} value={t.taskId}>
                            {t.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Finding
                      <textarea
                        value={finding}
                        maxLength={1600}
                        onChange={(e) => setFinding(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={busy || !owner || !finding.trim()}
                      onClick={() =>
                        void act(
                          'mission/finding',
                          { taskId: owner, note: finding },
                          undefined,
                          () => setFinding(''),
                        )
                      }
                    >
                      Save finding
                    </button>
                  </details>
                )}
                {state.reviewCurrent &&
                  state.review?.terminal === 'completed' &&
                  !assembled.review.accepted && (
                    <button
                      className="primary"
                      disabled={busy || findings.some((item) => !item.resolved)}
                      onClick={() => void act('mission/acceptReview')}
                    >
                      Accept review
                    </button>
                  )}
                {state.reviewCurrent && assembled.review.accepted && (
                  <button
                    className="primary"
                    onClick={() => workOn(assembled.sessionId, undefined, 'workspace')}
                  >
                    Open delivery
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {newSession && (
        <section className="mission-confirm" aria-label="Create mission session">
          <h4>
            {newSession.reviewer
              ? 'Create a read-only reviewer'
              : 'Create an isolated project session'}
          </h4>
          <label>
            Session name
            <input
              maxLength={80}
              value={newSession.name}
              onChange={(e) => setNewSession({ ...newSession, name: e.target.value })}
            />
          </label>
          <div className="mission-actions">
            <button disabled={busy} onClick={() => setNewSession(undefined)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={busy || !newSession.name.trim()}
              onClick={() => createSession(newSession.name, newSession.reviewer)}
            >
              Create session
            </button>
          </div>
        </section>
      )}
      {review && (
        <MissionPreview
          review={review}
          heading={reviewHeading}
          busy={busy}
          error={error}
          act={act}
          refreshConflict={() => preview('mission/conflictPreview', review.params)}
          close={() => setReview(undefined)}
        />
      )}
    </div>
  );
}

function MissionPreview({
  review,
  heading,
  busy,
  error,
  act,
  refreshConflict,
  close,
}: {
  review: { operation: string; params: Json; data: Json };
  heading: React.RefObject<HTMLHeadingElement | null>;
  busy: boolean;
  error: string;
  act: (operation: string, params?: Json, inspect?: (result: Json) => void) => Promise<void>;
  refreshConflict: () => void;
  close: () => void;
}) {
  const [abort, setAbort] = useState(false);
  const { operation, params, data } = review;
  const titles: Record<string, string> = {
    'mission/evidencePreview': 'Review evidence',
    'mission/integrationPreview': 'Review the integration',
    'mission/reviewPreview': 'Review what Muse will receive',
    'mission/conflictPreview': 'Review the conflict resolution',
  };
  const action: Record<string, [string, string]> = {
    'mission/evidencePreview': ['mission/accept', 'Accept this evidence'],
    'mission/integrationPreview': ['mission/assemble', 'Assemble changes'],
    'mission/reviewPreview': ['mission/review', 'Start independent review'],
    'mission/conflictPreview': ['mission/continue', 'Commit resolution and continue'],
  };
  const conflict = operation === 'mission/conflictPreview';
  const [op, label] = action[operation];
  return (
    <section className="mission-confirm" aria-label={titles[operation]}>
      <h4 ref={heading} tabIndex={-1}>
        {titles[operation]}
      </h4>
      {error && (
        <p className="mission-error" role="alert">
          {error}
        </p>
      )}
      {operation === 'mission/evidencePreview' && (
        <>
          <p>{data.note}</p>
          <p className="muted">
            Source revision <code>{data.revision.slice(0, 19)}</code>
          </p>
          {data.handoffBody && <pre>{data.handoffBody}</pre>}
        </>
      )}
      {operation === 'mission/integrationPreview' && (
        <>
          <p className="muted">
            Base commit <code>{data.base.slice(0, 12)}</code>. The selected commits are combined in
            the integration worktree.
          </p>
          <ol>
            {data.sources.map((item: Json) => (
              <li key={item.taskId}>
                <strong>{item.title}</strong> <code>{item.head.slice(0, 12)}</code>
                <p>{item.summary}</p>
                {item.files && (
                  <details>
                    <summary>Changed files</summary>
                    <pre>{item.files}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {operation === 'mission/reviewPreview' && <pre>{data.text}</pre>}
      {conflict && (
        <>
          {!!data.conflicts.length && (
            <p className="muted">
              Resolve the files in your editor, refresh this preview, then stage each resolution.
            </p>
          )}
          <ul className="mission-conflicts">
            {data.conflicts.map((path: string) => (
              <li key={path}>
                <code>{path}</code>
                <button
                  disabled={busy}
                  onClick={() => void act('mission/stage', { ...params, path, conflict: data })}
                >
                  Stage resolution
                </button>
              </li>
            ))}
          </ul>
          {!data.conflicts.length && data.unstaged && (
            <p className="muted">Review and stage the remaining edits before continuing.</p>
          )}
          {!!data.patch && (
            <details>
              <summary>Staged changes</summary>
              <pre>{data.patch}</pre>
            </details>
          )}
          {abort ? (
            <div className="mission-abort">
              <p>
                Abort this merge and discard its resolution edits. Earlier integrated commits stay
                in the worktree.
              </p>
              <button
                className="danger"
                disabled={busy}
                onClick={() => void act('mission/abort', { ...params, conflict: data })}
              >
                Abort this merge
              </button>
            </div>
          ) : (
            <button
              className="quiet-button mission-abort-link"
              disabled={busy}
              onClick={() => setAbort(true)}
            >
              Abort merge…
            </button>
          )}
        </>
      )}
      <div className="mission-actions">
        {conflict && (
          <button disabled={busy || abort} onClick={refreshConflict}>
            Refresh conflict preview
          </button>
        )}
        <button disabled={busy} onClick={close}>
          Close preview
        </button>
        {!abort && (
          <button
            className="primary"
            disabled={busy || (conflict && (data.conflicts.length > 0 || data.unstaged))}
            onClick={() => void act(op, { ...params, [conflict ? 'conflict' : 'preview']: data })}
          >
            {label}
          </button>
        )}
      </div>
    </section>
  );
}
