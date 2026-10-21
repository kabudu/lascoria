#!/usr/bin/env node
// Test-only byte forwarding around a real Muse process. No notifications are synthesized.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
const host = spawn(process.env.SCH_NATIVE_MUSE ?? 'muse', process.argv.slice(2), {
  stdio: ['pipe', 'pipe', 'inherit'],
});
process.stdin.pipe(host.stdin);
let buffer = '';
let sessionId;
let held = false;
const privateIds = new Set();
let probeSocket;
const gaps = [];
let replies = 0;
const errors = [];
host.stdout.setEncoding('utf8');
host.stdout.on('data', (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > 10 * 1024 * 1024)
    throw new Error('Proxy frame exceeds native transport limit');
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    const frame = JSON.parse(line);
    if (privateIds.delete(frame.id)) {
      if (frame.id === 'native-page-probe') {
        probeSocket.end(
          JSON.stringify({ error: frame.error, events: frame.result?.events?.length }) + '\n',
        );
        probeSocket = undefined;
        continue;
      }
      replies++;
      if (frame.error) errors.push(frame.error);
      continue;
    }
    if (frame.result?.session?.sessionId) sessionId = frame.result.session.sessionId;
    if (frame.method === 'view/gap') gaps.push(frame.params);
    if (!process.stdout.write(line + '\n')) host.stdout.pause();
  }
});
process.stdout.on('drain', () => {
  if (!held) host.stdout.resume();
});
const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let text = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    text += chunk;
    if (text.length > 1024) {
      socket.destroy();
      return;
    }
    if (!text.includes('\n')) return;
    const command = JSON.parse(text);
    if (command.operation === 'probe') {
      probeSocket = socket;
      privateIds.add('native-page-probe');
      host.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'native-page-probe',
          method: 'view/page',
          params: { sessionId, limit: 200 },
        }) + '\n',
      );
      return;
    }
    if (command.operation === 'hold') {
      held = true;
      host.stdout.pause();
    }
    if (command.operation === 'flood') {
      if (!sessionId || !held) throw new Error('Flood requires a held, initialized host');
      const id = 'native-saturation-read';
      privateIds.add(id);
      host.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'view/subscribe',
          params: { sessionId, after: '' },
        }) + '\n',
      );
    }
    if (command.operation === 'release') {
      held = false;
      host.stdout.resume();
    }
    socket.end(JSON.stringify({ replies, errors, gaps, hostPid: host.pid, held }) + '\n');
  });
});
if (existsSync(process.env.SCH_SATURATION_SOCKET)) unlinkSync(process.env.SCH_SATURATION_SOCKET);
server.listen(process.env.SCH_SATURATION_SOCKET, () =>
  chmodSync(process.env.SCH_SATURATION_SOCKET, 0o600),
);
host.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
host.on('exit', (code) => {
  server.close();
  process.stdin.destroy();
  process.stdout.end(() => process.exit(code ?? 1));
});
process.on('SIGTERM', () => host.kill('SIGTERM'));
