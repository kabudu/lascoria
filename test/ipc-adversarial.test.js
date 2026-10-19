import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// R12: hostile or broken local clients. Every case must end in a refusal or a closed
// connection, never a crash, a hang of other clients or a state change.
test(
  'malformed, oversized, unauthenticated and slow IPC requests are refused without harm',
  { timeout: 60000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-ipc-hostile-'));
    const directory = join(root, 'state');
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        SCH_STATE_DIR: directory,
        SCH_PROVIDER: 'echo',
        XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'),
        XDG_CACHE_HOME: join(root, 'cache'),
      },
      stdio: 'ignore',
    });
    t.after(async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exit = new Promise((r) => daemon.once('exit', r));
        daemon.kill('SIGTERM');
        await bounded(exit, 10000).catch(() => daemon.kill('SIGKILL'));
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    let before;
    for (let i = 0; i < 100 && !before; i++) {
      before = await request(directory, 'status').catch(() => undefined);
      if (!before || before.pid !== daemon.pid) before = undefined;
      await delay(100);
    }
    assert.ok(before, 'supervisor ready');
    if (process.platform === 'win32') return; // Named-pipe variants are covered natively.
    const socket = join(directory, 'supervisor.sock');
    const token = readFileSync(join(directory, 'token'), 'utf8');

    /** Send raw bytes; resolve with whatever comes back before the server closes. */
    const raw = (bytes, { end = true, wait = 8000 } = {}) =>
      bounded(
        new Promise((resolveRaw) => {
          const client = net.createConnection(socket);
          let data = '';
          client.setEncoding('utf8');
          client.on('error', () => resolveRaw({ data, error: true }));
          client.on('data', (chunk) => (data += chunk));
          client.on('close', () => resolveRaw({ data }));
          client.on('connect', () => {
            if (bytes !== null) client.write(bytes);
            if (end) client.end();
          });
        }),
        wait,
      );
    const healthy = async () => {
      const s = await request(directory, 'status');
      assert.equal(s.pid, daemon.pid, 'the same supervisor still answers');
      assert.equal(s.sessions.length, 0, 'no state was created');
      assert.equal(s.commands.length, 0, 'no command was journalled');
    };
    const refused = (result) =>
      assert.ok(
        result.error || result.data === '' || 'error' in JSON.parse(result.data),
        `refused: ${result.data.slice(0, 200)}`,
      );

    const cases = {
      notJson: 'this is not json\n',
      truncatedJson: '{"version":1,"token":\n',
      invalidUtf8: Buffer.concat([
        Buffer.from('{"version":1,"token":"'),
        Buffer.from([0xff, 0xfe]),
        Buffer.from('"}\n'),
      ]),
      noToken: JSON.stringify({ version: 1, id: 'x', operation: 'status' }) + '\n',
      wrongToken:
        JSON.stringify({
          version: 1,
          token: 'f'.repeat(64),
          id: 'x',
          operation: 'start',
          params: { workspace: root },
        }) + '\n',
      oversizedToken:
        JSON.stringify({ version: 1, token: 'f'.repeat(60000), id: 'x', operation: 'status' }) +
        '\n',
      wrongVersion: JSON.stringify({ version: 2, token, id: 'x', operation: 'status' }) + '\n',
      unknownOperation:
        JSON.stringify({ version: 1, token, id: 'x', operation: 'shell/run', params: {} }) + '\n',
      operationNotString:
        JSON.stringify({ version: 1, token, id: 'x', operation: { op: 'status' } }) + '\n',
      deepNesting:
        JSON.stringify({ version: 1, token, id: 'x', operation: 'start' }).slice(0, -1) +
        ',"params":' +
        '['.repeat(20000) +
        ']'.repeat(20000) +
        '}\n',
      overLongLine:
        JSON.stringify({
          version: 1,
          token,
          id: 'x',
          operation: 'status',
          params: { pad: 'p'.repeat(70000) },
        }) + '\n',
      startWithBadWorkspace:
        JSON.stringify({
          version: 1,
          token,
          id: 'bad-start',
          operation: 'start',
          params: { workspace: '/definitely/not/here\u0000' },
        }) + '\n',
      empty: '\n',
    };
    for (const [name, bytes] of Object.entries(cases)) {
      await t.test(name, async () => {
        refused(await raw(bytes));
        await healthy();
      });
    }

    await t.test(
      'a connection that sends nothing is closed and does not block others',
      async () => {
        const idle = raw(null, { end: false, wait: 9000 });
        await healthy();
        const result = await idle;
        assert.ok(!result.error || result.data === '');
      },
    );

    await t.test(
      'a flood of slow connections leaves the supervisor answering afterwards',
      async () => {
        // More idle connections than the 16 admission permits; extra ones are dropped at once.
        const idles = Array.from({ length: 24 }, () =>
          raw('{"version":1', { end: false, wait: 9000 }),
        );
        await Promise.all(idles);
        await healthy();
      },
    );
  },
);
