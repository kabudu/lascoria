// Isolated macOS validation app (docs/native-acceptance.md), never published. Default is
// ad hoc; --developer-id proves the release-team boundary using an existing local identity.
import { rename, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { signMacRuntime, verifyMacRuntime } from './sign-macos-runtime.js';
if (process.platform !== 'darwin') throw Error('Build the macOS validation app on macOS');
if (process.argv.slice(2).some((arg) => !['--developer-id', '--update-acceptance'].includes(arg)))
  throw Error('Usage: package-macos-qa.js [--developer-id] [--update-acceptance]');
const signed = process.argv.includes('--developer-id');
const updateAcceptance = process.argv.includes('--update-acceptance');
if (
  updateAcceptance &&
  (!signed ||
    !process.env.LASCORIA_QA_UPDATER_ENDPOINT ||
    !process.env.LASCORIA_QA_UPDATER_CERT_PEM ||
    !process.env.LASCORIA_UPDATER_PUBKEY)
)
  throw Error(
    'Update acceptance requires Developer ID signing, a loopback endpoint, fixture CA and QA public key',
  );
const identity = process.env.APPLE_SIGNING_IDENTITY;
const team = process.env.LASCORIA_APPLE_TEAM_ID;
if (signed && (!identity || !/^[A-Z0-9]{10}$/.test(team ?? '')))
  throw Error('Set APPLE_SIGNING_IDENTITY and LASCORIA_APPLE_TEAM_ID for signed QA');
const buildEnv = { ...process.env, APPLE_SIGNING_IDENTITY: '-' };
// QA is local, never an implicit notarization request. Only signed QA compiles the team gate.
for (const name of [
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_CERTIFICATE',
  'APPLE_API_KEY',
  'APPLE_API_ISSUER',
  'APPLE_API_KEY_PATH',
])
  delete buildEnv[name];
if (!signed) delete buildEnv.LASCORIA_APPLE_TEAM_ID;
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
    ...(updateAcceptance ? ['--features', 'update-acceptance'] : []),
    '--config',
    JSON.stringify({
      identifier: 'dev.lascoria.acceptance',
      productName: 'Lascoria Acceptance',
      app: { windows: config.app.windows.map((window) => ({ ...window, title: 'Lascoria QA' })) },
      bundle: { active: true },
      ...(updateAcceptance
        ? { plugins: { updater: { pubkey: process.env.LASCORIA_UPDATER_PUBKEY } } }
        : {}),
    }),
  ],
  { cwd: root, stdio: 'inherit', env: buildEnv },
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
if (signed) {
  await signMacRuntime(join(app, 'Contents/Resources/runtime'), identity, team);
  execFileSync(
    'codesign',
    ['--force', '--timestamp', '--options', 'runtime', '--sign', identity, app],
    { stdio: 'inherit', timeout: 120000 },
  );
  execFileSync(
    'codesign',
    [
      '--verify',
      '--deep',
      '--strict',
      '-R',
      `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
      app,
    ],
    { stdio: 'inherit', timeout: 30000 },
  );
  await verifyMacRuntime(join(app, 'Contents/Resources/runtime'), team);
} else execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
const binary = join(app, 'Contents/MacOS/LascoriaAcceptance');
const runtime = join(app, 'Contents/Resources/runtime');
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const provenance = {
  updateAcceptance,
  purpose: signed
    ? 'native validation; Developer ID signed, not notarized'
    : 'native validation; unsigned (ad hoc)',
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }) !== '',
  desktopSha256: await hash(binary),
  supervisorSha256: await hash(join(runtime, 'constellation-supervisor')),
  runtime: JSON.parse(await readFile(join(runtime, 'provenance.json'), 'utf8')),
};
await writeFile(join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ app, ...provenance }, null, 2));
