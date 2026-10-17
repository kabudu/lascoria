// Experimental account surface, isolated from transcript/session workers. No API keys cross this protocol.
import readline from 'node:readline';
import { spawnMspConnection } from '@muse-code/sdk';
import { bounded } from './runtime.js';
import { MUSE_VERSION } from './muse-version.js';
const transport = spawnMspConnection({
  command: process.env.MUSE_BIN ?? 'muse',
  args: ['serve', '--provider', 'meta'],
  shutdownTimeoutMs: 2000,
});
const host = await bounded(
  transport.initialize({
    clientInfo: { name: 'lascoria_account', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  }),
);
if (
  host.fingerprintWarning ||
  host.initializeResult.serverInfo.version !== MUSE_VERSION ||
  !host.initializeResult.experimentalApi
) {
  await host.close();
  throw new Error('Compatible Muse account API unavailable');
}
let outcome;
host.connection.onNotification((event) => {
  if (event.method === 'account/loginCompleted') outcome = event.params.outcome;
});
const input = readline.createInterface({ input: process.stdin });
let busy = false;
input.on('line', (line) => {
  if (busy || Buffer.byteLength(line) > 1024) process.exit(1);
  busy = true;
  void (async () => {
    try {
      const { operation } = JSON.parse(line);
      let result;
      if (operation === 'read')
        result = { account: await bounded(host.connection.request('account/read', {})), outcome };
      else if (operation === 'login') {
        outcome = undefined;
        result = await bounded(
          host.connection.request('account/loginStart', { type: 'deviceCode' }),
        );
      } else if (operation === 'cancel')
        result = await bounded(host.connection.request('account/loginCancel', {}));
      else throw new Error('Unsupported account operation');
      process.stdout.write(JSON.stringify({ result }) + '\n');
    } catch {
      // Never echo protocol payloads or upstream credential errors.
      process.stdout.write(
        JSON.stringify({ error: 'Muse account operation failed; reconnect and try again' }) + '\n',
      );
    } finally {
      busy = false;
    }
  })();
});
async function close() {
  await host.close();
  process.exit(0);
}
input.on('close', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
