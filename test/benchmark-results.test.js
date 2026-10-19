import test from 'node:test';
import assert from 'node:assert/strict';
import { canCompare } from '../testing/benchmark-results.js';
const passing = { runs: 3, correct: 3, tokensReported: 3, meanTokens: 100 };
test('token savings require every task to pass independently on both sides', () => {
  assert.equal(canCompare(passing, { ...passing, meanTokens: 80 }), true);
  assert.equal(canCompare({ ...passing, correct: 0 }, { ...passing, correct: 0 }), false);
  assert.equal(canCompare(passing, { ...passing, correct: 2 }), false);
});
test('token savings remain unknown for missing, zero or invalid measurements', () => {
  for (const invalid of [
    { tokensReported: 2 },
    { meanTokens: null },
    { meanTokens: 0 },
    { meanTokens: Infinity },
    { runs: 0 },
  ]) {
    assert.equal(canCompare(passing, { ...passing, ...invalid }), false);
  }
});
