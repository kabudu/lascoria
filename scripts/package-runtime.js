// Stage an installed runtime. All paths are resolved at build time, never on the user's machine.
import { mkdir, copyFile, cp, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const debug = process.argv.includes('--debug');
const root = resolve(import.meta.dirname, '..');
const output = join(root, '.dev/bundle-runtime');
const suffix = process.platform === 'win32' ? '.exe' : '';
const expected = process.env.TAURI_ENV_ARCH;
const arch = { x86_64: 'x64', aarch64: 'arm64', x86: 'ia32' }[expected] ?? expected;
if (arch && arch !== process.arch)
  throw Error('Run packaging with the Node runtime for the target architecture');
if (!debug)
  execFileSync(
    'cargo',
    ['build', '--release', '--manifest-path', join(root, 'supervisor/Cargo.toml')],
    { stdio: 'inherit' },
  );
await mkdir(join(output, 'workers'), { recursive: true });
async function copy(source, target) {
  const src = await stat(source);
  const dst = await stat(target).catch(() => null);
  if (!dst || src.size !== dst.size || src.mtimeMs > dst.mtimeMs) await copyFile(source, target);
}
await copy(process.execPath, join(output, `node${suffix}`));
await copy(
  join(root, `supervisor/target/${debug ? 'debug' : 'release'}/constellation-supervisor${suffix}`),
  join(output, `constellation-supervisor${suffix}`),
);
for (const name of [
  'probe-worker.js',
  'worker.js',
  'broker.js',
  'auth-worker.js',
  'session-worker.js',
  'runtime.js',
  'muse-version.js',
])
  await copy(join(root, 'src', name), join(output, 'workers', name));
await writeFile(join(output, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
await mkdir(join(output, 'node_modules/@muse-code'), { recursive: true });
await cp(join(root, 'node_modules/@muse-code/sdk'), join(output, 'node_modules/@muse-code/sdk'), {
  recursive: true,
  force: true,
});
const nodeLicense = join(dirname(process.execPath), '../LICENSE');
await copyFile(nodeLicense, join(output, 'NODE-LICENSE'))
  .catch(() => copyFile(join(dirname(process.execPath), 'LICENSE'), join(output, 'NODE-LICENSE')))
  .catch(() => {
    throw Error('Node distribution LICENSE missing beside runtime');
  });
await copyFile(join(root, 'third-party/MUSE-SDK-LICENSE'), join(output, 'MUSE-SDK-LICENSE'));
const sdk = JSON.parse(
  await readFile(join(root, 'node_modules/@muse-code/sdk/package.json'), 'utf8'),
);
const manifest = {
  node: process.version,
  sdk: sdk.version,
  platform: process.platform,
  arch: process.arch,
  mode: debug ? 'debug' : 'release',
  binaries: {},
};
for (const name of [`node${suffix}`, `constellation-supervisor${suffix}`])
  manifest.binaries[name] = createHash('sha256')
    .update(await readFile(join(output, name)))
    .digest('hex');
await writeFile(join(output, 'provenance.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Staged ${manifest.platform}/${manifest.arch} ${manifest.mode} runtime`);
