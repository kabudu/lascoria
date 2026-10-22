import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTicket } from '../scripts/verify-macos-ticket.js';

test('ticket verification recovers from CloudKit resets without changing its file or accepting a failure', async () => {
  const calls = [],
    delays = [];
  await verifyTicket('/fixture with spaces/Lascoria.app', {
    run: (args) => {
      calls.push(args);
      return { status: calls.length < 3 ? 68 : 0 };
    },
    pause: async (ms) => delays.push(ms),
  });
  assert.equal(calls.length, 3);
  for (const args of calls)
    assert.deepEqual(args, ['stapler', 'validate', '/fixture with spaces/Lascoria.app']);
  assert.deepEqual(delays, [5000, 10000]);
});

test('ticket verification refuses invalid tickets immediately and bounds transport failures', async () => {
  let calls = 0;
  await assert.rejects(
    verifyTicket('/fixture.dmg', {
      run: () => {
        calls++;
        return { status: 65 };
      },
      pause: async () => assert.fail('Invalid ticket must not be retried'),
    }),
    /validation failed/,
  );
  assert.equal(calls, 1);
  for (const result of [{ status: 68 }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    calls = 0;
    const delays = [];
    await assert.rejects(
      verifyTicket('/fixture.dmg', {
        run: () => {
          calls++;
          return result;
        },
        pause: async (ms) => delays.push(ms),
      }),
      /validation failed/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [5000, 10000]);
  }
});
