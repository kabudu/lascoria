// Delayed protocol fixture. Exercises Rust scheduling, not native Muse behavior.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const log = (value) => appendFileSync(process.env.SCH_SCHEDULING_LOG, JSON.stringify(value) + '\n');
emit({ kind: 'ready', durability: 'durable', handshake: { fixture: true } });
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  log({ operation: message.operation, params: message.params });
  if (message.operation === 'turn' && message.params?.text === 'auth-failure') {
    emit({
      kind: 'state',
      state: {
        current: true,
        activeTurnId: null,
        approvals: [],
        userInputs: [],
        items: [],
        turns: [
          {
            turnId: 'fixture-auth-failure',
            commandId: message.commandId,
            state: 'settled',
            terminal: 'failed',
            error: { kind: 'authRequired', message: 'Fixture credential expired' },
          },
        ],
      },
    });
    emit({ kind: 'response', id: message.id, result: { sessionId: message.params.sessionId } });
    return;
  }
  if (message.operation === 'resume' || message.params?.text === 'slow')
    await new Promise((resolve) => setTimeout(resolve, 3000));
  emit({
    kind: 'state',
    state: { current: true, activeTurnId: null, approvals: [], userInputs: [], items: [] },
  });
  emit({ kind: 'response', id: message.id, result: { sessionId: message.params.sessionId } });
});
