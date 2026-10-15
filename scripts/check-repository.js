// Tracked content only: never walk .dev credentials, native captures or dependency trees.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  constants,
} from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export function textProblems(name, text, root) {
  const problems = [];
  if (text.includes('\u2014')) problems.push(`${name}: replace U+2014 with plain punctuation`);
  if (!name.endsWith('.md')) return problems;
  for (const match of text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
    const raw = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(raw)) continue;
    let target;
    try {
      target = decodeURIComponent(raw.split('#')[0]);
    } catch {
      problems.push(`${name}: invalid link encoding`);
      continue;
    }
    if (!target) continue;
    const file = resolve(dirname(resolve(root, name)), target);
    const local = relative(root, file);
    if (isAbsolute(target) || local === '..' || local.startsWith('../'))
      problems.push(`${name}: local links must stay in the repository`);
    else if (!existsSync(file)) problems.push(`${name}: missing local link ${target}`);
  }
  return problems;
}

export function checkRepository(root = process.cwd()) {
  root = realpathSync(root);
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const texts = [];
  const problems = [];
  let bytes = 0;
  for (const name of names) {
    if (name.startsWith('.dev/') || name.includes('/.dev/'))
      throw Error('Private local evidence must not be tracked');
    const path = resolve(root, name);
    const canonicalRoot = realpathSync(root);
    if (lstatSync(path).isSymbolicLink())
      throw Error(`${name}: tracked symlinks require separate privacy review`);
    for (
      let parent = dirname(path);
      parent !== canonicalRoot && parent !== dirname(parent);
      parent = dirname(parent)
    ) {
      if (lstatSync(parent).isSymbolicLink())
        throw Error(`${name}: tracked symlink ancestors require separate privacy review`);
    }
    const canonical = realpathSync(path);
    const local = relative(canonicalRoot, canonical);
    if (local === '..' || local.startsWith('../') || isAbsolute(local) || local.startsWith('.dev/'))
      throw Error('Tracked file resolves outside the reviewed source');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data;
    try {
      const size = fstatSync(fd);
      if (!size.isFile() || size.size > 16 * 1024 * 1024 || bytes + size.size > 64 * 1024 * 1024)
        throw Error('Tracked-content scan exceeds its review budget');
      const buffer = Buffer.alloc(size.size + 1);
      let read = 0,
        count;
      while (
        read < buffer.length &&
        (count = readSync(fd, buffer, read, buffer.length - read, null)) > 0
      )
        read += count;
      if (read > size.size)
        throw Error('Tracked file grew during inspection; retry after editing stops');
      data = buffer.subarray(0, read);
      bytes += read;
    } finally {
      closeSync(fd);
    }
    if (data.includes(0)) continue;
    const text = data.toString('utf8');
    problems.push(...textProblems(name, text, root));
    texts.push(`\nFILE ${name}\n${text}\n`);
  }
  if (problems.length) throw Error(problems.join('\n'));
  const scan = spawnSync(
    'gitleaks',
    [
      'stdin',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--ignore-gitleaks-allow',
      '--timeout',
      '60',
    ],
    { cwd: root, input: texts.join(''), encoding: 'utf8', timeout: 65000, maxBuffer: 1024 * 1024 },
  );
  if (scan.error || scan.status !== 0)
    throw Error(
      'Tracked-content secret scan failed. Run gitleaks locally with full redaction to inspect findings; no source content is printed by this check.',
    );
  // The index can differ from the working tree. Inspect it before allowing a commit.
  const staged = spawnSync(
    'gitleaks',
    [
      'git',
      '--pre-commit',
      '--staged',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--ignore-gitleaks-allow',
      '--timeout',
      '60',
    ],
    { cwd: root, encoding: 'utf8', timeout: 65000, maxBuffer: 1024 * 1024 },
  );
  if (staged.error || staged.status !== 0)
    throw Error(
      'Staged-content secret scan failed; inspect the redacted staged scan before committing.',
    );
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json')));
  const app = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json')));
  if (pkg.name !== 'lascoria' || app.productName !== 'Lascoria' || pkg.version !== app.version)
    throw Error('Package/application identity or version mismatch');
  console.log(
    `Repository checks passed: ${names.length} tracked files; text/links, secret scan and application metadata.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkRepository();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
