// Private SDK bridge. Only the Rust supervisor owns the public control API.
import readline from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { bounded, spawnRuntime } from './runtime.js';

class ValidationError extends Error {}
let sessionId;
let eventCount = 0;
let eventBytes = 0;
let stale = false;
let closing = false;
let opening = false;
let acceptedReceipt;
let staleReason;
let runtime;
const gaps = [];
let gapRecovery;
let stateTimer;
const stateFacts = new Map();
function publishState(facts = [], immediate = false) {
  for (const fact of facts) {
    if (!fact.commandId) continue;
    stateFacts.set(fact.commandId + fact.method, fact);
    if (stateFacts.size > 2000) {
      process.stderr.write('State fact budget exhausted\n');
      process.exit(1);
    }
  }
  if (immediate) {
    clearTimeout(stateTimer);
    stateTimer = undefined;
    send({ kind: 'state', state: snapshot(), facts: [...stateFacts.values()] });
    stateFacts.clear();
  } else if (!stateTimer) stateTimer = setTimeout(() => publishState([], true), 25);
}
const commandFact = (event) => ({
  method: event.method,
  commandId: event.params.commandId ?? event.params.decidedByCommandId,
});
const send = (value, flushed) => {
  const frame = JSON.stringify(value);
  if (Buffer.byteLength(frame) > 4 * 1024 * 1024) {
    process.stderr.write('SDK worker response exceeds frame budget\n');
    process.exit(1);
  }
  if (
    !process.stdout.write(frame + '\n', flushed) &&
    process.stdout.writableLength > 8 * 1024 * 1024
  )
    process.exit(1);
};
function snapshot() {
  const fold = runtime?.session?.fold;
  return {
    sessionId,
    current: !stale && !opening && !!fold?.current,
    sessionState: Object.fromEntries(
      (fold?.sessionState.families() ?? []).map((family) => [
        family,
        fold.sessionState.get(family),
      ]),
    ),
    turns: fold?.turns().slice(-100) ?? [],
    gap: fold?.pendingGap,
    gaps,
    failure: staleReason,
    activeTurnId: fold?.activeTurnId,
    // Gap splice and cold replay can discover items in different insertion order.
    // Order this presentation window by native time and ID, without changing the SDK fold.
    items:
      fold?.items
        .list()
        .sort(
          (left, right) =>
            (left.recordedAt ?? '').localeCompare(right.recordedAt ?? '') ||
            left.itemId.localeCompare(right.itemId),
        )
        .slice(-100) ?? [],
    totalItems: fold?.items.size ?? 0,
    itemsTruncated: (fold?.items.size ?? 0) > 100,
    approvals: fold?.pendingApprovals() ?? [],
    userInputs: fold?.pendingUserInputs() ?? [],
    eventCount,
    eventBytes,
  };
}
try {
  runtime = await spawnRuntime(
    { binary: process.env.MUSE_BIN, provider: process.env.SCH_PROVIDER ?? 'echo' },
    (event) => {
      if (event.params?.sessionId !== sessionId) return;
      eventCount++;
      eventBytes += Buffer.byteLength(JSON.stringify(event));
      if (eventCount > 10000 || eventBytes > 32 * 1024 * 1024) {
        stale = true;
        staleReason = 'Diagnostic event budget exhausted';
      }
      if (event.method === 'view/gap' && !gapRecovery) runtime.beginGap();
      const applied = !stale ? runtime.session.apply(event) : undefined;
      if (event.method === 'view/gap' && !stale) {
        gaps.push({
          ...event.params,
          observedAtMillis: Date.now(),
          recovered: false,
          unavailableDuringFill: !runtime.session.fold.current,
        });
        if (gaps.length > 20) gaps.shift();
        if (!gapRecovery) {
          gapRecovery = bounded(applied.io, 60000)
            .then(() => {
              if (!runtime.session.fold.current) {
                stale = true;
                staleReason = runtime.gapFailure ?? 'Muse stream gap could not be filled';
                publishState([], true);
                return runtime.close().then(() => process.exit(1));
              }
              for (const gap of gaps)
                if (!gap.recovered) {
                  gap.recovered = true;
                  gap.recoveredAtMillis = Date.now();
                }
              publishState([], true);
            })
            .catch((error) => {
              stale = true;
              staleReason = error.message;
              publishState([], true);
              return runtime.close().then(() => process.exit(1));
            })
            .finally(() => {
              gapRecovery = undefined;
            });
        }
      }
      publishState([commandFact(event)], event.method === 'view/gap' || stale);
      if (stale) void runtime.close().then(() => process.exit(1));
    },
    (exit) => {
      send({ kind: 'death', exit }, () => {
        if (!closing) process.exit(1);
      });
    },
  );
  send({ kind: 'ready', handshake: runtime.handshake, durability: runtime.profile.kind });
} catch (error) {
  send({ kind: 'fatal', error: error.message }, () => process.exit(1));
}

async function execute(message) {
  const { operation, params, commandId } = message;
  if (operation === 'stop') {
    closing = true;
    await runtime.close();
    return {};
  }
  if (operation === 'start' || operation === 'resume') {
    if (operation === 'resume' && runtime.profile.kind !== 'durable')
      throw new ValidationError('Recovery unsupported for this durability');
    opening = true;
    sessionId = params.sessionId;
    runtime.attach(sessionId, []);
    const result = await runtime.command(
      operation === 'start' ? 'session/start' : 'session/resume',
      operation === 'start'
        ? { sessionId, workspaceRoot: params.workspace }
        : { sessionId, excludeItems: true },
      commandId,
    );
    acceptedReceipt = result;
    if (operation === 'resume') {
      await runtime.request('view/unsubscribe', { sessionId });
      const events = [];
      let cursor;
      let bytes = 0;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await runtime.request('view/page', {
          sessionId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const event of page.events) {
          events.push(event);
          bytes += Buffer.byteLength(JSON.stringify(event));
          if (events.length > 10000 || bytes > 32 * 1024 * 1024)
            throw new ValidationError('Recovery history exceeds diagnostic bounds');
        }
        const last = page.events.at(-1)?.params.viewCursor;
        if (last) cursor = last;
        if (page.nextCursor === null) break;
        if (!last || pageNumber === 99)
          throw new ValidationError('Recovery paging did not converge');
      }
      runtime.attach(sessionId, events);
      eventCount = events.length;
      eventBytes = bytes;
      stale = false;
      await runtime.request('view/subscribe', { sessionId, ...(cursor ? { after: cursor } : {}) });
      if (!runtime.session.fold.current)
        throw new ValidationError('Recovery did not produce current state');
      opening = false;
      publishState(events.map(commandFact), true);
    }
    opening = false;
    publishState([], true);
    return result;
  }
  if (stale || !runtime.session?.fold.current || sessionId !== params.sessionId)
    throw new ValidationError('Session state is not current');
  let method;
  let wire;
  if (operation === 'turn' || operation === 'steer') {
    if (typeof params.text !== 'string' || !params.text.length || params.text.length > 16000)
      throw new ValidationError('Text must be 1..16000 characters');
    method = operation === 'turn' ? 'turn/start' : 'turn/steer';
    wire = { sessionId, input: [{ type: 'text', text: params.text }] };
    if (operation === 'steer') {
      if (!params.turnId || runtime.session.fold.activeTurnId !== params.turnId)
        throw new ValidationError('Stale steering target');
      wire.expectedTurnId = params.turnId;
    }
  } else if (operation === 'cancel') {
    if (!params.turnId || runtime.session.fold.activeTurnId !== params.turnId)
      throw new ValidationError('Stale cancellation target');
    method = 'turn/cancel';
    wire = { sessionId, turnId: params.turnId };
  } else if (operation === 'decide') {
    const pending = await runtime.request('approval/listPending', { sessionId });
    const approval = pending.approvals.find((a) => a.approvalId === params.approvalId);
    if (!approval || !isDeepStrictEqual(approval.currentRequirementId, params.requirementId))
      throw new ValidationError('Stale approval; refresh status');
    if (!approval.availableChoices.some((choice) => choice.choiceId === params.choiceId))
      throw new ValidationError('Choice not offered by Muse');
    method = 'approval/decide';
    wire = {
      sessionId,
      approvalId: params.approvalId,
      requirementId: params.requirementId,
      choiceId: params.choiceId,
    };
  } else if (operation === 'answer') {
    const pending = await runtime.request('approval/listPending', { sessionId });
    if (!pending.userInputs.some((input) => input.userInputId === params.userInputId))
      throw new ValidationError('Stale user input');
    method = 'userInput/answer';
    wire = { sessionId, userInputId: params.userInputId, answers: params.answers };
  } else throw new ValidationError('Unsupported operation');
  return runtime.command(method, wire, commandId);
}

// Rust serializes requests. Reject overlapping frames rather than accumulating work.
let busy = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (busy || Buffer.byteLength(line) > 65536) {
    process.stderr.write('Invalid worker request framing\n');
    process.exit(1);
  }
  busy = true;
  void (async () => {
    let message;
    try {
      acceptedReceipt = undefined;
      message = JSON.parse(line);
      const result = await execute(message);
      publishState([], true);
      send({ kind: 'response', id: message.id, result });
    } catch (error) {
      send({
        kind: 'response',
        id: message?.id,
        error: {
          message: error.message,
          rejected:
            !acceptedReceipt && (runtime.isRejection(error) || error instanceof ValidationError),
          receipt: acceptedReceipt,
          kind: error.kind,
          code: error.code,
        },
      });
    } finally {
      busy = false;
    }
  })();
});
input.on('close', () => {
  closing = true;
  void runtime.close().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  closing = true;
  void runtime.close().finally(() => process.exit(0));
});
