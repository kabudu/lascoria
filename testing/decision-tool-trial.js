// R10 live acceptance for model (c): a signed-in Muse session, offered the decision tool,
// chooses to call it and uses the answer. Paid: one Muse task on your subscription and at
// most two decision requests on your own provider key. Never part of local CI.
//
//   SCH_STATE_DIR=<signed-in qa-launch live state> \
//     node testing/decision-tool-trial.js --paid <key directory> <jev|subq> <workspace>
//
// The key is read into memory from the private key file, saved through the normal supervisor
// API and forgotten again in finally. Only a public general-knowledge statement is sent.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from '../src/client.js';

const [approval, keyDirectory, provider, workspace] = process.argv.slice(2);
assert.equal(approval, '--paid', 'Pass --paid deliberately; this makes paid requests');
const files = { jev: '.typesafeai', subq: '.subq' };
assert.ok(files[provider], 'Choose jev or subq');
assert.ok(workspace, 'Pass the workspace folder of a session in this state');
const directory = process.env.SCH_STATE_DIR;
assert.ok(directory, 'Set SCH_STATE_DIR to the signed-in live QA state');
const call = (operation, params = {}, id = randomUUID()) =>
  request(directory, operation, params, id, 65000);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = () => call('decision/status');
const configure = async (operation, params) =>
  call(operation, { ...params, expectedRevision: (await settings()).revision });
const report = { provider, started: new Date().toISOString() };
let saved = false;
try {
  const status = await call('status');
  const host = status.sessions.find((s) => s.workspace === resolve(workspace) && s.state.current);
  assert.ok(host, 'Start a session in that workspace in the test app first');
  let key = (await readFile(join(resolve(keyDirectory), files[provider]), 'utf8'))
    .trim()
    .replace(/^[A-Z_][A-Z_0-9]*\s*[:=]\s*/, '')
    .replace(/^Bearer\s+/i, '');
  saved = true;
  await configure('decision/setKey', { provider, apiKey: key });
  key = '';
  const defaults = (await settings()).providers.find((p) => p.id === provider);
  await configure('decision/configure', {
    provider,
    model: defaults.defaultModel,
    enabled: true,
  });
  await configure('decision/configureMode', { mode: 'tool', provider, dailyLimit: 10 });
  await configure('decision/configureMode', {
    mode: 'tool',
    sessionId: host.id,
    workspaceEnabled: true,
  });
  // Muse lists its tools when a session starts, so start one now that the tool is on.
  const started = await call('start', { workspace: resolve(workspace) }, randomUUID());
  const sessionId = started.sessionId;
  for (let i = 0; i < 150; i++) {
    const s = (await call('status')).sessions.find((r) => r.id === sessionId);
    if (s?.state.current) break;
    await pause(200);
  }
  const statement = 'The Pacific Ocean is the largest ocean on Earth.';
  const task = await call(
    'turn',
    {
      sessionId,
      text: `Use your ask_decision_assistant tool exactly once, as a yes_no question asking whether this statement is true, with only the statement itself as context: "${statement}" Then reply with the probability it returned and nothing else. Do not read or change any files.`,
    },
    randomUUID(),
  );
  report.turn = task.status;
  let row;
  for (let i = 0; i < 600; i++) {
    row = (await call('status')).sessions.find((r) => r.id === sessionId);
    if (row.state.turns?.some((t) => t.turnId === task.result.turnId && t.terminal)) break;
    await pause(500);
  }
  const turn = row.state.turns.find((t) => t.turnId === task.result.turnId);
  const items = row.state.items.filter((i) => i.turnId === task.result.turnId);
  const runs = (await settings()).recent.filter(
    (r) => r.purpose === 'museTool' && r.source?.sessionId === sessionId,
  );
  report.terminal = turn?.terminal;
  report.toolCalls = items
    .filter((i) => i.kind === 'toolCall')
    .map((i) => ({ name: i.toolName ?? i.name ?? i.statusLine, status: i.status }));
  report.decisionRuns = runs.map((r) => ({
    status: r.status,
    model: r.result?.model,
    answer: r.result?.answer,
    inputBytes: r.inputBytes,
    latencyMs: r.latencyMs,
  }));
  report.reply = items
    .filter((i) => i.kind === 'agentMessage')
    .map((i) => i.text)
    .join('\n')
    .slice(0, 500);
  report.passed =
    turn?.terminal === 'completed' &&
    runs.length >= 1 &&
    runs.length <= 2 &&
    runs.every((r) => r.status === 'completed');
} finally {
  if (saved)
    await configure('decision/forgetKey', { provider }).catch((e) => {
      report.cleanup = `Could not confirm forgetting the key: ${e.message}`;
    });
  console.log(JSON.stringify(report, null, 2));
}
if (!report.passed || report.cleanup) process.exitCode = 1;
