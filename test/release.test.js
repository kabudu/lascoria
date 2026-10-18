import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compare,
  promoteChangelog,
  changelogSection,
  curated,
  versions,
} from '../scripts/release.js';
import { plan, manifest } from '../scripts/release-artifacts.js';

test('release versions, changelog promotion and curated notes', () => {
  assert.ok(compare('0.2.0', '0.1.9') > 0);
  assert.ok(compare('1.0.0', '1.0.0-beta.2') > 0);
  assert.ok(compare('1.0.0-beta.10', '1.0.0-beta.2') > 0);
  assert.equal(compare('1.2.3', '1.2.3'), 0);
  assert.throws(() => compare('1.2', '1.2.0'), /Not a release version/);
  // Every version field in the tree agrees today.
  assert.equal(new Set(versions().map(([, v]) => v)).size, 1);

  const before =
    '# Changelog\n\n## Unreleased\n\n- New thing.\n\n## 0.1.0 - 2026-10-01\n\n- First.\n';
  const after = promoteChangelog(before, '0.2.0', '2026-10-18');
  assert.equal(
    after,
    '# Changelog\n\n## Unreleased\n\n## 0.2.0 - 2026-10-18\n\n- New thing.\n\n## 0.1.0 - 2026-10-01\n\n- First.\n',
  );
  assert.equal(changelogSection(after, '0.2.0'), '- New thing.');
  assert.equal(changelogSection(after, '0.1.0'), '- First.');
  assert.equal(changelogSection(after, '9.9.9'), null);
  assert.throws(() => promoteChangelog(after, '0.3.0', 'd'), /Nothing under/);
  assert.throws(() => promoteChangelog(before, '0.1.0', 'd'), /already has/);

  assert.deepEqual(curated('# Lascoria v0.2.0: Faster starts\n\nBody text.\n', '0.2.0'), {
    title: 'Lascoria v0.2.0: Faster starts',
    body: 'Body text.',
  });
  assert.throws(() => curated('# Lascoria v0.2.1: x\n\nBody', '0.2.0'), /must start with/);
  assert.throws(() => curated('# Lascoria v0.2.0: x\n\nTODO', '0.2.0'), /Write the release notes/);
  assert.throws(
    () => curated(`# Lascoria v0.2.0: x\n\nA ${String.fromCharCode(0x2014)} B`, '0.2.0'),
    /U\+2014/,
  );
});

test('release artifacts get collision-free names and a signed updater manifest', async (t) => {
  const files = [
    '/b/macos/Lascoria.app.tar.gz',
    '/b/macos/Lascoria.app.tar.gz.sig',
    '/b/dmg/Lascoria_0.2.0_aarch64.dmg',
  ];
  assert.deepEqual(
    plan('darwin-aarch64', '0.2.0', files).map(([, name]) => name),
    [
      'Lascoria_0.2.0_darwin-aarch64.dmg',
      'Lascoria_0.2.0_darwin-aarch64.app.tar.gz',
      'Lascoria_0.2.0_darwin-aarch64.app.tar.gz.sig',
    ],
  );
  assert.throws(() => plan('darwin-aarch64', '0.2.0', files.slice(0, 1)), /signed updater bundle/);
  assert.throws(
    () => plan('linux-x86_64', '0.2.0', ['/a/x.AppImage', '/b/y.AppImage', '/a/x.AppImage.sig']),
    /More than one/,
  );

  const dir = await mkdtemp(join(tmpdir(), 'lsc-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = [
    'Lascoria_0.2.0_darwin-aarch64.app.tar.gz',
    'Lascoria_0.2.0_windows-x86_64-setup.exe',
    'Lascoria_0.2.0_linux-x86_64.AppImage',
  ];
  for (const name of names) {
    await writeFile(join(dir, name), 'bundle');
    await writeFile(join(dir, `${name}.sig`), `sig-of-${name}\n`);
  }
  const value = manifest(
    names.flatMap((n) => [join(dir, n), join(dir, `${n}.sig`)]),
    'v0.2.0',
    'Notes',
    new Date('2026-10-18T12:00:00Z'),
  );
  assert.equal(value.version, '0.2.0');
  assert.equal(value.pub_date, '2026-10-18T12:00:00.000Z');
  assert.deepEqual(Object.keys(value.platforms).sort(), [
    'darwin-aarch64',
    'linux-x86_64',
    'windows-x86_64',
  ]);
  assert.deepEqual(value.platforms['windows-x86_64'], {
    signature: 'sig-of-Lascoria_0.2.0_windows-x86_64-setup.exe',
    url: 'https://github.com/kabudu/lascoria/releases/download/v0.2.0/Lascoria_0.2.0_windows-x86_64-setup.exe',
  });
  assert.throws(() => manifest([join(dir, names[0])], 'v0.2.0', ''), /has no signature/);
});
