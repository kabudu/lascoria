// Release artifacts for the release workflow.
//
//   node scripts/release-artifacts.js stage <target> <version> <out-dir>
//       Copy this runner's Tauri bundles to <out-dir> under names that cannot collide between
//       targets. <target> is darwin-universal, windows-x86_64, linux-x86_64 or
//       linux-aarch64.
//   node scripts/release-artifacts.js manifest <dir> <tag> <notes-file>
//       Write latest.json (the updater manifest with artifact signatures) and SHA256SUMS.txt for every file.
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from './release.js';

export const TARGETS = ['darwin-universal', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64'];
const MAX_UPDATER_BYTES = 256 * 1024 * 1024;
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
  if (!TARGETS.includes(target)) throw Error(`Unknown target ${target}`);
  parse(version);
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
  for (const suffix of requiredSuffixes(target)) {
    if (!result.some(([, name]) => name.endsWith(suffix)))
      throw Error(`${target} is missing its required ${suffix} installer`);
  }
  return result;
}

function requiredSuffixes(target) {
  return target.startsWith('darwin')
    ? ['.dmg', '.app.tar.gz', '.app.tar.gz.sig']
    : target.startsWith('windows')
      ? ['-setup.exe', '-setup.exe.sig']
      : ['.AppImage', '.AppImage.sig', '.deb'];
}

/** The updater manifest: each platform's signed bundle, as the Tauri updater expects it. */
export function manifest(files, tag, notes, date = new Date()) {
  if (typeof tag !== 'string' || !tag.startsWith('v')) throw Error('Expected a version tag');
  const version = tag.slice(1);
  parse(version);
  const byName = new Map();
  const expected = new Set(
    TARGETS.flatMap((target) =>
      [...requiredSuffixes(target), ...(target === 'windows-x86_64' ? ['.msi'] : [])].map(
        (suffix) => `Lascoria_${version}_${target}${suffix}`,
      ),
    ),
  );
  for (const file of files) {
    const name = basename(file);
    if (!expected.has(name)) throw Error(`Unexpected release artifact: ${name}`);
    if (byName.has(name)) throw Error(`Duplicate release artifact: ${name}`);
    const meta = lstatSync(file);
    if (!meta.isFile() || meta.size === 0)
      throw Error(`Release artifact is not a nonempty regular file: ${name}`);
    if (/\.(tar\.gz|exe|AppImage)$/.test(name) && meta.size > MAX_UPDATER_BYTES)
      throw Error(`${name} exceeds the client's 256 MB updater limit`);
    byName.set(name, file);
  }
  const platforms = {};
  for (const target of TARGETS) {
    const names = requiredSuffixes(target).map(
      (suffix) => `Lascoria_${version}_${target}${suffix}`,
    );
    for (const name of names) {
      if (!byName.has(name)) throw Error(`${target} is missing required artifact ${name}`);
    }
    const bundle = names.find((name) => /\.(tar\.gz|exe|AppImage)$/.test(name));
    const signatureFile = byName.get(`${bundle}.sig`);
    if (lstatSync(signatureFile).size > 16384) throw Error(`${bundle} signature is too large`);
    const signature = readFileSync(signatureFile, 'utf8').trim();
    if (!signature) throw Error(`${bundle} has an empty signature`);
    const entry = {
      signature,
      url: `${REPOSITORY}/releases/download/${tag}/${bundle}`,
    };
    for (const platform of target === 'darwin-universal'
      ? ['darwin-aarch64', 'darwin-x86_64']
      : [target])
      platforms[platform] = entry;
  }
  return { version, notes, pub_date: date.toISOString(), platforms };
}

const [command, ...args] = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    if (command === 'stage') {
      const [target, version, out] = args;
      if (!TARGETS.includes(target)) throw Error(`Unknown target ${target}`);
      const bundles = resolve(
        process.env.LASCORIA_BUNDLE_DIR ||
          resolve(import.meta.dirname, '../src-tauri/target/release/bundle'),
      );
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
        JSON.stringify(
          manifest(
            files,
            tag,
            notes,
            process.env.SOURCE_DATE_EPOCH === undefined
              ? new Date()
              : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000),
          ),
          null,
          2,
        ) + '\n',
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
