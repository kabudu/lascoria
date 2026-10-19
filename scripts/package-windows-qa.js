// Cross-built validation package only; this is not a signed public release.
import { mkdir, cp, copyFile, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
// Building here prevents accidentally packaging a binary that still loads devUrl.
execFileSync('npm', ['run', 'ui:build'], { stdio: 'inherit' });
for (const manifest of ['supervisor', 'src-tauri']) {
  execFileSync(
    'cargo',
    [
      'xwin',
      'build',
      '--release',
      '--target',
      'x86_64-pc-windows-msvc',
      '--manifest-path',
      `${manifest}/Cargo.toml`,
      ...(manifest === 'src-tauri' ? ['--features', 'custom-protocol'] : []),
    ],
    { stdio: 'inherit' },
  );
}
const output = resolve('.dev/windows-qa');
const runtime = join(output, 'runtime');
await mkdir(join(runtime, 'workers'), { recursive: true });
await mkdir(join(output, 'testing'), { recursive: true });
for (const file of [
  'windows-smoke.js',
  'lifecycle-smoke.js',
  'qa-launch.mjs',
  'account-worker.js',
  'uncertain-worker.js',
])
  await copyFile(join('testing', file), join(output, 'testing', file));
await copyFile('test/relay-agent.test.js', join(output, 'testing/relay-agent.test.js'));
for (const file of ['relay-identity.test.js', 'skills-observed.test.js'])
  await copyFile(join('test', file), join(output, 'testing', file));
await copyFile('test/project-worktrees.test.js', join(output, 'testing/project-worktrees.test.js'));
await copyFile('test/project-context.test.js', join(output, 'testing/project-context.test.js'));
await copyFile('testing/provider.js', join(output, 'testing/provider.js'));
await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
await copyFile(
  'src-tauri/target/x86_64-pc-windows-msvc/release/spatial-constellation-desktop.exe',
  join(output, 'Lascoria.exe'),
);
await copyFile(
  'supervisor/target/x86_64-pc-windows-msvc/release/constellation-supervisor.exe',
  join(runtime, 'constellation-supervisor.exe'),
);
const node = '.dev/windows-node/node-v24.17.0-win-x64';
const archive = createHash('sha256')
  .update(await readFile('.dev/node-windows.zip'))
  .digest('hex');
if (archive !== 'f2aa33b35b75aca5f3f7b85675a6f6423201053e9381911e64961f3bda2528ab')
  throw Error('Windows Node archive checksum mismatch');
await copyFile(join(node, 'node.exe'), join(runtime, 'node.exe'));
await copyFile(join(node, 'LICENSE'), join(runtime, 'NODE-LICENSE'));
await copyFile('third-party/MUSE-SDK-LICENSE', join(runtime, 'MUSE-SDK-LICENSE'));
await cp('src', join(runtime, 'workers'), { recursive: true });
await cp('node_modules/@muse-code/sdk', join(runtime, 'node_modules/@muse-code/sdk'), {
  recursive: true,
});
await writeFile(join(runtime, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
await writeFile(
  join(runtime, 'provenance.json'),
  JSON.stringify(
    {
      platform: 'win32',
      arch: 'x64',
      purpose: 'native validation; unsigned',
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }) !== '',
      sdk: '1.4.10',
      muse: '1.4.10-R6427.1',
      node: '24.17.0',
      desktopSha256: await hash(join(output, 'Lascoria.exe')),
      supervisorSha256: await hash(join(runtime, 'constellation-supervisor.exe')),
      nodeSha256: await hash(join(runtime, 'node.exe')),
    },
    null,
    2,
  ),
);
