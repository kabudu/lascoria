// Test-only layout matching installed resource resolution. Does not publish an artifact.
import { mkdir, cp, copyFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const output = resolve('.dev/native-qa');
await mkdir(join(output, 'testing'), { recursive: true });
await cp('.dev/bundle-runtime', join(output, 'runtime'), { recursive: true });
await copyFile('src/client.js', join(output, 'runtime/workers/client.js'));
for (const file of [
  'windows-smoke.js',
  'lifecycle-smoke.js',
  'uncertain-worker.js',
  'account-worker.js',
  'subscription-smoke.js',
])
  await copyFile(join('testing', file), join(output, 'testing', file));
await copyFile('test/relay-agent.test.js', join(output, 'testing/relay-agent.test.js'));
await copyFile('test/project-worktrees.test.js', join(output, 'testing/project-worktrees.test.js'));
await copyFile('test/project-context.test.js', join(output, 'testing/project-context.test.js'));
await copyFile('testing/provider.js', join(output, 'testing/provider.js'));
await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
