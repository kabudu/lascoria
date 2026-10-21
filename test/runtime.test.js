import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Session, readSessionDurability, createUuidV7Mint } from '@muse-code/sdk';
import { spawnRuntime } from '../src/runtime.js';
import { MUSE_VERSION } from '../src/muse-version.js';

test('SDK fold: duplicate and stale item revisions, gaps and unknown durability', () => {
  const session = new Session({ sessionId: 'session', durability: { kind: 'durable' } });
  const event = (revision) => ({
    method: 'item/completed',
    params: {
      sessionId: 'session',
      viewCursor: 'v:session:1',
      item: {
        itemId: 'item',
        kind: 'futureKind',
        revision,
        status: 'completed',
        text: 'revision ' + revision,
      },
    },
  });
  session.apply(event(2));
  session.apply(event(2));
  session.apply(event(1));
  assert.equal(session.fold.items.size, 1);
  assert.equal(session.fold.items.get('item').revision, 2);
  const replay = new Session({ sessionId: 'session', durability: { kind: 'durable' } });
  replay.apply(event(2));
  assert.deepEqual(replay.fold.items.list(), session.fold.items.list());
  session.apply({
    method: 'view/gap',
    params: { sessionId: 'session', after: 'v:session:1', next: 'v:session:3' },
  });
  assert.equal(session.fold.current, false);
  assert.equal(readSessionDurability({ sessionDurability: 'future-profile' }).kind, 'unrecognized');
});

test('SDK boundary: mismatched fingerprint refuses the host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sch-mismatch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, 'fake-muse');
  await writeFile(
    binary,
    `#!/usr/bin/env node\nconst readline = require('node:readline'); const r = readline.createInterface({input:process.stdin}); r.on('line', line => { const m = JSON.parse(line); if(m.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{serverInfo:{name:'fixture',version:'0'},schema:{version:1,fingerprint:'sha256:'+'0'.repeat(64)},grantedCapabilities:[],experimentalApi:false,sessionDurability:'durable'}})+'\\n'); }); r.on('close',()=>process.exit(0));\n`,
  );
  await chmod(binary, 0o700);
  await assert.rejects(
    spawnRuntime(
      { binary },
      () => {},
      () => {},
    ),
    /fingerprint|mismatch/i,
  );
});

test(
  'real Muse SDK: writer lease refusal and ephemeral handshake',
  { timeout: 20000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sch-lease-'));
    await mkdir(join(root, 'workspace'));
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    };
    const hosts = [];
    t.after(async () => {
      await Promise.all(hosts.map((h) => h.close()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const open = async (args) => {
      const host = await spawnRuntime(
        { env, args },
        () => {},
        () => {},
      );
      hosts.push(host);
      return host;
    };
    const first = await open([]);
    const second = await open([]);
    const mint = createUuidV7Mint();
    const started = await first.command(
      'session/start',
      { workspaceRoot: join(root, 'workspace') },
      mint(),
    );
    await assert.rejects(
      second.command(
        'session/resume',
        { sessionId: started.session.sessionId, excludeItems: true },
        mint(),
      ),
      (error) => error.kind === 'sessionInUse',
    );
    const ephemeral = await open(['--no-session-log']);
    assert.equal(ephemeral.profile.kind, 'ephemeral');
    assert.equal(first.handshake.serverInfo.version, MUSE_VERSION);
  },
);
