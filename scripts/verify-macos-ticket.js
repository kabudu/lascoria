import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

// CloudKit can reset the connection even when the stapled ticket is valid. Retry
// only that response/transport failure; a bad or missing ticket still fails closed.
export async function verifyTicket(
  path,
  {
    run = (args) => spawnSync('/usr/bin/xcrun', args, { stdio: 'inherit', timeout: 30_000 }),
    pause = setTimeout,
  } = {},
) {
  const args = ['stapler', 'validate', path];
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = run(args);
    if (!result.error && result.status === 0) return;
    const retryable = result.status === 68 || result.error?.code === 'ETIMEDOUT';
    if (!retryable || attempt === 2) throw Error('macOS notarization ticket validation failed');
    await pause((attempt + 1) * 5000);
  }
}
