import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRecovery } from '../scripts/verify-release-recovery.js';
import { TARGETS } from '../scripts/release-artifacts.js';

const commit = 'a'.repeat(40);
function fixture() {
  const run = {
    id: 7,
    repository: { full_name: 'kabudu/lascoria' },
    event: 'push',
    path: '.github/workflows/release.yml',
    head_sha: commit,
    head_branch: 'v0.1.2',
    status: 'completed',
    conclusion: 'failure',
  };
  const names = [
    'plan',
    ...TARGETS.map((t) => `build (${t})`),
    ...['ubuntu-latest', 'macos-latest', 'windows-latest'].map((os) => `validate / native (${os})`),
  ];
  const jobs = {
    total_count: names.length + 1,
    jobs: [
      ...names.map((name) => ({ name, run_id: 7, status: 'completed', conclusion: 'success' })),
      { name: 'publish', run_id: 7, status: 'completed', conclusion: 'failure' },
    ],
  };
  const artifacts = {
    total_count: TARGETS.length,
    artifacts: TARGETS.map((t) => ({
      name: `release-${t}`,
      expired: false,
      size_in_bytes: 1,
      digest: `sha256:${'b'.repeat(64)}`,
      workflow_run: { id: 7, head_sha: commit },
    })),
  };
  return { run, jobs, artifacts };
}
const check = ({ run, jobs, artifacts }) => verifyRecovery(run, jobs, artifacts, 'v0.1.2', commit);
test('recovery accepts only the original completed release with every real passed gate and immutable artifact', () => {
  check(fixture());
  for (const change of [
    (x) => (x.run.head_sha = 'c'.repeat(40)),
    (x) => (x.run.event = 'workflow_dispatch'),
    (x) => (x.run.repository.full_name = 'other/repo'),
    (x) => (x.run.head_branch = 'v0.1.3'),
    (x) => (x.run.status = 'in_progress'),
    (x) => (x.jobs.jobs[0].conclusion = 'failure'),
    (x) => (x.jobs.jobs[1].run_id = 8),
    (x) => x.jobs.jobs.pop(),
    (x) => x.jobs.jobs.push(x.jobs.jobs[1]),
    (x) => x.artifacts.artifacts.pop(),
    (x) => (x.artifacts.artifacts[0].expired = true),
    (x) => (x.artifacts.artifacts[0].workflow_run.head_sha = 'c'.repeat(40)),
    (x) => (x.artifacts.artifacts[0].workflow_run.id = 8),
    (x) => (x.artifacts.artifacts[0].digest = ''),
    (x) => (x.artifacts.artifacts[0].name = 'release-unreviewed'),
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => check(data));
  }
});
