import net from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bounded } from './runtime.js';

export async function request(
  directory,
  operation,
  params = {},
  id = randomUUID(),
  timeoutMs = 30000,
) {
  const token = readFileSync(join(directory, 'token'), 'utf8');
  const endpoint =
    process.platform === 'win32'
      ? JSON.parse(readFileSync(join(directory, 'ipc.json'), 'utf8')).pipe
      : join(directory, 'supervisor.sock');
  if (process.platform === 'win32' && !/^\\\\\.\\pipe\\lascoria-[a-f0-9]{64}$/.test(endpoint))
    throw new Error('Invalid local pipe endpoint');
  const socket = net.createConnection(endpoint);
  socket.setEncoding('utf8');
  try {
    return await bounded(
      new Promise((resolve, reject) => {
        let data = '';
        socket.on('error', reject);
        socket.on('connect', () =>
          socket.write(JSON.stringify({ version: 1, token, id, operation, params }) + '\n'),
        );
        socket.on('data', (chunk) => {
          data += chunk;
          if (Buffer.byteLength(data) > 40 * 1024 * 1024) {
            reject(new Error('Response limit exceeded'));
            socket.destroy();
          }
        });
        socket.on('end', () => {
          try {
            const response = JSON.parse(data);
            if (response.error) reject(new Error(response.error));
            else resolve(response.result);
          } catch (error) {
            reject(error);
          }
        });
      }),
      timeoutMs,
    );
  } finally {
    socket.destroy();
  }
}
