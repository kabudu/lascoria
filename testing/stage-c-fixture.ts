import type { Status, Item } from '../ui/types';
// Synthetic projection fixture, deliberately separate from runtime scale proof.
export function stageCFixture() {
  const history: Item[] = Array.from({ length: 100000 }, (_, i) => ({
    itemId: `history-${i}`,
    kind: 'agentMessage',
    status: 'completed',
    revision: 1,
    turnId: `turn-${i % 50}`,
    text: `History record ${i}`,
  }));
  const status: Status = {
    pid: 1,
    features: ['modelSelection', 'diagnostics'],
    commands: [],
    sessions: Array.from({ length: 10 }, (_, s) => ({
      id: `session-${s}`,
      workspace: `/benchmark/repo-${s}`,
      generation: 1,
      lifecycle: 'connected',
      interruptions: [],
      state: {
        current: true,
        totalItems: 10000,
        items: Array.from({ length: 50 }, (_, t) => ({
          itemId: `prompt-${t}`,
          kind: 'userMessage',
          status: 'completed',
          revision: 1,
          turnId: `turn-${t}`,
          text: `Task ${t}: verify causal boundary ${s}`,
        })),
        turns: Array.from({ length: 50 }, (_, t) => ({
          turnId: `turn-${t}`,
          terminal: t === 0 ? 'failed' : 'completed',
        })),
        approvals: [],
        userInputs: [],
      },
    })),
  };
  return { history, status };
}
