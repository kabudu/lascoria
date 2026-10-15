import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { textProblems, checkRepository } from '../scripts/check-repository.js';

test('repository gate rejects forbidden punctuation and broken/private links, accepts real links and web URLs', () => {
  const root = mkdtempSync(join(tmpdir(), 'lascoria-doc-check-'));
  try {
    writeFileSync(join(root, 'guide.md'), 'Guide');
    assert.deepEqual(
      textProblems('README.md', '[Guide](guide.md#usage) [Web](https://example.invalid)', root),
      [],
    );
    assert.match(
      textProblems('README.md', '[Missing](absent.md)', root).join(),
      /missing local link/,
    );
    assert.match(
      textProblems('README.md', '[Private](../private.md)', root).join(),
      /stay in the repository/,
    );
    assert.match(
      textProblems('README.md', '[Private](/private.md)', root).join(),
      /stay in the repository/,
    );
    assert.match(textProblems('README.md', '[Broken](%FF.md)', root).join(), /encoding/);
    assert.match(textProblems('source.js', 'text\u2014text', root).join(), /U\+2014/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('repository gate refuses symlinks and oversized tracked content before reading their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'lascoria-source-check-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  try {
    git('init', '-q');
    if (process.platform !== 'win32') {
      symlinkSync(join(root, 'absent-private-target'), join(root, 'linked.md'));
      git('add', 'linked.md');
      assert.throws(() => checkRepository(root), /tracked symlinks/);
      git('rm', '-f', 'linked.md');
    }
    writeFileSync(join(root, 'large.txt'), '');
    truncateSync(join(root, 'large.txt'), 17 * 1024 * 1024);
    git('add', 'large.txt');
    assert.throws(() => checkRepository(root), /review budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository gate catches a synthetic secret retained in the index after the working copy is cleaned', () => {
  const root = mkdtempSync(join(tmpdir(), 'lascoria-staged-check-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'sample.txt'), `api_key = "${randomBytes(24).toString('hex')}"\n`);
    execFileSync('git', ['-C', root, 'add', 'sample.txt']);
    writeFileSync(join(root, 'sample.txt'), 'The working copy has no credential.\n');
    assert.throws(() => checkRepository(root), /Staged-content secret scan failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
