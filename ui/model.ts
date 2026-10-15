import type { SessionRow, Task, Prefs, Status } from './types';
export function tasks(session: SessionRow, prefs: Prefs): Task[] {
  const turns = (session.state.turns ?? []).map((turn) => {
    const prompt = session.state.items?.find(
      (i) => i.turnId === turn.turnId && i.kind === 'userMessage',
    );
    const id = `${session.id}:${turn.turnId}`;
    return {
      id,
      sessionId: session.id,
      turnId: turn.turnId,
      label:
        prefs.labels?.[id] ??
        prompt?.text?.trim().split('\n')[0]?.slice(0, 100) ??
        `Turn ${turn.turnId.slice(-8)}`,
      status: turn.terminal ?? 'running',
      error: turn.error,
      provenance: 'derived' as const,
    };
  });
  const children = (session.state.items ?? [])
    .filter((item) => ['subagent', 'workflow', 'reminderChild'].includes(item.kind))
    .map((item) => {
      const id = `${session.id}:${item.itemId}`;
      return {
        id,
        sessionId: session.id,
        turnId: item.turnId,
        item,
        label: prefs.labels?.[id] ?? item.objective ?? item.label ?? item.entryId ?? item.kind,
        status: item.status,
        provenance: 'native' as const,
        parentId: item.turnId ? `${session.id}:${item.turnId}` : undefined,
        childSessionId: item.childSessionId,
      };
    });
  const workflowChildren = children.flatMap((parent) =>
    (parent.item?.children ?? []).map((child: any) => ({
      id: `${parent.id}:${child.childId}:${child.attempt}`,
      sessionId: session.id,
      turnId: parent.turnId,
      label:
        prefs.labels?.[`${parent.id}:${child.childId}:${child.attempt}`] ??
        child.label ??
        `Workflow child ${child.childId.slice(-8)}`,
      status: child.failureKind ? 'failed' : (child.terminal ?? child.status),
      provenance: 'native' as const,
      parentId: parent.id,
      item: parent.item,
      nativeChild: child,
    })),
  );
  return [...turns, ...children, ...workflowChildren];
}
export function taskAttentionKey(task: Task) {
  return JSON.stringify([
    task.id,
    task.status,
    task.item?.revision ?? 0,
    task.nativeChild?.attempt ?? 0,
    task.nativeChild?.failureKind ?? task.error?.kind ?? null,
  ]);
}
export function attention(status: Status, prefs: Prefs) {
  return status.sessions.flatMap((session) => {
    const nodes = tasks(session, prefs);
    const unseen = (task: Task) => !prefs.acknowledgedTaskFacts?.includes(taskAttentionKey(task));
    const gracefulStop = (task: Task) =>
      task.status === 'cancelled' &&
      !task.item &&
      [
        session.state.shutdown,
        ...(session.interruptions ?? []).map((entry) => entry.shutdown),
      ].some((stop) => stop?.turnId === task.turnId && stop.cancellation === 'confirmed');
    const target = (turnId?: string) => nodes.find((t) => t.turnId === turnId)?.id ?? nodes[0]?.id;
    return [
      ...(session.interruptions ?? [])
        .filter(
          (i) =>
            !prefs.acknowledgedInterruptions?.includes(
              session.id + ':interrupt:' + i.atMillis + ':' + i.kind,
            ),
        )
        .map((i) => ({
          id: session.id + ':interrupt:' + i.atMillis + ':' + i.kind,
          sessionId: session.id,
          target: target(),
          kind: 'interruption',
          historical: true,
          label: 'Runtime interruption: ' + i.kind,
        })),
      ...(!session.state.current || session.lifecycle === 'interrupted'
        ? [
            {
              id: `${session.id}:offline`,
              sessionId: session.id,
              target: target(),
              kind: 'interruption',
              label: session.recoveryError ?? 'Execution state unavailable',
            },
          ]
        : []),
      ...(session.state.approvals ?? []).map((a) => ({
        id: a.requested.approvalId,
        sessionId: session.id,
        target: target(a.requested.turnId),
        kind: 'approval',
        label: 'Permission decision required',
      })),
      ...(session.state.userInputs ?? []).map((a) => ({
        id: a.userInputId,
        sessionId: session.id,
        target: target(a.turnId),
        kind: 'question',
        label: 'Answer required',
      })),
      ...nodes
        .filter(
          (t) =>
            unseen(t) &&
            ['failed', 'rejected', 'cancelled'].includes(t.status) &&
            !gracefulStop(t) &&
            (t.item?.kind !== 'reminderChild' ||
              t.status !== 'cancelled' ||
              prefs.showRuntimeReminders),
        )
        .map((t) => ({
          id: t.id,
          sessionId: session.id,
          target: t.id,
          kind: 'failure',
          label: t.label,
        })),
      ...nodes
        .filter(
          (t) =>
            unseen(t) &&
            (t.status === 'completed' || gracefulStop(t)) &&
            (t.item?.kind !== 'reminderChild' || prefs.showRuntimeReminders),
        )
        .map((t) => ({
          id: `${t.id}:review`,
          sessionId: session.id,
          target: t.id,
          kind: 'review',
          label: `${gracefulStop(t) ? 'Inspect saved stop' : 'Inspect completion'}: ${t.label}`,
        })),
    ];
  });
}

export function questionAnswers(
  questions: import('@muse-code/sdk/dist/src/msp.js').UserInputQuestion[],
  data: FormData,
) {
  return questions.map((q) => ({
    questionId: q.id,
    ...(q.options.length
      ? q.selection.mode === 'multiple'
        ? { selectedLabels: data.getAll(q.id).map(String) }
        : { selectedLabel: String(data.get(q.id)) }
      : { freeText: String(data.get(q.id)) }),
  }));
}

// Pack native ownership trees into non-overlapping shelves. Missing parents and
// cycles are retained as visible roots; presentation never invents relationships.
export function constellationLayout(nodes: Task[], width: number, left = 300, right = 460) {
  const columns = Math.max(1, Math.floor((width - left - right) / 260));
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string, Task[]>();
  for (const node of nodes)
    if (node.parentId && ids.has(node.parentId)) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  const roots = nodes.filter((node) => !node.parentId || !ids.has(node.parentId));
  roots.sort((a, b) => (children.get(b.id)?.length ?? 0) - (children.get(a.id)?.length ?? 0));
  const placed = new Set<string>();
  const result: Record<string, { x: number; y: number }> = {};
  let shelfX = 0,
    shelfY = 180,
    shelfHeight = 0;
  for (const root of [...roots, ...nodes]) {
    if (placed.has(root.id)) continue;
    const levels: Task[][] = [];
    let level = [root];
    while (level.length) {
      const fresh = level.filter((node) => !placed.has(node.id));
      if (!fresh.length) break;
      fresh.forEach((node) => placed.add(node.id));
      levels.push(fresh);
      level = fresh.flatMap((node) => children.get(node.id) ?? []);
    }
    const span = Math.min(columns, Math.max(...levels.map((level) => level.length)));
    if (shelfX + span > columns) {
      shelfX = 0;
      shelfY += shelfHeight + 60;
      shelfHeight = 0;
    }
    let row = 0;
    for (const level of levels) {
      level.forEach((node, index) => {
        const count = Math.min(span, level.length - Math.floor(index / span) * span);
        result[node.id] = {
          x: left + (shelfX + (span - count) / 2 + (index % span)) * 260,
          y: shelfY + (row + Math.floor(index / span)) * 180,
        };
      });
      row += Math.ceil(level.length / span);
    }
    shelfHeight = Math.max(shelfHeight, row * 180);
    shelfX += span;
  }
  return result;
}

export interface CanvasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}
export function freeCanvasFrame(
  width: number,
  height: number,
  obstacles: CanvasFrame[],
): CanvasFrame {
  const xs = [0, width],
    ys = [0, height];
  for (const box of obstacles) {
    xs.push(Math.max(0, Math.min(width, box.x)), Math.max(0, Math.min(width, box.x + box.width)));
    ys.push(
      Math.max(0, Math.min(height, box.y)),
      Math.max(0, Math.min(height, box.y + box.height)),
    );
  }
  const xEdges = [...new Set(xs)].sort((a, b) => a - b),
    yEdges = [...new Set(ys)].sort((a, b) => a - b);
  let best: CanvasFrame = { x: 0, y: 0, width: 0, height: 0 };
  for (let a = 0; a < xEdges.length; a++)
    for (let b = a + 1; b < xEdges.length; b++)
      for (let c = 0; c < yEdges.length; c++)
        for (let d = c + 1; d < yEdges.length; d++) {
          const candidate = {
            x: xEdges[a],
            y: yEdges[c],
            width: xEdges[b] - xEdges[a],
            height: yEdges[d] - yEdges[c],
          };
          if (
            candidate.width * candidate.height <= best.width * best.height ||
            candidate.width < 100 ||
            candidate.height < 100
          )
            continue;
          if (
            obstacles.some(
              (box) =>
                candidate.x < box.x + box.width &&
                candidate.x + candidate.width > box.x &&
                candidate.y < box.y + box.height &&
                candidate.y + candidate.height > box.y,
            )
          )
            continue;
          best = candidate;
        }
  return best;
}
export function fitConstellation(
  points: { x: number; y: number }[],
  width: number,
  height: number,
  frame: CanvasFrame = { x: 0, y: 166, width, height: height - 166 },
) {
  if (!points.length) return { zoom: 1, offset: { x: 0, y: 0 } };
  const minX = Math.min(...points.map((p) => p.x)),
    minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x + 220)),
    maxY = Math.max(...points.map((p) => p.y + 140));
  const zoom = Math.max(
    0.02,
    Math.min(2, (frame.width - 48) / (maxX - minX), (frame.height - 48) / (maxY - minY)),
  );
  return {
    zoom,
    offset: {
      x: frame.x + (frame.width - (maxX - minX) * zoom) / 2 - minX * zoom,
      y: frame.y + (frame.height - (maxY - minY) * zoom) / 2 - minY * zoom,
    },
  };
}

export interface CanvasCamera {
  zoom: number;
  offset: { x: number; y: number };
}
export function zoomAtPoint(
  camera: CanvasCamera,
  requested: number,
  anchor: { x: number; y: number },
): CanvasCamera {
  const zoom = Math.max(0.02, Math.min(2, requested));
  const ratio = zoom / camera.zoom;
  return {
    zoom,
    offset: {
      x: anchor.x - (anchor.x - camera.offset.x) * ratio,
      y: anchor.y - (anchor.y - camera.offset.y) * ratio,
    },
  };
}
export function normalizedWheel(x: number, y: number, mode: number, height: number) {
  const factor = mode === 1 ? 16 : mode === 2 ? height : 1;
  return { x: x * factor, y: y * factor };
}

/** Activity is an observation, never a percentage or an inferred model thought. */
export function nodeActivity(task: Task, session: SessionRow, connected = true) {
  const active = ['running', 'inProgress', 'pending', 'queued'].includes(task.status);
  if (!active) return { label: task.status, kind: task.status, busy: false };
  if (!connected || !session.state.current || session.lifecycle !== 'connected')
    return { label: 'Reconnecting', kind: 'unavailable', busy: false };
  if (!task.item) {
    if ((session.state.userInputs ?? []).some((input) => input.turnId === task.turnId))
      return { label: 'Answer needed', kind: 'waiting', busy: false };
    if (
      (session.state.approvals ?? []).some((approval) => approval.requested.turnId === task.turnId)
    )
      return { label: 'Permission needed', kind: 'waiting', busy: false };
  }
  if (['pending', 'queued'].includes(task.status))
    return { label: 'Queued', kind: 'waiting', busy: false };
  const tool =
    !task.item &&
    (session.state.items ?? []).findLast(
      (item) =>
        item.turnId === task.turnId && item.kind === 'toolCall' && item.status === 'inProgress',
    );
  const detail =
    tool && (typeof tool.displayLabel === 'object' ? tool.displayLabel?.active : tool.displayLabel);
  return {
    label: typeof detail === 'string' && detail.trim() ? detail.slice(0, 96) : 'Working',
    kind: 'working',
    busy: true,
  };
}
