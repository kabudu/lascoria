// Build both distribution containers from the explicitly stapled, signed app.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { staple } from './staple-macos.js';

if (process.platform !== 'darwin') throw Error('Package macOS distribution on macOS');
const version = process.env.VERSION;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || ''))
  throw Error('Missing release version');
if (!process.env.APPLE_SIGNING_IDENTITY) throw Error('Missing Apple signing identity');
const bundle = resolve('src-tauri/target/release/bundle');
const app = join(bundle, 'macos/Lascoria.app');
const run = (program, args) =>
  execFileSync(program, args, {
    stdio: 'inherit',
    timeout: 180_000,
    maxBuffer: 2 * 1024 * 1024,
  });
if (await staple(['stapler', 'staple', '-v', app])) throw Error('Cannot staple release app');
run('/usr/bin/xcrun', ['stapler', 'validate', app]);
const archive = join(bundle, 'macos/Lascoria.app.tar.gz');
rmSync(archive, { force: true });
rmSync(`${archive}.sig`, { force: true });
run('/usr/bin/tar', ['-czf', archive, '-C', join(bundle, 'macos'), 'Lascoria.app']);
run('npx', ['tauri', 'signer', 'sign', '--app-version', version, archive]);
const root = mkdtempSync(join(tmpdir(), 'lascoria-dmg-'));
try {
  run('/usr/bin/ditto', [app, join(root, 'Lascoria.app')]);
  symlinkSync('/Applications', join(root, 'Applications'));
  mkdirSync(join(bundle, 'dmg'), { recursive: true });
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const image = join(bundle, 'dmg', `Lascoria_${version}_${arch}.dmg`);
  run('/usr/bin/hdiutil', [
    'create',
    '-ov',
    '-volname',
    'Lascoria',
    '-srcfolder',
    root,
    '-format',
    'UDZO',
    image,
  ]);
  run('/usr/bin/codesign', [
    '--force',
    '--timestamp',
    '--sign',
    process.env.APPLE_SIGNING_IDENTITY,
    image,
  ]);
  run('/usr/bin/codesign', ['--verify', '--strict', image]);
} finally {
  rmSync(root, { recursive: true, force: true });
}
