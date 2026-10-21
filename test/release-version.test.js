import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse, compare } from '../scripts/release.js';

test('release versions reject invalid SemVer and compare prerelease identifiers by the specification', () => {
  for (const version of [
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-beta..1',
    '1.2.3-01',
    '1.2.3-beta.01',
    '1.2.3-.',
    '1.2.3-beta.',
    '1.2.3-beta_1',
    '9007199254740992.0.0',
  ])
    assert.throws(() => parse(version), /Not a release version/, version);
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(compare(ordered[i - 1], ordered[i]) < 0);
    assert.ok(compare(ordered[i], ordered[i - 1]) > 0);
  }
  assert.ok(compare('1.0.0-Beta', '1.0.0-beta') < 0, 'ASCII order, not locale order');
  assert.ok(compare('1.0.0-99999999999999999999', '1.0.0-100000000000000000000') < 0);
  assert.equal(compare('1.2.3', '1.2.3'), 0);
});

test('release preparation preflights every version field before writing and updates the complete set', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lascoria-release-version-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = new Map([
    ['package.json', JSON.stringify({ name: 'fixture', type: 'module', version: '0.1.0' })],
    [
      'package-lock.json',
      JSON.stringify({ version: '0.1.0', packages: { '': { version: '0.1.0' } } }),
    ],
    ['src-tauri/tauri.conf.json', JSON.stringify({ version: '0.1.0' })],
    [
      'src-tauri/Cargo.toml',
      '[package]\nname = "spatial-constellation-desktop"\nversion = "0.1.0"\n',
    ],
    ['supervisor/Cargo.toml', '[package]\nname = "constellation-supervisor"\nversion = "0.1.0"\n'],
    ['runtime-support/Cargo.toml', '[package]\nname = "lascoria-runtime"\nversion = "0.1.0"\n'],
    [
      'src-tauri/Cargo.lock',
      '[[package]]\nname = "spatial-constellation-desktop"\nversion = "0.1.0"\n\n[[package]]\nname = "lascoria-runtime"\nversion = "0.1.0"\n',
    ],
    [
      'supervisor/Cargo.lock',
      '[[package]]\nname = "constellation-supervisor"\nversion = "0.1.0"\n\n[[package]]\nname = "lascoria-runtime"\nversion = "0.1.0"\n',
    ],
    ['runtime-support/Cargo.lock', '[[package]]\nname = "lascoria-runtime"\nversion = "0.1.0"\n'],
    ['CHANGELOG.md', '# Changelog\n\n## Unreleased\n\n- A tested change.\n'],
  ]);
  for (const [path, text] of data) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  await mkdir(join(root, 'scripts'));
  await copyFile(resolve('scripts/release.js'), join(root, 'scripts/release.js'));
  const prepare = (version) =>
    execFileSync(process.execPath, [join(root, 'scripts/release.js'), 'prepare', version], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const unchanged = async () => {
    for (const [path, text] of data)
      assert.equal(await readFile(join(root, path), 'utf8'), text, path);
  };
  assert.throws(() => prepare('0.2.0-beta..1'), /Command failed/);
  await unchanged();
  // A missing late lock entry previously left a partially promoted changelog/version set.
  await writeFile(
    join(root, 'runtime-support/Cargo.lock'),
    '[[package]]\nname = "wrong"\nversion = "0.1.0"\n',
  );
  assert.throws(() => prepare('0.2.0'), /Command failed/);
  await writeFile(join(root, 'runtime-support/Cargo.lock'), data.get('runtime-support/Cargo.lock'));
  await unchanged();
  await rm(join(root, 'runtime-support/Cargo.lock'));
  assert.throws(() => prepare('0.2.0'), /Command failed/);
  await writeFile(join(root, 'runtime-support/Cargo.lock'), data.get('runtime-support/Cargo.lock'));
  await unchanged();
  assert.match(prepare('0.2.0-beta.1'), /Prepared 0.2.0-beta.1/);
  for (const [path] of data) {
    const text = await readFile(join(root, path), 'utf8');
    if (path === 'CHANGELOG.md') assert.match(text, /## 0\.2\.0-beta\.1 - \d{4}-\d{2}-\d{2}/);
    else {
      assert.ok(text.includes('0.2.0-beta.1'), path);
      assert.ok(!text.includes('0.1.0'), path);
    }
  }
  assert.match(await readFile(join(root, 'docs/releases/v0.2.0-beta.1.md'), 'utf8'), /TODO/);
});
