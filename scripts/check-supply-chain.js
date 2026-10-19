#!/usr/bin/env node
// R12 supply-chain gate, run before a release and whenever dependencies change (it needs the
// npm registry and the RustSec advisory database, so it is not part of offline local CI):
//   node scripts/check-supply-chain.js            (needs cargo-audit: cargo install cargo-audit)
// Fails on any known vulnerability in the npm or Rust dependency graphs, on an advisory warning
// that has not been reviewed below, and on any third-party licence outside the allowed set.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const manifests = ['supervisor', 'src-tauri', 'runtime-support'];
// Reviewed advisory warnings (not vulnerabilities). Each needs a reason and is re-reviewed when
// the dependency that pulls it in changes.
const reviewed = {
  'RUSTSEC-2024-0370':
    'proc-macro-error is unmaintained; build-time only, pulled in by the Linux GTK bindings through Tauri.',
  'RUSTSEC-2024-0429':
    'glib Iterator unsoundness; Linux GTK binding used by Tauri. Lascoria code does not iterate glib variant arrays.',
  'RUSTSEC-2026-0370':
    'zvariant is unmaintained; Linux D-Bus support through Tauri and the keyring.',
  'RUSTSEC-2026-0371':
    'zbus_names is unmaintained; Linux D-Bus support through Tauri and the keyring.',
  'RUSTSEC-2026-0372':
    'zvariant_derive is unmaintained; Linux D-Bus support through Tauri and the keyring.',
};
const allowed = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'Apache-2.0 WITH LLVM-exception',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Zlib',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'CC0-1.0',
  'BSL-1.0',
  'CDLA-Permissive-2.0',
  // File-level copyleft: unmodified MPL-2.0 sources remain available from crates.io.
  'MPL-2.0',
]);

/** True when an SPDX expression (or the older "A/B" form) can be satisfied by allowed terms. */
export function licenceAllowed(expression) {
  if (!expression) return false;
  const text = expression.replaceAll('/', ' OR ').trim();
  const strip = (s) => {
    s = s.trim();
    while (s.startsWith('(') && s.endsWith(')') && balanced(s.slice(1, -1)))
      s = s.slice(1, -1).trim();
    return s;
  };
  const balanced = (s) => {
    let depth = 0;
    for (const c of s) {
      depth += c === '(' ? 1 : c === ')' ? -1 : 0;
      if (depth < 0) return false;
    }
    return depth === 0;
  };
  const split = (s, op) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    const token = ` ${op} `;
    for (let i = 0; i < s.length; i++) {
      depth += s[i] === '(' ? 1 : s[i] === ')' ? -1 : 0;
      if (depth === 0 && s.startsWith(token, i)) {
        parts.push(s.slice(start, i));
        start = i + token.length;
      }
    }
    parts.push(s.slice(start));
    return parts.map(strip);
  };
  const check = (s) => {
    s = strip(s);
    const any = split(s, 'OR');
    if (any.length > 1) return any.some(check);
    const all = split(s, 'AND');
    if (all.length > 1) return all.every(check);
    return allowed.has(s);
  };
  return check(text);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();

function main() {
  const problems = [];
  const run = (cmd, args, cwd = root) => {
    try {
      return execFileSync(cmd, args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // npm audit and cargo audit exit non-zero when they find something; keep their report.
      if (error.stdout) return error.stdout;
      throw error;
    }
  };

  // npm: vulnerabilities in the whole graph, licences of what ships (production dependencies).
  const npm = JSON.parse(run('npm', ['audit', '--json']));
  const counts = npm.metadata?.vulnerabilities ?? {};
  if (counts.total) problems.push(`npm audit: ${JSON.stringify(counts)}`);
  const tree = JSON.parse(run('npm', ['ls', '--omit=dev', '--all', '--long', '--json']));
  const seen = new Set();
  const walk = (deps = {}) => {
    for (const [name, info] of Object.entries(deps)) {
      // Optional peers that are not installed do not ship.
      if (!info.path || info.missing || seen.has(`${name}@${info.version}`)) continue;
      seen.add(`${name}@${info.version}`);
      const pkg = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
      if (!licenceAllowed(pkg.license))
        problems.push(`npm licence: ${name}@${info.version} ${pkg.license}`);
      walk(info.dependencies);
    }
  };
  walk(tree.dependencies);

  // Rust: RustSec advisories and licences of every third-party crate in each lockfile.
  let crates = 0;
  for (const manifest of manifests) {
    const report = JSON.parse(
      run('cargo', ['audit', '--json', '--file', `${manifest}/Cargo.lock`]),
    );
    for (const v of report.vulnerabilities.list)
      problems.push(
        `${manifest}: ${v.advisory.id} ${v.package.name} ${v.package.version} ${v.advisory.title}`,
      );
    for (const list of Object.values(report.warnings ?? {}))
      for (const w of list) {
        const id = w.advisory?.id ?? `${w.kind} ${w.package.name}`;
        if (!reviewed[id])
          problems.push(
            `${manifest}: unreviewed ${w.kind} ${id} ${w.package.name} ${w.package.version}`,
          );
      }
    const metadata = JSON.parse(
      run('cargo', ['metadata', '--format-version', '1', '--locked'], join(root, manifest)),
    );
    for (const p of metadata.packages) {
      if (!p.source) continue; // this repository's own crates
      crates++;
      if (!licenceAllowed(p.license))
        problems.push(`${manifest}: licence ${p.name} ${p.version} ${p.license}`);
    }
  }

  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      npmVulnerabilities: 0,
      npmRuntimePackages: seen.size,
      rustCratesChecked: crates,
      reviewedWarnings: Object.keys(reviewed),
    }),
  );
}
