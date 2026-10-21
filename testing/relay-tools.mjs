// Lists the session helper's MCP tools for every session in a disposable QA state, without
// calling any tool (docs/native-acceptance.md, DA3). No model or provider request is made.
//
//   SCH_STATE_DIR=<qa state> node testing/relay-tools.mjs <constellation-supervisor binary>
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { request } from '../src/client.js';

const directory = process.env.SCH_STATE_DIR;
const supervisor = process.argv[2];
if (!directory || !supervisor) {
  console.error('Usage: SCH_STATE_DIR=<qa state> node testing/relay-tools.mjs <supervisor>');
  process.exit(2);
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const status = await request(directory, 'status', {});
for (const session of status.sessions) {
  const child = spawn(supervisor, ['--relay-mcp', session.id], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const replies = [];
  readline
    .createInterface({ input: child.stdout })
    .on('line', (line) => replies.push(JSON.parse(line)));
  const send = (message) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  send({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'qa', version: '1' },
    },
  });
  await pause(800);
  send({ method: 'notifications/initialized' });
  send({ id: 2, method: 'tools/list' });
  await pause(2000);
  const listed = replies.find((reply) => reply.id === 2);
  console.log(
    JSON.stringify({
      session: session.id,
      tools: listed?.result?.tools?.map((tool) => tool.name) ?? null,
      error: listed?.error?.message ?? null,
    }),
  );
  child.kill();
}
