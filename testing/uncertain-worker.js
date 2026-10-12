// Controlled failure fixture for Rust journal tests, not a Muse substitute.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\n');
emit({
  kind: 'ready',
  durability: process.env.SCH_FIXTURE_DURABILITY ?? 'durable',
  handshake: { fixture: true },
});
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.operation === 'resume' && process.env.SCH_FIXTURE_REJECT_RESUME) {
    appendFileSync(process.env.SCH_FIXTURE_ACTIONS, 'resume\n');
    emit({
      kind: 'response',
      id: message.id,
      error: { rejected: true, message: 'Injected resume refusal' },
    });
    return;
  }
  if (message.operation === 'turn') {
    appendFileSync(process.env.SCH_FIXTURE_ACTIONS, message.commandId + '\n');
    // Deliberately withhold the acknowledgement after an external action.
    return;
  }
  emit({ kind: 'state', state: { current: true, approvals: [], userInputs: [], items: [] } });
  emit({ kind: 'response', id: message.id, result: { sessionId: message.params.sessionId } });
});
input.on('close', () => process.exit(0));
