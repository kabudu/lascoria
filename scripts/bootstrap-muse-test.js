// Explicit development/CI bootstrap only. Never installs globally or restarts a host.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, lstat, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EXPECTED_SCHEMA_FINGERPRINT } from '@muse-code/sdk';
import { MUSE_VERSION } from '../src/muse-version.js';
export function vendorUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    (!['lookaside.facebook.com', 'api.meta.ai'].includes(url.hostname) &&
      !url.hostname.endsWith('.fbcdn.net'))
  )
    throw Error('Unsupported vendor destination');
  return url;
}
export function artifactFor(manifest, build, platform) {
  if (
    manifest.version !== build ||
    manifest.checksum_algorithm !== 'sha256' ||
    manifest.msp_schema_fingerprint !== EXPECTED_SCHEMA_FINGERPRINT
  )
    throw Error('Muse vendor manifest does not match the pinned SDK');
  const a = manifest.artifacts?.[platform];
  if (
    !a ||
    !Number.isSafeInteger(a.size) ||
    a.size < 1 ||
    a.size > 768 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(a.checksum)
  )
    throw Error('Invalid vendor artifact');
  vendorUrl(a.url);
  return a;
}
async function response(url, signal) {
  for (let redirects = 0; redirects < 4; redirects++) {
    const r = await fetch(vendorUrl(url), { redirect: 'manual', signal });
    if (r.status >= 300 && r.status < 400) {
      await r.body?.cancel();
      url = new URL(r.headers.get('location') ?? '', url);
      continue;
    }
    if (!r.ok) {
      await r.body?.cancel();
      throw Error(`Vendor returned HTTP ${r.status}`);
    }
    return r;
  }
  throw Error('Vendor redirect limit reached');
}
async function digest(path) {
  const hash = createHash('sha256');
  for await (const b of createReadStream(path)) hash.update(b);
  return hash.digest('hex');
}
async function bootstrap() {
  const rust = await readFile(new URL('../runtime-support/src/lib.rs', import.meta.url), 'utf8');
  const build = rust.match(/MUSE_BUILD: &str = "([^"]+)"/)?.[1];
  if (!build?.startsWith(MUSE_VERSION + '-R')) throw Error('Muse pins disagree');
  const r = await response(
    `https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${encodeURIComponent(build)}&file=manifest.json`,
    AbortSignal.timeout(30000),
  );
  let bytes = Buffer.alloc(0);
  for await (const b of r.body) {
    if (bytes.length + b.length > 65536) throw Error('Vendor manifest exceeds limit');
    bytes = Buffer.concat([bytes, b]);
  }
  const target = {
    'darwin:arm64': 'aarch64_macos',
    'darwin:x64': 'x86_macos',
    'linux:arm64': 'aarch64_linux',
    'linux:x64': 'x86_linux',
    'win32:x64': 'x86_windows',
    'win32:arm64': 'aarch64_windows',
  }[`${process.platform}:${process.arch}`];
  const a = artifactFor(JSON.parse(bytes), build, target);
  const directory = resolve('.dev/muse-test');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, process.platform === 'win32' ? 'muse.exe' : 'muse');
  const existing = await lstat(path).catch(() => null);
  if (existing && !existing.isFile()) throw Error('Cached Muse must be a regular file');
  if (!existing || existing.size !== a.size || (await digest(path)) !== a.checksum) {
    const temporary = path + '.partial';
    await rm(temporary, { force: true });
    const file = await open(temporary, 'wx', 0o700);
    try {
      const download = await response(a.url, AbortSignal.timeout(300000));
      let size = 0;
      const hash = createHash('sha256');
      for await (const b of download.body) {
        size += b.length;
        if (size > a.size) throw Error('Vendor artifact exceeds declared size');
        hash.update(b);
        await file.writeFile(b);
      }
      if (size !== a.size || hash.digest('hex') !== a.checksum)
        throw Error('Vendor artifact checksum mismatch');
      await file.close();
      await rename(temporary, path);
    } catch (e) {
      await file.close().catch(() => {});
      await rm(temporary, { force: true });
      throw e;
    }
  }
  if (process.platform !== 'win32') await chmod(path, 0o700);
  const version = execFileSync(path, ['--version'], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8192,
    env: { ...process.env, MUSE_NO_AUTO_UPDATE: '1' },
  });
  if (!version.includes(build)) throw Error('Downloaded Muse reports a different build');
  console.log(
    JSON.stringify({
      version: MUSE_VERSION,
      build,
      path,
      fingerprint: EXPECTED_SCHEMA_FINGERPRINT,
    }),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await bootstrap();
