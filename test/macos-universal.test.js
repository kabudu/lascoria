import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyUniversalMacBinary } from '../scripts/verify-universal-macos.js';

test(
  'actual universal slice verification accepts both architectures and refuses either thin input',
  { skip: process.platform !== 'darwin' },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'lascoria-slices-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const inputs = [];
    for (const cpu of ['arm64', 'x86_64']) {
      const file = join(dir, `${cpu}.o`);
      execFileSync(
        '/usr/bin/clang',
        ['-target', `${cpu}-apple-macos11`, '-x', 'c', '-c', '-', '-o', file],
        { input: 'int fixture(void) { return 0; }\n', timeout: 30_000 },
      );
      inputs.push(file);
      assert.throws(() => verifyUniversalMacBinary(file), /requires arm64 and x86_64/);
    }
    const fat = join(dir, 'universal.o');
    execFileSync('/usr/bin/lipo', ['-create', ...inputs, '-output', fat]);
    verifyUniversalMacBinary(fat);
  },
);
