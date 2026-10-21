// Explicit local acceptance, outside CI: needs an existing Developer ID identity and the
// --developer-id QA bundle. Uses disposable state and no account/model/provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { request } from '../src/client.js';
import { bounded } from '../src/runtime.js';
import { createHash } from 'node:crypto';
import { verifyMacRuntime } from '../scripts/sign-macos-runtime.js';
const identity = process.env.APPLE_SIGNING_IDENTITY;
const team = process.env.LASCORIA_APPLE_TEAM_ID;
if (process.platform !== 'darwin' || !identity || !/^[A-Z0-9]{10}$/.test(team ?? ''))
  throw Error('Run on macOS with APPLE_SIGNING_IDENTITY and LASCORIA_APPLE_TEAM_ID');
const resources = resolve('.dev/macos-qa/Lascoria Acceptance.app/Contents/Resources/runtime');
await verifyMacRuntime(resources, team);
const root = await mkdtemp('/tmp/lascoria-sign-');
const desktop = join(root, 'signed-client');
const directory = join(root, 'state');
let daemon;
try {
  // A minimal native peer exercises the real socket peer PID and running-code checks. Its
  // trusted executable path stays identical while its signature changes underneath it.
  const source = join(root, 'client.c');
  await writeFile(
    source,
    `#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  char token_path[1024], token[256] = {0};
  snprintf(token_path, sizeof token_path, "%s/token", argv[1]);
  FILE *file = fopen(token_path, "r"); if (!file) return 3;
  if (!fgets(token, sizeof token, file)) { fclose(file); return 4; } fclose(file);
  token[strcspn(token, "\\r\\n")] = 0;
  struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
  if (snprintf(address.sun_path, sizeof address.sun_path, "%s/supervisor.sock", argv[1]) >= sizeof address.sun_path) return 5;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return 6;
  struct timeval wait = {.tv_sec = 2};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &wait, sizeof wait);
  if (connect(fd, (struct sockaddr *)&address, sizeof address)) { close(fd); return 7; }
  char payload[1024];
  int length = snprintf(payload, sizeof payload, "{\\"version\\":1,\\"token\\":\\"%s\\",\\"id\\":\\"signing-proof\\",\\"operation\\":\\"status\\",\\"params\\":{}}\\n", token);
  if (write(fd, payload, length) != length) { close(fd); return 8; }
  char bytes[4096]; ssize_t count;
  while ((count = read(fd, bytes, sizeof bytes)) > 0) {
    if (fwrite(bytes, 1, count, stdout) != count) { close(fd); return 9; }
    if (memchr(bytes, '\\n', count)) break;
  }
  close(fd); return count > 0 ? 0 : 10;
}
`,
  );
  execFileSync('clang', ['-Wall', '-Werror', source, '-o', desktop], { timeout: 30000 });
  const sign = (who) =>
    execFileSync(
      'codesign',
      [
        '--force',
        ...(who === '-' ? [] : ['--timestamp', '--options', 'runtime']),
        '--sign',
        who,
        desktop,
      ],
      { stdio: 'pipe', timeout: 120000 },
    );
  sign(identity);
  execFileSync(
    'codesign',
    [
      '--verify',
      '--strict',
      '-R',
      `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`,
      desktop,
    ],
    { timeout: 30000 },
  );
  daemon = spawn(join(resources, 'constellation-supervisor'), [], {
    env: {
      ...process.env,
      SCH_STATE_DIR: directory,
      SCH_DESKTOP_EXE: desktop,
      SCH_RESOURCES: resources,
      SCH_NODE: join(resources, 'node'),
      SCH_PROVIDER: 'echo',
      SCH_AUTH_MANAGED: '0',
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
    },
    stdio: 'ignore',
  });
  const call = () =>
    JSON.parse(execFileSync(desktop, [directory], { timeout: 3000, encoding: 'utf8' }));
  let accepted;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      accepted = call();
      if (accepted.result?.pid === daemon.pid) break;
    } catch {}
    if (daemon.exitCode !== null) throw Error('Signed supervisor exited during startup');
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(accepted?.result?.pid, daemon.pid, 'the signed running peer is accepted');
  await assert.rejects(request(directory, 'status'), /Only the Lascoria app/);
  sign('-');
  const refused = call();
  assert.match(
    refused.error,
    /not signed by Lascoria/,
    'the same path with an ad hoc signature is refused',
  );
  sign(identity);
  assert.equal(
    call().result.pid,
    daemon.pid,
    'restoring the valid signature works without restarting the supervisor',
  );
  const provenance = JSON.parse(await readFile(join(resources, 'provenance.json'), 'utf8'));
  assert.equal(provenance.signing.team, team);
  const bad = join(root, 'bad-provenance');
  await mkdir(bad);
  await copyFile(join(resources, 'node'), join(bad, 'node'));
  await writeFile(
    join(bad, 'provenance.json'),
    JSON.stringify({
      ...provenance,
      binaries: { ...provenance.binaries, node: '0'.repeat(64) },
    }),
  );
  await assert.rejects(verifyMacRuntime(bad, team), /provenance hash mismatch: node/);
  for (const name of ['node', 'constellation-supervisor']) {
    const digest = createHash('sha256')
      .update(await readFile(join(resources, name)))
      .digest('hex');
    assert.equal(provenance.binaries[name], digest, `signed ${name} provenance matches`);
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      checks: [
        'signed peer accepted',
        'token-only interpreter refused',
        'same-path ad hoc peer refused',
        'valid signature restored without restart',
        'incorrect signed-byte provenance refused',
      ],
      platform: 'darwin',
      arch: process.arch,
    }),
  );
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exit = new Promise((r) => daemon.once('exit', r));
    daemon.kill('SIGTERM');
    await bounded(exit, 10000).catch(() => daemon.kill('SIGKILL'));
  }
  await rm(root, { recursive: true, force: true });
}
