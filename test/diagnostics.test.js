import test from 'node:test';
import assert from 'node:assert/strict';
import { recordTiming, timingSnapshot } from '../ui/diagnostics.ts';
test('diagnostic timings retain bounded samples with lifetime counts and correct percentile', () => {
  for (let i = 0; i < 1000; i++) recordTiming('navigationCommit', i);
  const report = timingSnapshot().navigationCommit;
  assert.equal(report.count, 1000);
  assert.equal(report.samples, 256);
  assert.equal(report.p95Ms, 987);
  recordTiming('navigationCommit', NaN);
  recordTiming('navigationCommit', -1);
  assert.deepEqual(timingSnapshot().navigationCommit, report);
  for (let i = 0; i < 1000; i++) recordTiming(`operation-${i}`, 1);
  assert.equal(Object.keys(timingSnapshot()).length, 32);
});
