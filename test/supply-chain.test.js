import test from 'node:test';
import assert from 'node:assert/strict';
import { licenceAllowed } from '../scripts/check-supply-chain.js';

test('licence expressions pass only when allowed terms can satisfy them', () => {
  for (const ok of [
    'MIT',
    'MIT OR Apache-2.0',
    'Apache-2.0/MIT',
    'MIT OR Apache-2.0 OR LGPL-2.1-or-later',
    '(MIT OR Apache-2.0) AND Unicode-3.0',
    'ISC AND (Apache-2.0 OR ISC) AND Apache-2.0 AND MIT AND BSD-3-Clause AND (Apache-2.0 OR ISC OR MIT) AND (Apache-2.0 OR ISC OR MIT-0)',
    'Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT',
  ])
    assert.ok(licenceAllowed(ok), ok);
  for (const refused of [
    undefined,
    '',
    'GPL-3.0-only',
    'MIT AND GPL-3.0-only',
    'LGPL-2.1-or-later',
    '(GPL-2.0 OR LGPL-3.0) AND MIT',
    'SSPL-1.0',
  ])
    assert.ok(!licenceAllowed(refused), String(refused));
});
