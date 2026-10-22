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

const { notarize } = await import('../scripts/notarize-macos.js');
const credentials = {
  APPLE_ID: 'fixture@example.invalid',
  APPLE_PASSWORD: 'fixture-private-value',
  APPLE_TEAM_ID: 'fixture-team',
};
test('final disk image notarization requires explicit acceptance and bounds its subprocess', () => {
  let options;
  notarize('/fixture/Lascoria.dmg', {
    env: credentials,
    run: (command, args, settings) => {
      assert.equal(command, '/usr/bin/xcrun');
      assert.deepEqual(args.slice(0, 3), ['notarytool', 'submit', '/fixture/Lascoria.dmg']);
      options = settings;
      return { status: 0, stdout: '{"status":"Accepted"}' };
    },
  });
  assert.equal(options.timeout, 720000);
  assert.equal(options.maxBuffer, 2097152);
  for (const result of [
    { status: 0, stdout: '{"status":"Invalid"}' },
    { status: 0, stdout: 'invalid response' },
    { status: null, error: Error(credentials.APPLE_PASSWORD), stdout: '' },
  ]) {
    assert.throws(
      () => notarize('/fixture/Lascoria.dmg', { env: credentials, run: () => result }),
      (error) => {
        assert(!error.message.includes(credentials.APPLE_PASSWORD));
        return /did not accept/.test(error.message);
      },
    );
  }
  assert.throws(
    () =>
      notarize('/fixture/Lascoria.dmg', {
        env: credentials,
        run: () => {
          throw Error(credentials.APPLE_PASSWORD);
        },
      }),
    /^Error: Apple notarization command failed$/,
  );
});
