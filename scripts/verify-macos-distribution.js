// Inspect actual packaged bytes, rather than trusting a successful notary submission.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { verifyTicket } from './verify-macos-ticket.js';

if (process.platform !== 'darwin') throw Error('Verify macOS distribution on macOS');
const bundle = resolve(process.env.LASCORIA_BUNDLE_DIR || 'src-tauri/target/release/bundle');
const root = mkdtempSync(join(tmpdir(), 'lascoria-distribution-'));
const mount = join(root, 'mount');
const archive = join(root, 'archive');
const run = (program, args) =>
  execFileSync(program, args, {
    stdio: 'inherit',
    timeout: 120_000,
    maxBuffer: 2 * 1024 * 1024,
  });
const verify = async (app) => {
  if (process.env.LASCORIA_UNIVERSAL === '1') {
    for (const binary of [
      'MacOS/spatial-constellation-desktop',
      'Resources/runtime/node',
      'Resources/runtime/constellation-supervisor',
    ])
      run('/usr/bin/lipo', ['-verify_arch', 'arm64', 'x86_64', join(app, 'Contents', binary)]);
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  await verifyTicket(app);
};
let mountAttempted = false;
try {
  await verify(join(bundle, 'macos/Lascoria.app'));
  mkdirSync(archive);
  run('/usr/bin/tar', ['-xzf', join(bundle, 'macos/Lascoria.app.tar.gz'), '-C', archive]);
  await verify(join(archive, 'Lascoria.app'));
  const { readdirSync } = await import('node:fs');
  const images = readdirSync(join(bundle, 'dmg')).filter((name) => name.endsWith('.dmg'));
  if (images.length !== 1) throw Error('Expected exactly one macOS disk image');
  const image = join(bundle, 'dmg', images[0]);
  run('/usr/bin/codesign', ['--verify', '--strict', image]);
  await verifyTicket(image);
  run('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'open',
    '--context',
    'context:primary-signature',
    '--verbose=2',
    image,
  ]);
  mkdirSync(mount);
  mountAttempted = true;
  run('/usr/bin/hdiutil', [
    'attach',
    join(bundle, 'dmg', images[0]),
    '-readonly',
    '-nobrowse',
    '-mountpoint',
    mount,
  ]);
  await verify(join(mount, 'Lascoria.app'));
  run('/usr/sbin/spctl', [
    '--assess',
    '--type',
    'execute',
    '--verbose=2',
    join(mount, 'Lascoria.app'),
  ]);
} finally {
  if (mountAttempted) run('/usr/bin/hdiutil', ['detach', mount]);
  rmSync(root, { recursive: true, force: true });
}
console.log('Packaged macOS signatures, stapled tickets and Gatekeeper acceptance passed.');
