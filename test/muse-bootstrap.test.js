import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactFor, vendorUrl } from '../scripts/bootstrap-muse-test.js';
import { EXPECTED_SCHEMA_FINGERPRINT } from '@muse-code/sdk';
test('test bootstrap refuses untrusted destinations and mismatched vendor identity before download', () => {
  for (const u of [
    'http://api.meta.ai/a',
    'https://api.meta.ai.evil.invalid/a',
    'https://fbcdn.net.evil.invalid/a',
    'https://user:secret@api.meta.ai/a',
    'file:///tmp/muse',
  ])
    assert.throws(() => vendorUrl(u));
  for (const u of [
    'https://lookaside.facebook.com/a',
    'https://api.meta.ai/a',
    'https://a.fbcdn.net/a',
  ])
    assert.equal(vendorUrl(u).protocol, 'https:');
  const m = {
    version: 'fixture',
    checksum_algorithm: 'sha256',
    msp_schema_fingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    artifacts: {
      fixture: { url: 'https://lookaside.facebook.com/a', checksum: 'a'.repeat(64), size: 10 },
    },
  };
  assert.equal(artifactFor(m, 'fixture', 'fixture').size, 10);
  for (const patch of [
    { version: 'other' },
    { msp_schema_fingerprint: 'wrong' },
    { checksum_algorithm: 'md5' },
    { artifacts: { fixture: { ...m.artifacts.fixture, size: 768 * 1024 * 1024 + 1 } } },
    { artifacts: { fixture: { ...m.artifacts.fixture, checksum: 'x' } } },
  ])
    assert.throws(() => artifactFor({ ...m, ...patch }, 'fixture', 'fixture'));
});
