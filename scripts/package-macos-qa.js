// Unsigned macOS validation app for native acceptance (docs/native-acceptance.md). Ad hoc
// signed only, so it runs on this Mac; this is not a release artifact and is never published.
import { rename, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'darwin') throw Error('Build the macOS validation app on macOS');
const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
// tauri build runs desktop:prepare (release UI and runtime) and embeds the frontend.
execFileSync(
  'npx',
  [
    'tauri',
    'build',
    '--bundles',
    'app',
    '--config',
    JSON.stringify({
      identifier: 'dev.lascoria.acceptance',
      productName: 'Lascoria Acceptance',
      app: { windows: config.app.windows.map((window) => ({ ...window, title: 'Lascoria QA' })) },
      bundle: { active: true },
    }),
  ],
  { cwd: root, stdio: 'inherit' },
);
const built = join(root, 'src-tauri/target/release/bundle/macos/Lascoria Acceptance.app');
const output = join(root, '.dev/macos-qa');
const app = join(output, 'Lascoria Acceptance.app');
await rm(app, { recursive: true, force: true });
await mkdir(output, { recursive: true });
// A dedicated acceptance identifier plus one bundle and a distinct executable prevent
// automation/Launch Services from selecting the user's normal app or a second
// build-directory copy with the same identity.
await rename(built, app);
await rename(
  join(app, 'Contents/MacOS/spatial-constellation-desktop'),
  join(app, 'Contents/MacOS/LascoriaAcceptance'),
);
execFileSync('plutil', [
  '-replace',
  'CFBundleExecutable',
  '-string',
  'LascoriaAcceptance',
  join(app, 'Contents/Info.plist'),
]);
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
const binary = join(app, 'Contents/MacOS/LascoriaAcceptance');
const runtime = join(app, 'Contents/Resources/runtime');
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const provenance = {
  purpose: 'native validation; unsigned (ad hoc)',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) !== '',
  desktopSha256: await hash(binary),
  supervisorSha256: await hash(join(runtime, 'constellation-supervisor')),
  runtime: JSON.parse(await readFile(join(runtime, 'provenance.json'), 'utf8')),
};
await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ app, ...provenance }, null, 2));
