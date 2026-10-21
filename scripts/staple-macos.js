// Tauri's stapling helper currently ignores the subprocess exit status. Retry the
// read-only ticket fetch, then independently verify the packaged app before upload.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function staple(
  args,
  {
    run = (args) => spawnSync('/usr/bin/xcrun', args, { stdio: 'inherit', timeout: 30_000 }),
    pause = setTimeout,
  } = {},
) {
  if (args[0] !== 'stapler' || args[1] !== 'staple')
    throw Error('This helper only handles ticket stapling');
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = run(args);
    if (!result.error && result.status === 0) return 0;
    if (attempt < 2) await pause((attempt + 1) * 5000);
  }
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename)
  process.exitCode = await staple(process.argv.slice(2));
