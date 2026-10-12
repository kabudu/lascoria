#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from './client.js';

const [operation = 'help', json = '{}', id] = process.argv.slice(2);
const directory = process.env.SCH_STATE_DIR ?? join(homedir(), '.spatial-constellation');
const binary = resolve(
  fileURLToPath(new URL('../supervisor/target/debug/constellation-supervisor', import.meta.url)),
);
try {
  if (operation === 'supervisor') {
    const child = spawn(binary, [], { stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
  } else if (operation === 'up') {
    try {
      await request(directory, 'status', {}, undefined, 200);
      console.log('Supervisor already running');
    } catch {
      const child = spawn(binary, [], { detached: true, stdio: 'ignore' });
      child.on('error', (error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
      child.unref();
      let ready = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await request(directory, 'status', {}, undefined, 200);
          ready = true;
          break;
        } catch {}
      }
      if (!ready)
        throw new Error(
          'Supervisor did not become ready; run supervisor in the foreground for diagnostics',
        );
      console.log('Supervisor running independently');
    }
  } else if (operation === 'help') {
    console.log(
      'Usage: npm start -- up | supervisor | status | start|turn|steer|cancel|decide|answer|resume|stop JSON [stable-request-id]\nBuild first: npm run build. Set SCH_STATE_DIR, MUSE_BIN and SCH_PROVIDER. Default provider: echo.',
    );
  } else {
    const requestId = id ?? randomUUID();
    if (operation !== 'status') console.error('Request ID: ' + requestId);
    console.log(
      JSON.stringify(await request(directory, operation, JSON.parse(json), requestId), null, 2),
    );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
