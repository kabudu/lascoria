import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, truncate, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  compare,
  promoteChangelog,
  changelogSection,
  curated,
  versions,
} from '../scripts/release.js';
import { plan, manifest, TARGETS } from '../scripts/release-artifacts.js';

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

test('release artifacts get collision-free names and an updater manifest with artifact signatures', async (t) => {
  const files = [
    '/b/macos/Lascoria.app.tar.gz',
    '/b/macos/Lascoria.app.tar.gz.sig',
    '/b/dmg/Lascoria_0.2.0_aarch64.dmg',
  ];
  assert.deepEqual(
    plan('darwin-universal', '0.2.0', files).map(([, name]) => name),
    [
      'Lascoria_0.2.0_darwin-universal.dmg',
      'Lascoria_0.2.0_darwin-universal.app.tar.gz',
      'Lascoria_0.2.0_darwin-universal.app.tar.gz.sig',
    ],
  );
  assert.throws(
    () => plan('darwin-universal', '0.2.0', files.slice(0, 1)),
    /signed updater bundle/,
  );
  assert.throws(
    () => plan('linux-x86_64', '0.2.0', ['/a/x.AppImage', '/b/y.AppImage', '/a/x.AppImage.sig']),
    /More than one/,
  );

  const dir = await mkdtemp(join(tmpdir(), 'lsc-release-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const names = [
    'Lascoria_0.2.0_darwin-universal.app.tar.gz',
    'Lascoria_0.2.0_darwin-universal.dmg',
    'Lascoria_0.2.0_windows-x86_64-setup.exe',
    'Lascoria_0.2.0_linux-x86_64.AppImage',
    'Lascoria_0.2.0_linux-x86_64.deb',
    'Lascoria_0.2.0_linux-aarch64.AppImage',
    'Lascoria_0.2.0_linux-aarch64.deb',
  ];
  const artifactFiles = [];
  for (const name of names) {
    await writeFile(join(dir, name), 'bundle');
    artifactFiles.push(join(dir, name));
    if (/\.(tar\.gz|exe|AppImage)$/.test(name)) {
      await writeFile(join(dir, `${name}.sig`), `sig-of-${name}\n`);
      artifactFiles.push(join(dir, `${name}.sig`));
    }
  }
  const value = manifest(artifactFiles, 'v0.2.0', 'Notes', new Date('2026-10-18T12:00:00Z'));
  const notesDirectory = await mkdtemp(join(tmpdir(), 'lsc-notes-'));
  t.after(() => rm(notesDirectory, { recursive: true, force: true }));
  const notesPath = join(notesDirectory, 'notes.md');
  await writeFile(notesPath, 'Notes');
  const cli = (epoch) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../scripts/release-artifacts.js', import.meta.url)),
        'manifest',
        dir,
        'v0.2.0',
        notesPath,
      ],
      { env: { ...process.env, SOURCE_DATE_EPOCH: epoch }, encoding: 'utf8' },
    );
  assert.equal(cli('1792678611').status, 0);
  const firstManifest = await readFile(join(dir, 'latest.json'), 'utf8');
  const firstChecksums = await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8');
  assert.equal(JSON.parse(firstManifest).pub_date, '2026-10-22T14:16:51.000Z');
  assert.equal(cli('1792678611').status, 0);
  assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), firstManifest);
  assert.equal(await readFile(join(dir, 'SHA256SUMS.txt'), 'utf8'), firstChecksums);
  assert.notEqual(cli('invalid').status, 0);
  assert.equal(await readFile(join(dir, 'latest.json'), 'utf8'), firstManifest);
  assert.equal(value.version, '0.2.0');
  assert.deepEqual(value.platforms['darwin-aarch64'], value.platforms['darwin-x86_64']);
  assert.ok(value.platforms['darwin-aarch64'].url.endsWith('_darwin-universal.app.tar.gz'));
  assert.equal(value.pub_date, '2026-10-18T12:00:00.000Z');
  assert.deepEqual(
    Object.keys(value.platforms).sort(),
    ['darwin-aarch64', 'darwin-x86_64', ...TARGETS.filter((t) => !t.startsWith('darwin'))].sort(),
  );
  assert.deepEqual(value.platforms['windows-x86_64'], {
    signature: 'sig-of-Lascoria_0.2.0_windows-x86_64-setup.exe',
    url: 'https://github.com/kabudu/lascoria/releases/download/v0.2.0/Lascoria_0.2.0_windows-x86_64-setup.exe',
  });
  assert.throws(() => manifest([join(dir, names[0])], 'v0.2.0', ''), /missing required artifact/);
  for (const removed of artifactFiles) {
    assert.throws(
      () =>
        manifest(
          artifactFiles.filter((f) => f !== removed),
          'v0.2.0',
          '',
        ),
      /missing required artifact/,
    );
  }
  assert.throws(() => manifest([...artifactFiles, artifactFiles[0]], 'v0.2.0', ''), /Duplicate/);
  assert.throws(() => manifest(artifactFiles, 'v0.3.0', ''), /Unexpected release artifact/);
  // Sparse fixtures exercise the release/client boundary without allocating large buffers.
  await truncate(join(dir, names[0]), 256 * 1024 * 1024);
  assert.equal(manifest(artifactFiles, 'v0.2.0', '').version, '0.2.0');
  await truncate(join(dir, names[0]), 256 * 1024 * 1024 + 1);
  assert.throws(() => manifest(artifactFiles, 'v0.2.0', ''), /256 MB updater limit/);
  await writeFile(join(dir, names[0]), 'bundle');
  const signature = `${names[0]}.sig`;
  await writeFile(join(dir, signature), '   ');
  assert.throws(() => manifest(artifactFiles, 'v0.2.0', ''), /empty signature/);
  await writeFile(join(dir, signature), 'x'.repeat(16385));
  assert.throws(() => manifest(artifactFiles, 'v0.2.0', ''), /signature is too large/);
  assert.throws(
    () => plan('darwin-universal', '0.2.0', files.slice(0, 2)),
    /required .dmg installer/,
  );
  assert.throws(
    () => plan('linux-x86_64', '0.2.0', ['/b/x.AppImage', '/b/x.AppImage.sig']),
    /required .deb installer/,
  );
});
