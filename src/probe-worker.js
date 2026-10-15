// A protocol handshake only: no session, provider request or model turn is created.
import { spawnRuntime } from './runtime.js';
try {
  const runtime = await spawnRuntime(
    { binary: process.env.MUSE_BIN, provider: 'echo' },
    () => {},
    () => {},
  );
  await runtime.close();
  process.stdout.write(JSON.stringify({ compatible: true }) + '\n');
} catch {
  process.stdout.write(JSON.stringify({ compatible: false }) + '\n');
  process.exitCode = 1;
}
