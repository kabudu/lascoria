import { execFileSync } from 'node:child_process';

export function verifyUniversalMacBinary(file) {
  const slices = execFileSync('/usr/bin/lipo', ['-archs', file], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4096,
  })
    .trim()
    .split(/\s+/);
  if (!slices.includes('arm64') || !slices.includes('x86_64'))
    throw Error(`Universal macOS binary requires arm64 and x86_64: ${file}`);
}
