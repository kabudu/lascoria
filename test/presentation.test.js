import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tasks,
  attention,
  questionAnswers,
  taskAttentionKey,
  constellationLayout,
  fitConstellation,
  freeCanvasFrame,
} from '../ui/model.ts';
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

test('constellation layout keeps ownership levels below parents without overlap and retains cycles/orphans', () => {
  const nodes = [
    { id: 'root' },
    { id: 'workflow', parentId: 'root' },
    ...Array.from({ length: 5 }, (_, i) => ({ id: 'child' + i, parentId: 'workflow' })),
    { id: 'standalone' },
    { id: 'orphan', parentId: 'missing' },
    { id: 'cycle-a', parentId: 'cycle-b' },
    { id: 'cycle-b', parentId: 'cycle-a' },
  ];
  for (const width of [800, 1440, 2200]) {
    const layout = constellationLayout(nodes, width);
    assert.equal(Object.keys(layout).length, nodes.length);
    assert.ok(layout.workflow.y > layout.root.y);
    for (let i = 0; i < 5; i++) assert.ok(layout['child' + i].y > layout.workflow.y);
    for (const [index, a] of nodes.entries()) {
      const p = layout[a.id];
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(p.x + 220 <= width);
      for (const b of nodes.slice(index + 1)) {
        const q = layout[b.id];
        assert.ok(Math.abs(p.x - q.x) >= 220 || Math.abs(p.y - q.y) >= 114);
      }
    }
  }
});

test('fit frames visible moved nodes without mutating positions, including distant pins', () => {
  const points = [
    { x: 300, y: 180 },
    { x: 12000, y: 12000 },
  ];
  const original = structuredClone(points);
  for (const [width, height] of [
    [800, 600],
    [1440, 940],
  ]) {
    const fit = fitConstellation(points, width, height);
    for (const point of points) {
      assert.ok(point.x * fit.zoom + fit.offset.x >= 0);
      assert.ok((point.x + 220) * fit.zoom + fit.offset.x <= width);
      assert.ok(point.y * fit.zoom + fit.offset.y >= 190);
      assert.ok((point.y + 140) * fit.zoom + fit.offset.y <= height);
    }
  }
  assert.deepEqual(points, original);
  assert.deepEqual(fitConstellation([], 800, 600), { zoom: 1, offset: { x: 0, y: 0 } });
});

test('fit uses free canvas space around moved floating panels', () => {
  const obstacles = [
    { x: 0, y: 0, width: 260, height: 940 },
    { x: 1000, y: 0, width: 440, height: 940 },
    { x: 260, y: 0, width: 740, height: 180 },
  ];
  const frame = freeCanvasFrame(1440, 940, obstacles);
  assert.deepEqual(frame, { x: 260, y: 180, width: 740, height: 760 });
  const point = { x: 1000, y: 2000 };
  const fit = fitConstellation([point], 1440, 940, frame);
  assert.ok(point.x * fit.zoom + fit.offset.x >= frame.x);
  assert.ok((point.x + 220) * fit.zoom + fit.offset.x <= frame.x + frame.width);
  assert.ok(point.y * fit.zoom + fit.offset.y >= frame.y);
  assert.ok((point.y + 140) * fit.zoom + fit.offset.y <= frame.y + frame.height);
});
