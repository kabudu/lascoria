import { spawnSync } from 'node:child_process';

// Keep credentials out of thrown subprocess errors and require an accepted result.
export function notarize(file, { env = process.env, run = spawnSync } = {}) {
  if (!env.APPLE_ID || !env.APPLE_PASSWORD || !env.APPLE_TEAM_ID)
    throw Error('Missing Apple notarization credentials');
  let result;
  try {
    result = run(
      '/usr/bin/xcrun',
      [
        'notarytool',
        'submit',
        file,
        '--apple-id',
        env.APPLE_ID,
        '--password',
        env.APPLE_PASSWORD,
        '--team-id',
        env.APPLE_TEAM_ID,
        '--wait',
        '--timeout',
        '10m',
        '--output-format',
        'json',
      ],
      { encoding: 'utf8', timeout: 12 * 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch {
    throw Error('Apple notarization command failed');
  }
  let status;
  try {
    status = JSON.parse(result.stdout).status;
  } catch {
    /* Refuse malformed output. */
  }
  if (result.error || result.status !== 0 || status !== 'Accepted')
    throw Error('Apple did not accept the final macOS disk image');
}
