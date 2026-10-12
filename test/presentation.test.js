import test from 'node:test';
import assert from 'node:assert/strict';
import { tasks, attention, questionAnswers } from '../ui/model.ts';
test('presentation preserves native workflow failure and never infers dependency or verification', () => {
  const row = {
    id: 'session',
    workspace: '/repo',
    lifecycle: 'connected',
    state: {
      current: true,
      items: [
        {
          itemId: 'workflow',
          revision: 7,
          kind: 'workflow',
          status: 'completed',
          turnId: 'turn',
          children: [
            {
              childId: 'child',
              attempt: 1,
              terminal: 'completed',
              failureKind: 'child_result_missing',
            },
          ],
        },
      ],
      turns: [{ turnId: 'turn', terminal: 'completed' }],
      approvals: [],
      userInputs: [],
    },
  };
  const nodes = tasks(row, {});
  assert.equal(nodes[0].provenance, 'derived');
  const child = nodes.find((node) => node.nativeChild);
  assert.equal(child.status, 'failed');
  assert.equal(child.parentId, 'session:workflow');
  assert.equal(child.item.revision, 7);
  const queue = attention({ sessions: [row], commands: [], pid: 1 }, {});
  assert.ok(queue.some((entry) => entry.kind === 'failure' && entry.target === child.id));
  assert.ok(queue.some((entry) => entry.kind === 'review'));
  assert.equal(child.childSessionId, undefined, 'child ID is not invented as a session ID');
  assert.deepEqual(
    nodes.map((node) => node.id),
    tasks(row, { labels: { 'session:turn': 'User title' } }).map((node) => node.id),
    'labels do not change identity',
  );
});

test('recovered interruptions remain in attention until acknowledged without changing execution', () => {
  const row = {
    id: 's',
    workspace: '/repo',
    lifecycle: 'connected',
    interruptions: [{ kind: 'crash', atMillis: 10 }],
    state: { current: true, items: [], turns: [], approvals: [], userInputs: [] },
  };
  const status = { sessions: [row], commands: [], pid: 1 };
  const entry = attention(status, {}).find((entry) => entry.kind === 'interruption');
  assert.equal(entry.label, 'Runtime interruption: crash');
  assert.equal(attention(status, { acknowledgedInterruptions: [entry.id] }).length, 0);
  assert.equal(row.interruptions.length, 1);
  assert.equal(row.state.current, true);
});

test('question answers use the native nested selection mode and preserve all selected labels', () => {
  const data = new FormData();
  data.append('one', 'Alpha');
  data.append('many', 'Alpha');
  data.append('many', 'Beta');
  data.append('free', 'Explanation');
  const question = (id, mode, options) => ({
    id,
    header: 'Choice',
    question: 'Choose',
    selection: { mode },
    options,
  });
  const options = [
    { label: 'Alpha', description: 'First' },
    { label: 'Beta', description: 'Second' },
  ];
  assert.deepEqual(
    questionAnswers(
      [
        question('one', 'single', options),
        question('many', 'multiple', options),
        question('free', 'single', []),
      ],
      data,
    ),
    [
      { questionId: 'one', selectedLabel: 'Alpha' },
      { questionId: 'many', selectedLabels: ['Alpha', 'Beta'] },
      { questionId: 'free', freeText: 'Explanation' },
    ],
  );
});
