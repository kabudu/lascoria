import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tasks,
  taskTitle,
  taskOwner,
  descendants,
  groupHidden,
  attentionOrder,
  nextAttention,
} from '../ui/model.ts';

test('task names come from the first meaningful line, cut at a word', () => {
  assert.equal(taskTitle('\n\n## Fix the *login* redirect\nmore'), 'Fix the login redirect');
  assert.equal(taskTitle('- [x]\n> `npm test` fails on CI'), 'npm test fails on CI');
  assert.equal(taskTitle('   \n---\n'), undefined);
  assert.equal(
    taskTitle('Run STAGE_B_TEST in _fixture_dir_ now'),
    'Run STAGE_B_TEST in fixture_dir now',
  );
  assert.equal(taskTitle('__Bold__ and _emphasis_'), 'Bold and emphasis');
  const long = taskTitle(
    'Refactor the session recovery path so that interrupted turns resume without replaying commands twice',
  );
  assert.ok(long.endsWith('…') && long.length <= 81 && !long.includes('  '), long);
  assert.ok(!/\s…$/.test(long));
  // An explicit name always wins over the derived one.
  const row = {
    id: 's',
    state: {
      turns: [{ turnId: 't1' }],
      items: [{ itemId: 'u', kind: 'userMessage', turnId: 't1', text: '# Add dark mode\nDetails' }],
    },
  };
  assert.equal(tasks(row, {})[0].label, 'Add dark mode');
  assert.equal(tasks(row, { labels: { 's:t1': 'Theme work' } })[0].label, 'Theme work');
});

const node = (id, extra = {}) => ({
  id,
  sessionId: 's',
  label: id,
  status: 'completed',
  provenance: 'native',
  ...extra,
});

test('ownership comes from native provenance and folding never hides attention', () => {
  const nodes = [
    node('turn', { provenance: 'derived', label: 'Fix login' }),
    node('sub', { parentId: 'turn', item: { kind: 'subagent' } }),
    node('flow', { parentId: 'turn', item: { kind: 'workflow' } }),
    node('step', { parentId: 'flow', nativeChild: { childId: 'c' } }),
    node('orphan', { parentId: 'missing', item: { kind: 'subagent' } }),
    // A cycle in parent links must not loop.
    node('x', { parentId: 'y' }),
    node('y', { parentId: 'x' }),
  ];
  assert.equal(taskOwner(nodes[0], nodes), 'Your task');
  assert.equal(taskOwner(nodes[1], nodes), 'Subagent of Fix login');
  assert.equal(taskOwner(nodes[3], nodes), 'Workflow step of flow');
  assert.equal(taskOwner(nodes[4], nodes), 'Subagent');
  assert.deepEqual(
    descendants(nodes, 'turn')
      .map((n) => n.id)
      .sort(),
    ['flow', 'step', 'sub'],
  );
  assert.deepEqual(
    descendants(nodes, 'x').map((n) => n.id),
    ['y'],
  );
  assert.deepEqual([...groupHidden(nodes, ['turn'], new Set())].sort(), ['flow', 'step', 'sub']);
  // A step that needs attention stays visible, and so does the chain above it.
  assert.deepEqual([...groupHidden(nodes, ['turn'], new Set(['step']))], ['sub']);
  assert.deepEqual([...groupHidden(nodes, ['gone'], new Set())], []);
});

test('the attention jump handles blocking work first and cycles through everything', () => {
  const queue = [
    { id: 'r', kind: 'review', sessionId: 'a', target: 'a:1' },
    { id: 'h', kind: 'interruption', sessionId: 'a', target: 'a:1', historical: true },
    { id: 'f', kind: 'failure', sessionId: 'b', target: 'b:2' },
    { id: 'q', kind: 'question', sessionId: 'b', target: 'b:3' },
    { id: 'p', kind: 'approval', sessionId: 'c', target: 'c:1' },
    { id: 'o', kind: 'interruption', sessionId: 'c', target: 'c:1' },
  ];
  assert.deepEqual(
    attentionOrder(queue).map((i) => i.id),
    ['p', 'q', 'f', 'o', 'r'],
  );
  const seen = [];
  let at;
  for (let i = 0; i < 6; i++) seen.push((at = nextAttention(queue, at?.id)).id);
  assert.deepEqual(seen, ['p', 'q', 'f', 'o', 'r', 'p']);
  assert.equal(nextAttention([], undefined), undefined);
  assert.equal(nextAttention(queue, 'unknown').id, 'p');
});
