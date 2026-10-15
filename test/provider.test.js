import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provider } from '../testing/provider.js';
test('loopback provider supplies an environment-only credential without a migratable auth store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lascoria-provider-'));
  const fixture = await provider(root);
  try {
    assert.deepEqual(fixture.env, { META_API_KEY: 'stage-a-loopback-only' });
    assert.deepEqual(await readdir(join(root, 'config', 'muse')), ['settings.json']);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
