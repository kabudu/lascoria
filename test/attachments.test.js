import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { provider } from '../testing/provider.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, predicate) {
  let value;
  for (let i = 0; i < 200; i++) {
    try {
      value = await fn();
      if (predicate(value)) return value;
    } catch (e) {
      value = String(e);
    }
    await delay(50);
  }
  throw new Error(`Attachment convergence: ${JSON.stringify(value)}`);
}
// A real 1x1 PNG, so Muse and the model path see a decodable image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test(
  'images are staged privately, sent only with a new task and never journalled as bytes',
  { timeout: 60000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-img-')));
    const directory = join(root, 'state'),
      app = join(root, 'app');
    await mkdir(app);
    const model = await provider(root, { responseDelayMs: 50 });
    const daemon = spawn(resolve('supervisor/target/debug/constellation-supervisor'), [], {
      env: {
        ...process.env,
        ...model.env,
        SCH_STATE_DIR: directory,
        SCH_PROVIDER: 'meta',
        SCH_AUTH_MANAGED: '0',
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
        await bounded(exit, 10000).catch(() => {});
        if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
      }
      await model.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const status = () => request(directory, 'status');
    await until(status, (s) => s.pid === daemon.pid);
    assert.ok((await status()).features.includes('attachments'));
    const start = async (id) => {
      const started = await request(directory, 'start', { workspace: app }, id);
      await until(
        status,
        (s) => s.sessions.find((r) => r.id === started.sessionId)?.state.current === true,
      );
      return started.sessionId;
    };
    const sessionId = await start('start-a');
    const other = await start('start-b');
    const stage = async (session, bytes, name = 'pixel.png') => {
      const attachmentId = randomUUID();
      await request(directory, 'attachment/begin', {
        sessionId: session,
        attachmentId,
        name,
        bytes: bytes.length,
      });
      for (let offset = 0; offset < bytes.length; offset += 30000)
        await request(directory, 'attachment/append', {
          sessionId: session,
          attachmentId,
          offset,
          data: bytes.subarray(offset, offset + 30000).toString('base64'),
        });
      return {
        attachmentId,
        finished: request(directory, 'attachment/finish', {
          sessionId: session,
          attachmentId,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      };
    };
    const image = await stage(sessionId, PNG);
    const ready = await image.finished;
    assert.deepEqual(
      [ready.mediaType, ready.width, ready.height, ready.status],
      ['image/png', 1, 1, 'ready'],
    );
    const listed = await request(directory, 'attachment/list', { sessionId });
    assert.deepEqual(
      listed.attachments.map((a) => a.id),
      [image.attachmentId],
    );
    assert.equal(
      (await request(directory, 'attachment/list', { sessionId: other })).attachments.length,
      0,
    );

    // Content decides the type: a PDF named .png is refused and removed.
    const fake = await stage(sessionId, Buffer.from('%PDF-1.7 fake'), 'notes.png');
    await assert.rejects(fake.finished, /PNG, JPEG, GIF or WebP/);
    await assert.rejects(
      request(
        directory,
        'turn',
        { sessionId: other, text: 'Not yours', attachments: [image.attachmentId] },
        'cross-session',
      ),
      /no longer available/,
    );
    await assert.rejects(
      request(
        directory,
        'turn',
        { sessionId, text: 'Unknown', attachments: [randomUUID()] },
        'unknown-image',
      ),
      /no longer available/,
    );
    await assert.rejects(
      request(
        directory,
        'steer',
        { sessionId, text: 'x', turnId: randomUUID(), attachments: [image.attachmentId] },
        'steer-image',
      ),
      /new task/,
    );

    const from = model.requests.length;
    const sent = await request(
      directory,
      'turn',
      { sessionId, text: 'Describe this image', attachments: [image.attachmentId] },
      'image-task',
    );
    assert.ok(['applied', 'accepted'].includes(sent.status), JSON.stringify(sent));
    await until(
      status,
      (s) =>
        s.sessions.find((r) => r.id === sessionId).state.turns?.at(-1)?.terminal === 'completed',
    );
    const encoded = PNG.toString('base64');
    assert.ok(
      model.requests.slice(from).some((body) => body.includes(encoded)),
      'The image bytes reach the model request',
    );
    const snapshot = await status();
    assert.ok(!JSON.stringify(snapshot.commands).includes(encoded), 'No bytes in the journal');
    const command = snapshot.commands.find((c) => c.id === 'image-task');
    assert.deepEqual(command.params.attachments, [image.attachmentId]);
    const row = snapshot.sessions.find((r) => r.id === sessionId);
    const message = row.state.items.find(
      (item) => item.kind === 'userMessage' && item.turnId === sent.result.turnId,
    );
    assert.equal(message?.attachments?.length, 1, JSON.stringify(message));
    // Muse now holds the bytes; the staged copy is gone and a retry does not send again.
    assert.equal(
      (await request(directory, 'attachment/list', { sessionId })).attachments.length,
      0,
    );
    const retried = await request(
      directory,
      'turn',
      { sessionId, text: 'Describe this image', attachments: [image.attachmentId] },
      'image-task',
    );
    assert.equal(retried.commandId, sent.commandId);

    // Archiving a session removes images still waiting in its composer.
    const waiting = await stage(other, PNG);
    await waiting.finished;
    await request(directory, 'session/archive', { sessionId: other }, 'archive-b');
    await assert.rejects(
      request(directory, 'attachment/list', { sessionId: other }).then((r) => {
        if (r.attachments.length) throw new Error('still staged');
        throw new Error('cleared');
      }),
      /cleared/,
    );
    // Only open sessions can stage images, which also bounds staging folders.
    for (const session of [other, randomUUID()])
      await assert.rejects(
        request(directory, 'attachment/begin', {
          sessionId: session,
          attachmentId: randomUUID(),
          bytes: PNG.length,
        }),
        /open session/,
      );
  },
);
