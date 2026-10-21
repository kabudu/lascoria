// Release bookkeeping for Lascoria, run by the maintainer and by the release workflow.
//
//   node scripts/release.js prepare <version>   Move "Unreleased" in CHANGELOG.md under a dated
//                                               version heading, bump every version field and
//                                               create docs/releases/v<version>.md to curate.
//   node scripts/release.js verify <tag>        Check a release tag against the tree (used by CI).
//   node scripts/release.js notes <version>     Print the GitHub release body.
//   node scripts/release.js title <version>     Print the GitHub release title.
//
// Nothing here creates tags, pushes or publishes: the maintainer commits the prepared change,
// tags it and pushes the tag; the workflow builds and publishes only after `verify` passes.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const file = (path) => join(root, path);
const read = (path) => readFileSync(file(path), 'utf8');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

export function parse(version) {
  const match = SEMVER.exec(version);
  const parts = match?.slice(1, 4).map(Number);
  const prerelease = match?.[4] ?? null;
  if (
    !match ||
    !parts.every(Number.isSafeInteger) ||
    (prerelease && prerelease.split('.').some((id) => !id || /^0\d+$/.test(id)))
  )
    throw Error(`Not a release version: ${version} (use X.Y.Z or X.Y.Z-beta.N)`);
  return { parts, prerelease };
}
/** Positive when a is newer than b. Pre-releases sort before their release. */
export function compare(a, b) {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] - y.parts[i];
  if (x.prerelease === y.prerelease) return 0;
  if (!x.prerelease) return 1;
  if (!y.prerelease) return -1;
  const [left, right] = [x.prerelease.split('.'), y.prerelease.split('.')];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const [a, b] = [left[i], right[i]];
    if (a === b) continue;
    const [numericA, numericB] = [/^\d+$/.test(a), /^\d+$/.test(b)];
    if (numericA !== numericB) return numericA ? -1 : 1;
    // Numeric identifiers can exceed JS's exact integer range; length then ASCII order
    // compares them exactly because leading zeroes were refused by parse().
    if (numericA && a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

/** Every place that carries the application version. All must agree. */
const VERSIONED = [
  ['package.json', /("version":\s*")([^"]+)(")/],
  ['src-tauri/tauri.conf.json', /("version":\s*")([^"]+)(")/],
  ['src-tauri/Cargo.toml', /(\[package\][^[]*?\nversion = ")([^"]+)(")/],
  ['supervisor/Cargo.toml', /(\[package\][^[]*?\nversion = ")([^"]+)(")/],
  ['runtime-support/Cargo.toml', /(\[package\][^[]*?\nversion = ")([^"]+)(")/],
];
const LOCKED = [
  ['src-tauri/Cargo.lock', ['spatial-constellation-desktop', 'lascoria-runtime']],
  ['supervisor/Cargo.lock', ['constellation-supervisor', 'lascoria-runtime']],
  ['runtime-support/Cargo.lock', ['lascoria-runtime']],
];
export function versions(readFile = read) {
  const found = VERSIONED.map(([path, pattern]) => [path, pattern.exec(readFile(path))?.[2]]);
  for (const [path, names] of LOCKED) {
    const text = readFile(path);
    for (const name of names) {
      const match = new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(text);
      found.push([`${path} (${name})`, match?.[1]]);
    }
  }
  const lock = JSON.parse(readFile('package-lock.json'));
  found.push(
    ['package-lock.json', lock.version],
    ['package-lock.json (root)', lock.packages?.['']?.version],
  );
  return found;
}

/** The CHANGELOG section for `version`, without its heading. */
export function changelogSection(text, version) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${version} - `));
  if (start < 0) return null;
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
}

/** Moves the Unreleased entries under a dated heading and leaves an empty Unreleased. */
export function promoteChangelog(text, version, date) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Unreleased');
  if (start < 0) throw Error('CHANGELOG.md has no "## Unreleased" section');
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  const body = lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join('\n')
    .trim();
  if (!body) throw Error('Nothing under "## Unreleased" to release');
  if (lines.some((line) => line.startsWith(`## ${version} - `)))
    throw Error(`CHANGELOG.md already has ${version}`);
  const rest = end < 0 ? [] : lines.slice(end);
  return [
    ...lines.slice(0, start),
    '## Unreleased',
    '',
    `## ${version} - ${date}`,
    '',
    body,
    '',
    ...rest,
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

/** Curated release notes: a "# Lascoria vX.Y.Z: theme" title, then the body (PL13). */
export function curated(text, version) {
  const [first, ...rest] = text.split('\n');
  const title = /^# (Lascoria v(\S+): .+)$/.exec(first);
  if (!title || title[2] !== version)
    throw Error(`docs/releases/v${version}.md must start with "# Lascoria v${version}: <theme>"`);
  const body = rest.join('\n').trim();
  if (!body || body.includes('TODO'))
    throw Error(`Write the release notes in docs/releases/v${version}.md`);
  if (text.includes(String.fromCharCode(0x2014))) throw Error('Release notes must not use U+2014');
  return { title: title[1], body };
}

function prepare(version) {
  parse(version);
  const current = JSON.parse(read('package.json')).version;
  const wrong = versions().filter(([, value]) => value !== current);
  if (wrong.length)
    throw Error(
      `Version fields must agree before preparing: ${wrong.map(([p, v]) => `${p}=${v}`).join(', ')}`,
    );
  if (compare(version, current) <= 0) throw Error(`${version} is not newer than ${current}`);
  const date = new Date().toISOString().slice(0, 10);
  // Read and validate the complete source set before making any edits. I/O failures during
  // the writes still require inspecting git diff; this is preflight, not a filesystem transaction.
  const edits = new Map([['CHANGELOG.md', promoteChangelog(read('CHANGELOG.md'), version, date)]]);
  for (const [path, pattern] of VERSIONED)
    edits.set(path, read(path).replace(pattern, `$1${version}$3`));
  for (const [path, names] of LOCKED) {
    let text = read(path);
    for (const name of names)
      text = text.replace(new RegExp(`(name = "${name}"\\nversion = ")[^"]+(")`), `$1${version}$2`);
    edits.set(path, text);
  }
  const lock = JSON.parse(read('package-lock.json'));
  lock.version = version;
  lock.packages[''].version = version;
  edits.set('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
  const notesPath = `docs/releases/v${version}.md`;
  const notes = file(notesPath);
  if (!existsSync(notes))
    edits.set(
      notesPath,
      `# Lascoria v${version}: TODO short theme\n\nTODO: a short opening, the material changes, compatibility and support limits, and one install path. See docs/RELEASE.md.\n`,
    );
  else read(notesPath);
  for (const [path, text] of edits) {
    mkdirSync(dirname(file(path)), { recursive: true });
    writeFileSync(file(path), text);
  }
  console.log(
    `Prepared ${version}. Curate docs/releases/v${version}.md, review the diff, commit, then tag v${version} on the default branch and push the tag.`,
  );
}

function verify(tag) {
  if (!tag.startsWith('v')) throw Error(`Release tags look like v1.2.3, not ${tag}`);
  const version = tag.slice(1);
  parse(version);
  const wrong = versions().filter(([, value]) => value !== version);
  if (wrong.length)
    throw Error(
      `Version fields do not match ${tag}: ${wrong.map(([p, v]) => `${p}=${v}`).join(', ')}`,
    );
  if (!changelogSection(read('CHANGELOG.md'), version))
    throw Error(`CHANGELOG.md has no non-empty "## ${version} - <date>" section`);
  const path = `docs/releases/v${version}.md`;
  if (!existsSync(file(path))) throw Error(`Missing curated release notes: ${path}`);
  curated(read(path), version);
  console.log(JSON.stringify({ version, prerelease: parse(version).prerelease !== null }));
}

const [command, argument] = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    if (command === 'prepare') prepare(argument);
    else if (command === 'verify') verify(argument);
    else if (command === 'notes' || command === 'title') {
      const notes = curated(read(`docs/releases/v${argument}.md`), argument);
      const changes = `\n\nFull list of changes: [CHANGELOG.md](https://github.com/kabudu/lascoria/blob/v${argument}/CHANGELOG.md).`;
      process.stdout.write(command === 'title' ? notes.title : notes.body + changes + '\n');
    } else if (command) throw Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
