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
      label: prefs.labels?.[id] ?? prompt?.text?.slice(0, 100) ?? `Turn ${turn.turnId.slice(-8)}`,
      status: turn.terminal ?? 'running',
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
        label: prefs.labels?.[id] ?? item.objective ?? item.label ?? item.kind,
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
export function attention(status: Status, prefs: Prefs) {
  return status.sessions.flatMap((session) => {
    const nodes = tasks(session, prefs);
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
        .filter((t) => ['failed', 'rejected', 'cancelled'].includes(t.status))
        .map((t) => ({
          id: t.id,
          sessionId: session.id,
          target: t.id,
          kind: 'failure',
          label: t.label,
        })),
      ...nodes
        .filter((t) => t.status === 'completed')
        .map((t) => ({
          id: `${t.id}:review`,
          sessionId: session.id,
          target: t.id,
          kind: 'review',
          label: `Inspect completion: ${t.label}`,
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
