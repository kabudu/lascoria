import test from 'node:test';
import assert from 'node:assert/strict';
import { tasks, attention, questionAnswers, taskAttentionKey } from '../ui/model.ts';
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

test('failed turn retains the native error and does not equate connectivity with success', () => {
  const error = { kind: 'authRequired', message: 'not logged in', retryable: false };
  const row = {
    id: 's',
    lifecycle: 'connected',
    state: {
      current: true,
      items: [],
      turns: [{ turnId: 't', terminal: 'failed', error }],
      approvals: [],
      userInputs: [],
    },
  };
  assert.deepEqual(tasks(row, {})[0].error, error);
  assert.equal(attention({ sessions: [row] }, {})[0].kind, 'failure');
});

test('routine reminders stay inspectable without flooding attention; failed reminders stay visible', () => {
  const row = {
    id: 's',
    lifecycle: 'connected',
    state: {
      current: true,
      turns: [],
      approvals: [],
      userInputs: [],
      items: ['completed', 'cancelled', 'failed'].map((status) => ({
        itemId: status,
        kind: 'reminderChild',
        status,
        revision: 1,
      })),
    },
  };
  assert.equal(tasks(row, {}).length, 3);
  assert.deepEqual(
    attention({ sessions: [row] }, {}).map((e) => e.target),
    ['s:failed'],
  );
  assert.equal(attention({ sessions: [row] }, { showRuntimeReminders: true }).length, 3);
});

test('multiline task briefs use their first line as a derived label', () => {
  const row = {
    id: 's',
    state: {
      turns: [{ turnId: 't', terminal: 'completed' }],
      items: [
        {
          itemId: 'i',
          kind: 'userMessage',
          turnId: 't',
          text: 'Audit dispatch queue\nDetailed instructions',
        },
      ],
    },
  };
  assert.equal(tasks(row, {})[0].label, 'Audit dispatch queue');
});

test('inspection acknowledgements clear attention without changing execution or accepting later revisions', () => {
  const row = {
    id: 's',
    state: {
      current: true,
      turns: [],
      approvals: [],
      userInputs: [],
      items: [
        { itemId: 'w', kind: 'workflow', entryId: 'Audit', status: 'completed', revision: 2 },
      ],
    },
  };
  const prefs = { acknowledgedTaskFacts: [taskAttentionKey(tasks(row, {})[0])] };
  assert.equal(attention({ sessions: [row] }, prefs).length, 0);
  assert.equal(row.state.items[0].status, 'completed');
  assert.equal(tasks(row, prefs).length, 1);
  row.state.items[0].revision = 3;
  assert.equal(attention({ sessions: [row] }, prefs)[0].kind, 'review');
});

test('inspection acknowledgement never hides or reroutes a pending question', () => {
  const row = {
    id: 's',
    state: {
      current: true,
      items: [],
      approvals: [],
      turns: [
        { turnId: 't', terminal: 'completed' },
        { turnId: 'other', terminal: 'completed' },
      ],
      userInputs: [{ userInputId: 'q', turnId: 't' }],
    },
  };
  const prefs = { acknowledgedTaskFacts: [taskAttentionKey(tasks(row, {})[0])] };
  assert.equal(
    attention({ sessions: [row] }, prefs).find((e) => e.kind === 'question').target,
    's:t',
  );
});
