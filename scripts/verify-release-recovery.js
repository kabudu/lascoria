import { TARGETS } from './release-artifacts.js';
import { parse } from './release.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function verifyRecovery(run, jobs, artifacts, tag, commit) {
  parse(tag?.slice(1));
  if (
    !tag.startsWith('v') ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    run.repository?.full_name !== 'kabudu/lascoria' ||
    run.event !== 'push' ||
    run.path !== '.github/workflows/release.yml' ||
    run.head_sha !== commit ||
    run.head_branch !== tag ||
    run.status !== 'completed' ||
    !['failure', 'success'].includes(run.conclusion)
  )
    throw Error('Recovery source does not match a completed version-tag release');
  const required = [
    'plan',
    ...TARGETS.map((t) => `build (${t})`),
    ...['ubuntu-latest', 'macos-latest', 'windows-latest'].map((os) => `validate / native (${os})`),
  ];
  for (const name of required) {
    const matches = jobs.jobs?.filter((j) => j.name === name);
    if (
      matches?.length !== 1 ||
      matches[0].run_id !== run.id ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    )
      throw Error(`Recovery requires a passed gate: ${name}`);
  }
  if (
    jobs.total_count !== jobs.jobs.length ||
    jobs.jobs.some((j) => !required.includes(j.name) && j.name !== 'publish')
  )
    throw Error('Unexpected or incomplete recovery job inventory');
  const names = TARGETS.map((t) => `release-${t}`).sort();
  if (
    artifacts.total_count !== names.length ||
    JSON.stringify(artifacts.artifacts?.map((a) => a.name).sort()) !== JSON.stringify(names) ||
    artifacts.artifacts.some(
      (a) =>
        a.expired ||
        !Number.isSafeInteger(a.size_in_bytes) ||
        a.size_in_bytes <= 0 ||
        !/^sha256:[a-f0-9]{64}$/.test(a.digest ?? '') ||
        a.workflow_run?.id !== run.id ||
        a.workflow_run?.head_sha !== commit,
    )
  )
    throw Error('Recovery requires the exact unexpired artifact inventory and source revision');
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [run, jobs, artifacts, tag, commit] = process.argv.slice(2);
  verifyRecovery(
    ...[run, jobs, artifacts].map((p) => JSON.parse(readFileSync(p, 'utf8'))),
    tag,
    commit,
  );
  console.log('Original release source, passed gates and immutable artifact inventory verified.');
}
