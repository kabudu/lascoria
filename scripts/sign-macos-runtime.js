import { verifyUniversalMacBinary } from './verify-universal-macos.js';
// Sign the staged runtime before the enclosing app is sealed. Update provenance only after
// both executables pass the actual Apple team requirement, so it describes distributed bytes.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function signMacRuntime(runtime, identity, team) {
  if (process.platform !== 'darwin') throw Error('Apple runtime signing requires macOS');
  if (!identity || !/^[A-Z0-9]{10}$/.test(team ?? ''))
    throw Error('Set APPLE_SIGNING_IDENTITY and LASCORIA_APPLE_TEAM_ID before signing');
  const provenance = JSON.parse(await readFile(join(runtime, 'provenance.json'), 'utf8'));
  if (provenance.platform !== 'darwin' || provenance.mode !== 'release')
    throw Error('Sign only a staged macOS release runtime');
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
  for (const name of ['node', 'constellation-supervisor']) {
    const file = join(runtime, name);
    if (provenance.arch === 'universal') verifyUniversalMacBinary(file);
    execFileSync(
      'codesign',
      [
        '--force',
        '--timestamp',
        '--options',
        'runtime',
        '--sign',
        identity,
        ...(name === 'node'
          ? ['--entitlements', resolve(import.meta.dirname, '../src-tauri/entitlements/node.plist')]
          : []),
        file,
      ],
      { stdio: 'inherit', timeout: 120000 },
    );
    execFileSync('codesign', ['--verify', '--strict', '-R', `=${requirement}`, file], {
      stdio: 'inherit',
      timeout: 30000,
    });
    provenance.binaries[name] = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  }
  provenance.signing = { kind: 'Developer ID', team };
  await writeFile(join(runtime, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
}

// Verify the copied/sealed bundle as well: a bundler must not silently alter signed bytes
// after provenance was recorded.
export async function verifyMacRuntime(runtime, team) {
  if (process.platform !== 'darwin' || !/^[A-Z0-9]{10}$/.test(team ?? ''))
    throw Error('macOS and LASCORIA_APPLE_TEAM_ID are required to verify the runtime');
  const provenance = JSON.parse(await readFile(join(runtime, 'provenance.json'), 'utf8'));
  if (
    provenance.platform !== 'darwin' ||
    provenance.mode !== 'release' ||
    provenance.signing?.kind !== 'Developer ID' ||
    provenance.signing.team !== team
  )
    throw Error('Runtime signing provenance does not match the release team');
  for (const name of ['node', 'constellation-supervisor']) {
    const file = join(runtime, name);
    if (provenance.arch === 'universal') verifyUniversalMacBinary(file);
    execFileSync(
      'codesign',
      [
        '--verify',
        '--strict',
        '-R',
        `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
        file,
      ],
      { stdio: 'inherit', timeout: 30000 },
    );
    const digest = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    if (provenance.binaries?.[name] !== digest)
      throw Error(`Signed runtime provenance hash mismatch: ${name}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === '--verify' && process.argv.length === 4)
    await verifyMacRuntime(resolve(process.argv[3]), process.env.LASCORIA_APPLE_TEAM_ID);
  else if (process.argv.length === 2)
    await signMacRuntime(
      resolve('.dev/bundle-runtime'),
      process.env.APPLE_SIGNING_IDENTITY,
      process.env.LASCORIA_APPLE_TEAM_ID,
    );
  else throw Error('Usage: sign-macos-runtime.js [--verify runtime-directory]');
}
