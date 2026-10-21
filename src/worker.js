// Dedicated entry point retained for diagnostics and compatibility fixtures.
import readline from 'node:readline';
import { createSession } from './session-worker.js';
const send = (value) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) process.exit(1);
  if (!process.stdout.write(text + '\n') && process.stdout.writableLength > 8 * 1024 * 1024)
    process.exit(1);
};
let slot;
try {
  slot = await createSession(send, (exit) => {
    send({ kind: 'death', exit });
    process.stdout.end(() => process.exit(1));
  });
  send(slot.ready);
} catch (error) {
  send({ kind: 'fatal', error: error.message });
  process.exit(1);
}
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let busy = false;
input.on('line', (line) => {
  if (busy || Buffer.byteLength(line) > 65536) process.exit(1);
  busy = true;
  void slot
    .handle(JSON.parse(line))
    .then(send)
    .finally(() => {
      busy = false;
    });
});
const close = () => {
  void slot.close().finally(() => process.exit(0));
};
input.on('close', close);
process.on('SIGTERM', close);
