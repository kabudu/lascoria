// Launch a validation build against private, disposable state (docs/native-acceptance.md).
// macOS: the app from scripts/package-macos-qa.js. Windows: run from the package made by
// scripts/package-windows-qa.js, with its own runtime\node.exe.
//
//   node qa-launch.mjs echo  <Muse 1.4.10 binary>   feature checks, no sign-in needed
//   node qa-launch.mjs live  <Muse 1.4.10 binary>   like echo, but with Muse's real models: sign
//                                                   in inside the app; QA scripts can drive it
//   node qa-launch.mjs bound [older Muse binary]    the app starts its own supervisor; with a
//                                                   path, setup starts from that older choice
//   node qa-launch.mjs reopen                       reopen only the app, same mode and state
//   node qa-launch.mjs stop                         stop what this script started
//
// `echo` starts the supervisor here with Muse's local echo provider: no model provider or
// credential is used. `bound` lets the app start the supervisor, the only way control becomes
// bound to the app (finding F1); starting work there needs a Muse sign-in. Neither mode
// touches your normal Lascoria state or a supervisor that is already running.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const [mode, muse] = process.argv.slice(2);
const windows = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const layout = windows
  ? (() => {
      const base = resolve(here, '..');
      return { base, ui: join(base, 'Lascoria.exe'), resources: join(base, 'runtime') };
    })()
  : (() => {
      const base = resolve('.dev/macos-qa');
      const app = join(base, 'Lascoria QA.app');
      return {
        base,
        ui: join(app, 'Contents/MacOS/LascoriaQA'),
        resources: join(app, 'Contents/Resources/runtime'),
      };
    })();
// The installed runtime carries no IPC client; the Windows package copies the worker sources.
const client = windows
  ? join(layout.resources, 'workers/client.js')
  : join(here, '../src/client.js');
const { request } = await import(pathToFileURL(client).href);
const exe = (name) => join(layout.resources, windows ? `${name}.exe` : name);
const record = join(layout.base, 'running.json');
if (mode === 'stop') {
  const running = JSON.parse(await readFile(record, 'utf8').catch(() => '{}'));
  for (const pid of [running.uiPid, running.daemonPid].filter(Boolean))
    try {
      process.kill(pid);
    } catch {}
  await rm(record, { force: true });
  console.log('Stopped', JSON.stringify(running));
  process.exit(0);
}
const running = JSON.parse(await readFile(record, 'utf8').catch(() => '{}'));
if (mode === 'reopen' && !running.mode) throw Error('Nothing to reopen; start echo or bound first');
const launch = mode === 'reopen' ? running.mode : mode;
if (!['echo', 'live', 'bound'].includes(launch))
  throw Error('Usage: qa-launch.mjs echo <muse> | live <muse> | bound [muse] | reopen | stop');
if (!existsSync(layout.ui)) throw Error(`Validation app not found at ${layout.ui}`);
const root = join(layout.base, `state-${launch}`);
const directory = join(root, 'state');
const env = {
  ...process.env,
  SCH_STATE_DIR: directory,
  MUSE_NO_AUTO_UPDATE: '1',
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
};
delete env.META_API_KEY;
await mkdir(directory, { recursive: true });
const select = (path, version) =>
  writeFile(
    join(directory, 'runtime.json'),
    JSON.stringify({ managed: false, musePath: resolve(path), version }),
  );
let daemonPid = running.daemonPid;
if (mode === 'bound' && muse) await select(muse, '1.4.9');
if (launch === 'echo' || launch === 'live')
  Object.assign(env, {
    SCH_RESOURCES: windows ? '\\\\?\\' + layout.resources : layout.resources,
    SCH_NODE: exe('node'),
  });
if (launch === 'echo') Object.assign(env, { SCH_PROVIDER: 'echo', SCH_AUTH_MANAGED: '0' });
if (mode === 'echo' || mode === 'live') {
  if (!muse) throw Error('Pass the Muse 1.4.10 binary');
  await select(muse, '1.4.10');
  const log = await open(join(root, 'supervisor.log'), 'a');
  const daemon = spawn(exe('constellation-supervisor'), [], {
    env,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  daemon.unref();
  await log.close();
  daemonPid = daemon.pid;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      ready = (await request(directory, 'status')).pid === daemonPid;
    } catch {}
    if (!ready) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw Error(`Supervisor did not start; see ${join(root, 'supervisor.log')}`);
}
const ui = spawn(layout.ui, [], { env, detached: true, stdio: 'ignore' });
ui.unref();
await writeFile(record, JSON.stringify({ mode: launch, directory, daemonPid, uiPid: ui.pid }));
console.log(JSON.stringify({ mode: launch, directory, daemonPid, uiPid: ui.pid }));
