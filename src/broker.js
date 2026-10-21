// One V8 heap, at most ten independent SDK/Muse session contexts. Private Rust transport.
import readline from 'node:readline';
import { createSession } from './session-worker.js';
const slots = new Map();
let closing = false;
const send = (value) => {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 4 * 1024 * 1024) process.exit(1);
  if (!process.stdout.write(line + '\n') && process.stdout.writableLength > 8 * 1024 * 1024)
    process.exit(1);
};
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (closing || Buffer.byteLength(line) > 65536) process.exit(1);
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
      const { slot: key, sessionId, generation } = message;
      if (
        typeof key !== 'string' ||
        key !== `${sessionId}:${generation}` ||
        !Number.isSafeInteger(generation) ||
        generation < 1
      )
        throw Error('Invalid broker slot');
      const emit = (frame) => send({ ...frame, slot: key });
      if (message.operation === 'open') {
        if (slots.has(key) || slots.size >= 10) throw Error('Broker slot limit or duplicate open');
        const reservation = { session: null, opening: null, dead: false };
        slots.set(key, reservation);
        try {
          reservation.opening = createSession(emit, (exit) => {
            if (slots.get(key) === reservation) {
              reservation.dead = true;
              emit({ kind: 'death', exit });
            }
          });
          reservation.session = await reservation.opening;
          if (closing || slots.get(key) !== reservation) {
            await reservation.session.close();
            throw Error('Slot closed during initialization');
          }
          emit({ kind: 'response', id: message.id, result: reservation.session.ready });
        } catch (error) {
          if (slots.get(key) === reservation) slots.delete(key);
          throw error;
        }
      } else if (message.operation === 'close') {
        const entry = slots.get(key);
        if (entry) {
          slots.delete(key);
          await closeEntry(entry);
        }
        emit({ kind: 'response', id: message.id, result: { closed: true } });
      } else {
        const entry = slots.get(key);
        if (!entry?.session || entry.dead) throw Error('Session context unavailable');
        emit(await entry.session.handle(message.request));
      }
    } catch (error) {
      send({
        kind: 'response',
        slot: message?.slot,
        id: message?.id,
        error: { message: error.message },
      });
    }
  })();
});
async function closeEntry(entry) {
  const session = entry.session ?? (await entry.opening?.catch(() => null));
  await session?.close();
}
async function close() {
  if (closing) return;
  closing = true;
  input.close();
  await Promise.allSettled([...slots.values()].map(closeEntry));
  slots.clear();
  process.exit(0);
}
input.on('close', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
