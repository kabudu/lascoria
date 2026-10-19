import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tasks,
  nodeActivity,
  attention,
  questionAnswers,
  taskAttentionKey,
  constellationLayout,
  fitConstellation,
  freeCanvasFrame,
  zoomAtPoint,
  normalizedWheel,
  composeNotice,
  noticeKey,
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
  assert.equal(entry.historical, true);
  const offline = attention(
    { ...status, sessions: [{ ...row, state: { ...row.state, current: false } }] },
    {},
  ).find((entry) => entry.id === 's:offline');
  assert.equal(offline.historical, undefined);
  assert.equal(offline.label, 'Execution state unavailable');
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

test('cursor zoom keeps the same world point under the cursor at arbitrary offsets and clamps', () => {
  const anchor = { x: 213, y: 417 },
    camera = { zoom: 0.7, offset: { x: -110, y: 53 } };
  for (const requested of [0.0001, 0.45, 1.4, 100]) {
    const next = zoomAtPoint(camera, requested, anchor);
    assert.ok(next.zoom >= 0.02 && next.zoom <= 2);
    assert.ok(
      Math.abs(
        (anchor.x - camera.offset.x) / camera.zoom - (anchor.x - next.offset.x) / next.zoom,
      ) < 1e-8,
    );
    assert.ok(
      Math.abs(
        (anchor.y - camera.offset.y) / camera.zoom - (anchor.y - next.offset.y) / next.zoom,
      ) < 1e-8,
    );
  }
  assert.deepEqual(normalizedWheel(2, -3, 0, 900), { x: 2, y: -3 });
  assert.deepEqual(normalizedWheel(2, -3, 1, 900), { x: 32, y: -48 });
  assert.deepEqual(normalizedWheel(2, -3, 2, 900), { x: 1800, y: -2700 });
});

test('confirmed graceful logout is reviewable saved progress, not an execution failure', () => {
  const row = {
    id: 'session',
    lifecycle: 'connected',
    interruptions: [{ shutdown: { turnId: 'turn', cancellation: 'confirmed' } }],
    state: { current: true, items: [], turns: [{ turnId: 'turn', terminal: 'cancelled' }] },
  };
  const queue = attention({ sessions: [row] }, {});
  assert.ok(
    queue.some((entry) => entry.kind === 'review' && entry.label.startsWith('Inspect saved stop:')),
  );
  assert.ok(!queue.some((entry) => entry.kind === 'failure'));
  row.interruptions[0].shutdown.cancellation = 'unconfirmed';
  assert.ok(attention({ sessions: [row] }, {}).some((entry) => entry.kind === 'failure'));
});

test('canvas activity distinguishes work, tool use, attention and stale observation', () => {
  const task = { id: 's:t', sessionId: 's', turnId: 't', status: 'running' };
  const row = {
    lifecycle: 'connected',
    state: { current: true, items: [], userInputs: [], approvals: [] },
  };
  assert.deepEqual(nodeActivity(task, row), { label: 'Working', kind: 'working', busy: true });
  row.state.items.push({
    kind: 'toolCall',
    turnId: 't',
    status: 'inProgress',
    displayLabel: { active: 'Running tests' },
  });
  assert.equal(nodeActivity(task, row).label, 'Running tests');
  row.state.userInputs.push({ turnId: 't' });
  assert.deepEqual(nodeActivity(task, row), {
    label: 'Answer needed',
    kind: 'waiting',
    busy: false,
  });
  row.state.userInputs = [];
  row.state.approvals.push({ requested: { turnId: 't' } });
  assert.equal(nodeActivity(task, row).label, 'Permission needed');
  row.state.current = false;
  assert.deepEqual(nodeActivity(task, row), {
    label: 'Reconnecting',
    kind: 'unavailable',
    busy: false,
  });
  assert.equal(nodeActivity({ ...task, status: 'completed' }, row).label, 'completed');
});

test('desktop notices follow preferences, mute sessions and never include task or prompt text', () => {
  const secret = 'Rotate the production database password';
  const row = (id, state) => ({
    id,
    workspace: `/repo/${id}`,
    lifecycle: 'connected',
    state: { current: true, ...state },
  });
  const status = {
    pid: 1,
    commands: [],
    sessions: [
      row('a', {
        turns: [{ turnId: 't1', terminal: 'completed' }],
        items: [{ itemId: 'u1', kind: 'userMessage', turnId: 't1', text: secret }],
        userInputs: [{ userInputId: 'q1', turnId: 't1' }],
      }),
      row('b', {
        turns: [{ turnId: 't2', terminal: 'failed' }],
        approvals: [{ requested: { approvalId: 'p1', turnId: 't2' } }],
        // A failed Muse runtime reminder: listed in Attention, never a desktop alert.
        items: [{ itemId: 'r1', kind: 'reminderChild', status: 'failed', turnId: 't2' }],
      }),
      { ...row('c', {}), state: { current: false } },
    ],
  };
  const queue = attention(status, {});
  assert.ok(queue.some((item) => item.kind === 'failure' && item.id === 'b:r1'));
  const name = (id) => `Session ${id.toUpperCase()}`;
  // Off until the user enables it.
  assert.equal(composeNotice(queue, {}, name), null);
  const all = composeNotice(queue, { notifications: { enabled: true } }, name);
  // A session that is merely unavailable (reconnecting) is not announced.
  assert.equal(all.keys.length, 4);
  assert.ok(!all.keys.some((key) => key.endsWith(':offline')));
  assert.match(all.title, /^4 updates, 2 need you$/);
  assert.ok(!JSON.stringify(all).includes(secret));
  assert.ok(!JSON.stringify(all).includes('Rotate'));
  const onlyInput = composeNotice(
    queue,
    { notifications: { enabled: true, problems: false, finished: false, mutedSessions: ['b'] } },
    name,
  );
  assert.deepEqual(onlyInput, {
    keys: [noticeKey(queue.find((item) => item.kind === 'question'))],
    title: 'Muse has a question',
    body: 'Session: Session A',
  });
  const many = composeNotice(
    Array.from({ length: 30 }, (_, n) => ({
      id: `q${n}`,
      sessionId: 'a',
      target: 'x',
      kind: 'question',
      label: 'Answer required',
    })),
    { notifications: { enabled: true } },
    name,
  );
  assert.equal(many.keys.length, 20);
  assert.match(many.body, /and 27 more$/);
});
test('usage readings stay honest: readable durations, over-limit and reset-passed windows', async () => {
  const { allowanceFacts, readableDuration, usageWindow, USAGE_STALE_MS } =
    await import('../ui/model.ts');
  assert.equal(readableDuration(30_000), 'under a minute');
  assert.equal(readableDuration(61 * 60_000), '1 hour 1 minute');
  assert.equal(readableDuration(125 * 60_000), '2 hours 5 minutes');
  assert.equal(readableDuration((2 * 1440 + 180 + 7) * 60_000), '2 days 3 hours');
  assert.equal(usageWindow(300), '5-hour window');
  assert.equal(usageWindow(90), '1-hour 30-minute window');
  const now = 1_000_000_000;
  const over = allowanceFacts({ usedPercent: 125, resetsAtMs: now + 60 * 60_000 }, now, now);
  assert.deepEqual(
    [over.remaining, over.overLimit, over.reset, over.resetsIn, over.stale],
    [0, true, false, '1 hour', false],
  );
  const passed = allowanceFacts({ usedPercent: 40, resetsAtMs: now - 1 }, now - 2, now);
  assert.equal(passed.reset, true);
  assert.equal(passed.resetsIn, null);
  assert.equal(
    allowanceFacts({ usedPercent: 0, resetsAtMs: now + 1 }, now - USAGE_STALE_MS - 1, now).stale,
    true,
  );
});
test('token facts keep session totals, task figures, subagents and context apart', async () => {
  const { tokenFacts } = await import('../ui/model.ts');
  assert.deepEqual(tokenFacts(undefined, 't1'), {
    session: null,
    task: null,
    byModel: {},
    subagents: null,
    context: null,
  });
  const state = {
    sessionState: {
      'session/tokenUsage': {
        cumulative: {
          totalTokens: 900,
          promptTokens: 700,
          outputTokens: 200,
          cost: { usd: 0.0123, partial: true },
        },
      },
      'session/contextUsage': { usedTokens: 50_000, windowTokens: 200_000, pressure: 'normal' },
    },
    tokens: {
      byTurn: {
        t1: {
          calls: 2,
          promptTokens: 300,
          outputTokens: 100,
          totalTokens: 400,
          reasoningTokens: 0,
          cacheReadTokens: 0,
        },
      },
      byModel: { 'muse-wonder-1.0': { calls: 2, totalTokens: 400 } },
    },
    items: [
      { kind: 'subagent', turnId: 't1', usage: { inputTokens: 40, outputTokens: 10 } },
      { kind: 'subagent', turnId: 't2', usage: { inputTokens: 5, outputTokens: 5 } },
      { kind: 'subagent', turnId: 't1' },
    ],
  };
  const facts = tokenFacts(state, 't1');
  assert.equal(facts.session.totalTokens, 900);
  assert.equal(facts.session.cacheReadTokens, null, 'absent cache split stays unknown');
  assert.equal(facts.session.costPartial, true);
  assert.equal(facts.task.totalTokens, 400);
  assert.deepEqual(facts.subagents, { count: 1, tokens: 50 });
  assert.equal(facts.context.percent, 25);
  assert.equal(tokenFacts(state, 'unknown').task, null);
  assert.equal(
    tokenFacts({ sessionState: { 'session/contextUsage': { usedTokens: 5, pressure: 'normal' } } })
      .context.percent,
    null,
  );
});
test('efficiency alerts: budgets, repeated tool calls, context pressure and running tasks', async () => {
  const { efficiencyAlerts, runningTasks } = await import('../ui/model.ts');
  const call = (args) => ({ kind: 'toolCall', turnId: 't2', tool: 'bash', args });
  const state = {
    activeTurnId: 't2',
    turns: [{ turnId: 't1' }, { turnId: 't2' }],
    tokens: { byTurn: { t1: { totalTokens: 900_000 }, t2: { totalTokens: 120_000 } } },
    items: [
      call('{"cmd":"ls"}'),
      call('{"cmd":"ls"}'),
      call('{"cmd":"ls"}'),
      call('{"cmd":"pwd"}'),
    ],
    sessionState: { 'session/contextUsage': { pressure: 'warning' } },
  };
  const kinds = (prefs) => efficiencyAlerts(state, prefs).map((a) => a.kind);
  // Defaults: no budget; repeated calls and context pressure are warned about.
  assert.deepEqual(kinds(undefined), ['repeat', 'context']);
  assert.deepEqual(kinds({ taskBudget: 100_000, repeatThreshold: 0, suggestCompaction: false }), [
    'budget',
  ]);
  // Only the current task counts against the budget.
  assert.deepEqual(
    kinds({ taskBudget: 500_000, repeatThreshold: 0, suggestCompaction: false }),
    [],
  );
  assert.deepEqual(kinds({ repeatThreshold: 4, suggestCompaction: false }), []);
  assert.match(efficiencyAlerts(state, {})[0].message, /same bash call 3 times/);
  assert.deepEqual(efficiencyAlerts({}, { taskBudget: 1 }), []);
  assert.equal(
    runningTasks(
      [
        { id: 'a', state: { activeTurnId: 'x' } },
        { id: 'b', state: {} },
        { id: 'c', state: { activeTurnId: 'y' } },
      ],
      'a',
    ),
    1,
  );
});

test('action notices are plain sentences and never hide an unknown outcome', async () => {
  const { outcomeNotice } = await import('../ui/model.ts');
  assert.equal(outcomeNotice('workspace/commit', 'applied'), 'Commit done.');
  assert.equal(outcomeNotice('turn', 'accepted'), 'Task sent to Muse.');
  assert.equal(outcomeNotice('artifact/capture', undefined), 'Snapshot saved.');
  assert.match(outcomeNotice('workspace/discard', 'outcomeUnknown'), /unknown\. Check before/);
  assert.equal(outcomeNotice('relay/agentSend', 'rejected'), 'Request refused; nothing changed.');
  for (const status of ['applied', 'accepted', 'outcomeUnknown', undefined])
    assert.doesNotMatch(
      outcomeNotice('workspace/run', status),
      /workspace\/|applied|accepted|outcomeUnknown/,
    );
});

test('a requested skill is shown apart from what Muse reported about loading it', async () => {
  const { skillRequest } = await import('../ui/model.ts');
  const ask = { kind: 'userMessage', text: '/release-notes for 1.0', turnId: 't1' };
  const read = (status, extra = {}) => ({
    kind: 'skillRead',
    turnId: 't1',
    selector: 'release-notes',
    source: 'user',
    status,
    ...extra,
  });
  const settled = { reported: true, settled: true };
  assert.deepEqual(skillRequest(ask, [read('completed')], settled), {
    selector: 'release-notes',
    observed: 'Muse reported loading it from user',
    reported: true,
  });
  assert.match(
    skillRequest(ask, [read('inProgress')], { reported: true, settled: false }).observed,
    /is loading it/,
  );
  // No evidence is unknown, not a claim that the skill was skipped.
  for (const items of [
    [],
    [read('completed', { turnId: 'other' })],
    [read('completed', { selector: 'x' })],
  ])
    assert.equal(
      skillRequest(ask, items, settled).observed,
      'Muse did not report loading it; that does not show whether it ran',
    );
  assert.equal(
    skillRequest(ask, [], { reported: true, settled: false }).observed,
    'Not reported as loaded yet',
  );
  assert.equal(
    skillRequest(ask, [], { reported: false, settled: true }).observed,
    'This Muse host does not report skill loading',
  );
  // Missing native turn identities must not associate unrelated historical items.
  assert.equal(
    skillRequest({ ...ask, turnId: undefined }, [read('completed', { turnId: undefined })], settled)
      .reported,
    false,
  );
  // Plain text, the local /usage command and Muse's own messages are not skill requests.
  for (const item of [
    { kind: 'userMessage', text: 'Write notes', turnId: 't1' },
    { kind: 'userMessage', text: '/usage', turnId: 't1' },
    { kind: 'agentMessage', text: '/release-notes', turnId: 't1' },
  ])
    assert.equal(skillRequest(item, [read('completed')], settled), null);
});
