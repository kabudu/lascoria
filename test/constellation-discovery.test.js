import test from 'node:test';
import assert from 'node:assert/strict';
import { vacantCard, sessionSequence, intersects } from '../ui/constellation.ts';
test('session order is context without invented parents or cross-session links', () => {
  const root = (id, sessionId = 'one') => ({ id, sessionId, provenance: 'derived' });
  const nodes = [
    root('a'),
    { id: 'child', sessionId: 'one', parentId: 'a', provenance: 'native', item: {} },
    root('b'),
    root('c', 'two'),
  ];
  assert.deepEqual(
    sessionSequence(nodes).map((e) => [e.from.id, e.to.id]),
    [['a', 'b']],
  );
  assert(nodes.every((n) => n.id === 'child' || !n.parentId));
});
test('viewport packing finds narrow exact-fit gaps, respects obstacles and reports genuine exhaustion', () => {
  const frame = { x: 12, y: 12, width: 700, height: 500 };
  const obstacles = [
    { x: 12, y: 12, width: 230, height: 500 },
    { x: 465, y: 12, width: 247, height: 500 },
  ];
  const slot = vacantCard(frame, obstacles, 220, 140);
  assert(slot);
  assert(slot.x >= 242 && slot.x + 220 <= 465);
  assert(!obstacles.some((o) => intersects({ ...slot, width: 220, height: 140 }, o)));
  assert.equal(vacantCard(frame, [{ ...frame }], 220, 140), null);
  assert.equal(vacantCard({ ...frame, width: 219 }, [], 220, 140), null);
});
test('packing agrees with exhaustive integer search for adversarial small viewports', () => {
  let seed = 13;
  const rand = (n) => {
    seed = (seed * 16807) % 2147483647;
    return seed % n;
  };
  for (let i = 0; i < 150; i++) {
    const frame = { x: 0, y: 0, width: 20, height: 16 };
    const blocks = Array.from({ length: 5 }, () => ({
      x: rand(24) - 2,
      y: rand(20) - 2,
      width: rand(8) + 1,
      height: rand(8) + 1,
    }));
    let exists = false;
    for (let x = 0; x <= 15; x++)
      for (let y = 0; y <= 12; y++)
        if (!blocks.some((o) => intersects({ x, y, width: 5, height: 4 }, o))) exists = true;
    const slot = vacantCard(frame, blocks, 5, 4);
    assert.equal(Boolean(slot), exists);
    if (slot) assert(!blocks.some((o) => intersects({ ...slot, width: 5, height: 4 }, o)));
  }
});
