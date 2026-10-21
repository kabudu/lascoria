import test from 'node:test';
import assert from 'node:assert/strict';
import { staple } from '../scripts/staple-macos.js';

test('stapling retries a failed ticket fetch, stops after success and preserves arguments', async () => {
  const args = ['stapler', 'staple', '-v', 'Lascoria.app'];
  const calls = [];
  const delays = [];
  assert.equal(
    await staple(args, {
      run: (received) => {
        calls.push(received);
        return { status: calls.length === 1 ? 65 : 0 };
      },
      pause: async (ms) => delays.push(ms),
    }),
    0,
  );
  assert.equal(calls.length, 2);
  assert(calls.every((received) => received === args));
  assert.deepEqual(delays, [5000]);
});

test('stapling bounds failures/timeouts and cannot dispatch another xcrun command', async () => {
  let calls = 0;
  const delays = [];
  assert.equal(
    await staple(['stapler', 'staple', 'Lascoria.app'], {
      run: () => {
        calls++;
        return { status: null, error: Error('timed out') };
      },
      pause: async (ms) => delays.push(ms),
    }),
    1,
  );
  assert.equal(calls, 3);
  assert.deepEqual(delays, [5000, 10000]);
  await assert.rejects(staple(['notarytool', 'submit']), /only handles ticket stapling/);
});
