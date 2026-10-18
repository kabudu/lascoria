// Release artifacts for the release workflow.
//
//   node scripts/release-artifacts.js stage <target> <version> <out-dir>
//       Copy this runner's Tauri bundles to <out-dir> under names that cannot collide between
//       targets. <target> is darwin-aarch64, darwin-x86_64, windows-x86_64, linux-x86_64 or
//       linux-aarch64.
//   node scripts/release-artifacts.js manifest <dir> <tag> <notes-file>
//       Write latest.json (the signed updater manifest) and SHA256SUMS.txt for every file.
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';

export const TARGETS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'windows-x86_64',
  'linux-x86_64',
  'linux-aarch64',
];
const REPOSITORY = 'https://github.com/kabudu/lascoria';

function walk(dir) {
  let found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.endsWith('.app')) found = found.concat(walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** Which bundle files a target publishes, and the public name each gets. */
export function plan(target, version, files) {
  const name = (suffix) => `Lascoria_${version}_${target}${suffix}`;
  const pick = (test) => files.filter((file) => test(basename(file)));
  const rules = target.startsWith('darwin')
    ? [
        [(f) => f.endsWith('.dmg'), '.dmg'],
        [(f) => f.endsWith('.app.tar.gz'), '.app.tar.gz'],
        [(f) => f.endsWith('.app.tar.gz.sig'), '.app.tar.gz.sig'],
      ]
    : target.startsWith('windows')
      ? [
          [(f) => f.endsWith('-setup.exe'), '-setup.exe'],
          [(f) => f.endsWith('-setup.exe.sig'), '-setup.exe.sig'],
          [(f) => f.endsWith('.msi'), '.msi'],
        ]
      : [
          [(f) => f.endsWith('.AppImage'), '.AppImage'],
          [(f) => f.endsWith('.AppImage.sig'), '.AppImage.sig'],
          [(f) => f.endsWith('.deb'), '.deb'],
        ];
  const result = [];
  for (const [test, suffix] of rules) {
    const matches = pick(test);
    if (matches.length > 1) throw Error(`More than one ${suffix} bundle for ${target}`);
    if (matches.length) result.push([matches[0], name(suffix)]);
  }
  const updater = result.filter(([, n]) => /\.(tar\.gz|exe|AppImage)$/.test(n));
  const signatures = result.filter(([, n]) => n.endsWith('.sig'));
  if (updater.length !== 1 || signatures.length !== 1)
    throw Error(`${target} needs exactly one signed updater bundle (is the signing key set?)`);
  return result;
}

/** The updater manifest: each platform's signed bundle, as the Tauri updater expects it. */
export function manifest(files, tag, notes, date = new Date()) {
  const version = tag.replace(/^v/, '');
  const platforms = {};
  for (const target of TARGETS) {
    const bundle = files.find(
      (file) =>
        file.includes(`_${target}`) && /(\.app\.tar\.gz|-setup\.exe|\.AppImage)$/.test(file),
    );
    if (!bundle) continue;
    const signature = files.find((file) => file === `${bundle}.sig`);
    if (!signature) throw Error(`${bundle} has no signature`);
    platforms[target] = {
      signature: readFileSync(signature, 'utf8').trim(),
      url: `${REPOSITORY}/releases/download/${tag}/${basename(bundle)}`,
    };
  }
  if (!Object.keys(platforms).length) throw Error('No updater bundles found');
  return { version, notes, pub_date: date.toISOString(), platforms };
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    if (command === 'stage') {
      const [target, version, out] = args;
      if (!TARGETS.includes(target)) throw Error(`Unknown target ${target}`);
      const bundles = resolve(import.meta.dirname, '../src-tauri/target/release/bundle');
      mkdirSync(out, { recursive: true });
      for (const [from, to] of plan(target, version, walk(bundles))) {
        copyFileSync(from, join(out, to));
        console.log(`${to} ${statSync(from).size}`);
      }
    } else if (command === 'manifest') {
      const [dir, tag, notesFile] = args;
      const files = readdirSync(dir)
        .filter((f) => !['latest.json', 'SHA256SUMS.txt'].includes(f))
        .map((f) => join(dir, f));
      const notes = readFileSync(notesFile, 'utf8').trim();
      writeFileSync(
        join(dir, 'latest.json'),
        JSON.stringify(manifest(files, tag, notes), null, 2) + '\n',
      );
      const sums = [...files, join(dir, 'latest.json')]
        .sort()
        .map(
          (f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${basename(f)}`,
        );
      writeFileSync(join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
      console.log(sums.join('\n'));
    } else throw Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
