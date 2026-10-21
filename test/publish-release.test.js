import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { GitHubReleaseClient, publishRelease, updateBeta } from '../scripts/publish-release.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const commit = 'a'.repeat(40);
const prefix = '/repos/kabudu/lascoria';

// Controlled GitHub API fixture: every request goes through the real publisher's transport,
// state is read through normal API responses, and failures can occur after a committed write.
function github() {
  let next = 1;
  const releases = [];
  const blobs = new Map();
  const calls = [];
  const repo = { full_name: 'kabudu/lascoria', permissions: { push: true }, private: false };
  const state = { commit };
  const waits = [];
  const failures = [];
  const json = (value, status = 200, headers) =>
    new Response(JSON.stringify(value), { status, headers });
  const snapshot = (value) => JSON.parse(JSON.stringify(value));
  const fetcher = async (input, options) => {
    const url = new URL(input);
    const method = options.method;
    const path = url.pathname;
    calls.push({ method, path, headers: options.headers });
    assert.equal(options.headers.Authorization, 'Bearer synthetic-fixture-token');
    const failure = failures.find((f) => f.match(method, path) && f.left-- > 0);
    if (failure && !failure.after) return json({}, failure.status, failure.headers);
    let result;
    if (method === 'GET' && path === prefix) result = json(repo);
    else if (method === 'GET' && path.startsWith(`${prefix}/git/ref/tags/`))
      result = json({ object: { sha: state.commit, type: 'commit' } });
    else if (method === 'GET' && path === `${prefix}/releases/latest`) {
      const latest = releases.findLast(
        (r) => !r.draft && !r.prerelease && r.make_latest !== 'false',
      );
      result = latest ? json(snapshot(latest)) : json({}, 404);
    } else if (method === 'GET' && path === `${prefix}/releases`) result = json(snapshot(releases));
    else if (method === 'POST' && path === `${prefix}/releases`) {
      const value = JSON.parse(options.body);
      if (releases.some((r) => r.tag_name === value.tag_name)) return json({}, 422);
      const release = { ...value, id: next++, assets: [] };
      releases.push(release);
      result = json(snapshot(release), 201);
    } else if (method === 'GET' && /\/releases\/\d+\/assets$/.test(path)) {
      const release = releases.find((r) => r.id === Number(path.split('/').at(-2)));
      result = json(snapshot(release.assets));
    } else if (method === 'POST' && /\/releases\/\d+\/assets$/.test(path)) {
      const release = releases.find((r) => r.id === Number(path.split('/').at(-2)));
      const name = url.searchParams.get('name');
      if (release.assets.some((a) => a.name === name)) return json({}, 422);
      const chunks = [];
      for await (const chunk of options.body) chunks.push(chunk);
      const data = Buffer.concat(chunks);
      const asset = {
        id: next++,
        name,
        state: 'uploaded',
        size: data.length,
        digest: `sha256:${sha(data)}`,
      };
      release.assets.push(asset);
      blobs.set(asset.id, data);
      result = json(snapshot(asset), 201);
    } else if (/\/releases\/assets\/\d+$/.test(path)) {
      const assetId = Number(path.split('/').at(-1));
      const release = releases.find((r) => r.assets.some((a) => a.id === assetId));
      const asset = release?.assets.find((a) => a.id === assetId);
      if (!asset) return json({}, 404);
      if (method === 'GET') result = new Response(blobs.get(assetId));
      else if (method === 'PATCH') {
        const name = JSON.parse(options.body).name;
        if (release.assets.some((a) => a.name === name && a.id !== assetId)) return json({}, 422);
        asset.name = name;
        result = json(snapshot(asset));
      } else throw Error('Unexpected fixture asset mutation');
    } else if (method === 'PATCH' && /\/releases\/\d+$/.test(path)) {
      const release = releases.find((r) => r.id === Number(path.split('/').at(-1)));
      Object.assign(release, JSON.parse(options.body));
      result = json(snapshot(release));
    } else throw Error(`Unexpected API request ${method} ${path}`);
    if (failure?.after) throw Error('reply lost after mutation committed');
    return result;
  };
  const client = () =>
    new GitHubReleaseClient({
      token: 'synthetic-fixture-token',
      fetcher,
      sleep: async (ms) => waits.push(ms),
    });
  return { releases, blobs, calls, waits, failures, client, repo, state };
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lascoria-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = {
    'bundle.exe': 'synthetic package',
    'latest.json': JSON.stringify({ version: '0.2.0', platforms: {} }),
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  await writeFile(
    join(directory, 'SHA256SUMS.txt'),
    Object.entries(files)
      .map(([n, v]) => `${sha(v)}  ${n}`)
      .join('\n') + '\n',
  );
  return {
    directory,
    tag: 'v0.2.0',
    commit,
    title: 'Lascoria v0.2.0: Test',
    body: 'Synthetic acceptance.',
  };
}

const mutationCount = (g) => g.calls.filter((c) => c.method !== 'GET').length;

test('release publication reconciles committed-but-lost replies and immutable reruns without duplicates', async (t) => {
  const g = github();
  const args = await fixture(t);
  g.failures.push({
    match: (m, p) => m === 'POST' && p === `${prefix}/releases`,
    left: 1,
    after: true,
  });
  g.failures.push({ match: (m, p) => m === 'POST' && p.endsWith('/assets'), left: 1, after: true });
  g.failures.push({
    match: (m, p) => m === 'PATCH' && /\/releases\/\d+$/.test(p),
    left: 1,
    after: true,
  });
  assert.equal((await publishRelease({ ...args, client: g.client() })).result, 'published');
  assert.equal(g.releases.length, 1);
  assert.equal(g.releases[0].draft, false);
  assert.equal(g.releases[0].assets.length, 3);
  const mutations = mutationCount(g);
  assert.equal(mutations, 5, 'lost responses reconcile before retrying any mutation');
  // Simulate an API that has no digest metadata: streamed bytes must still match.
  for (const asset of g.releases[0].assets) delete asset.digest;
  assert.equal((await publishRelease({ ...args, client: g.client() })).result, 'already-published');
  assert.equal(mutationCount(g), mutations);
  assert.ok(g.calls.every((c) => c.method !== 'DELETE'));
});

test('matching drafts resume, conflicting bytes or metadata fail before further mutation', async (t) => {
  const g = github();
  const args = await fixture(t);
  // An interrupted upload that never committed leaves a draft, not a published partial set.
  g.failures.push({ match: (m, p) => m === 'POST' && p.endsWith('/assets'), left: 3, status: 503 });
  await assert.rejects(publishRelease({ ...args, client: g.client() }), /HTTP 503/);
  assert.equal(g.releases[0].draft, true);
  assert.equal((await publishRelease({ ...args, client: g.client() })).result, 'published');
  const count = mutationCount(g);
  await assert.rejects(
    publishRelease({ ...args, client: g.client(), body: 'Different notes' }),
    /metadata conflict/,
  );
  assert.equal(mutationCount(g), count);
  g.releases[0].assets[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    publishRelease({ ...args, client: g.client() }),
    /Conflicting release asset/,
  );
  assert.equal(mutationCount(g), count);
});

test('authentication failures are not absence, retry deadlines are respected, and local mismatches do not call GitHub', async (t) => {
  const args = await fixture(t);
  for (const status of [401, 403, 404]) {
    const g = github();
    g.failures.push({ match: (m, p) => m === 'GET' && p === prefix, left: 1, status });
    await assert.rejects(
      publishRelease({ ...args, client: g.client() }),
      new RegExp(`HTTP ${status}`),
    );
    assert.equal(mutationCount(g), 0);
  }
  const g = github();
  g.failures.push({
    match: (m, p) => m === 'GET' && p === prefix,
    left: 1,
    status: 429,
    headers: { 'retry-after': '3' },
  });
  await publishRelease({ ...args, client: g.client() });
  assert.deepEqual(g.waits, [3000]);
  const limited = github();
  limited.failures.push({
    match: () => true,
    left: 1,
    status: 429,
    headers: { 'retry-after': '3600' },
  });
  await assert.rejects(publishRelease({ ...args, client: limited.client() }), /retry budget/);
  assert.equal(mutationCount(limited), 0);
  assert.equal(limited.waits.length, 0);
  await writeFile(join(args.directory, 'bundle.exe'), 'changed package');
  const untouched = github();
  await assert.rejects(
    publishRelease({ ...args, client: untouched.client() }),
    /checksum inventory/,
  );
  assert.equal(untouched.calls.length, 0);
});

async function manifestFile(t, version) {
  const dir = await mkdtemp(join(tmpdir(), 'lascoria-beta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'latest.json');
  await writeFile(
    path,
    JSON.stringify({
      version,
      platforms: { fixture: { signature: 'fixture', url: `https://example.invalid/${version}` } },
    }),
  );
  return path;
}

test('beta alias stages verified manifests, recovers an interrupted swap and never downgrades', async (t) => {
  const g = github();
  const first = await manifestFile(t, '0.2.0-beta.1');
  const run = (path) =>
    updateBeta({ client: g.client(), commit, manifestPath: path, serialized: true });
  assert.equal((await run(first)).version, '0.2.0-beta.1');
  assert.equal(g.releases[0].draft, false);
  const next = await manifestFile(t, '0.2.0-beta.2');
  // Commit the old-name rename, then make both promotion attempts fail. The next run must
  // recover from the verified stage rather than replace it with the older caller's bytes.
  g.failures.push({
    match: (m, p) => m === 'PATCH' && /\/releases\/assets\//.test(p),
    left: 1,
    after: true,
  });
  assert.equal((await run(next)).version, '0.2.0-beta.2');
  assert.ok(g.releases[0].assets.some((a) => a.name.startsWith('previous-')));
  const mutations = mutationCount(g);
  assert.equal((await run(first)).version, '0.2.0-beta.2');
  assert.equal(mutationCount(g), mutations, 'an older job leaves the newer channel untouched');
  const latest = g.releases[0].assets.find((a) => a.name === 'latest.json');
  latest.name = `staged-${latest.digest.slice(7)}.json`; // crash after backup, before promotion
  assert.equal((await run(first)).version, '0.2.0-beta.2');
  const restored = g.releases[0].assets.find((a) => a.name === 'latest.json');
  assert.equal(JSON.parse(g.blobs.get(restored.id)).version, '0.2.0-beta.2');
  assert.ok(g.calls.every((c) => c.method !== 'DELETE'));
});

test('beta refuses concurrent-operation mode and equal-version conflicting manifests', async (t) => {
  const g = github();
  const path = await manifestFile(t, '0.2.0');
  await assert.rejects(
    updateBeta({ client: g.client(), commit, manifestPath: path }),
    /globally serialized/,
  );
  assert.equal(g.calls.length, 0);
  await updateBeta({ client: g.client(), commit, manifestPath: path, serialized: true });
  const count = mutationCount(g);
  const payload = JSON.parse(await readFile(path));
  payload.notes = 'Different bytes';
  await writeFile(path, JSON.stringify(payload));
  await assert.rejects(
    updateBeta({ client: g.client(), commit, manifestPath: path, serialized: true }),
    /disagree for the same version/,
  );
  assert.equal(mutationCount(g), count);
});

test('private or unknown repository visibility and conflicting release targets cannot mutate releases', async (t) => {
  const args = await fixture(t);
  for (const visibility of [true, undefined]) {
    const g = github();
    g.repo.private = visibility;
    await assert.rejects(
      publishRelease({ ...args, client: g.client() }),
      /visibility is unknown|repository is private/,
    );
    assert.equal(mutationCount(g), 0);
  }
  const moved = github();
  moved.state.commit = 'b'.repeat(40);
  await assert.rejects(publishRelease({ ...args, client: moved.client() }), /tag does not match/);
  assert.equal(mutationCount(moved), 0);
  const g = github();
  await publishRelease({ ...args, client: g.client() });
  g.releases[0].target_commitish = 'b'.repeat(40);
  const count = mutationCount(g);
  await assert.rejects(
    publishRelease({ ...args, client: g.client() }),
    /metadata conflict: target_commitish/,
  );
  assert.equal(mutationCount(g), count);
});

test('binary reconciliation strips tokens on GitHub CDN redirects and refuses unexpected destinations', async () => {
  const seen = [];
  const client = new GitHubReleaseClient({
    token: 'synthetic',
    fetcher: async (url, options) => {
      seen.push({ url: String(url), headers: options.headers });
      if (seen.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: 'https://release-assets.githubusercontent.com/fixture' },
        });
      return new Response('public fixture');
    },
  });
  await client.verifyAsset(
    { id: 1, state: 'uploaded', size: 14 },
    { name: 'fixture', size: 14, sha256: sha('public fixture') },
  );
  assert.equal(seen[0].headers.Authorization, 'Bearer synthetic');
  assert.equal(seen[1].headers.Authorization, undefined);
  const refused = new GitHubReleaseClient({
    token: 'synthetic',
    fetcher: async () =>
      new Response(null, { status: 302, headers: { location: 'https://example.invalid/steal' } }),
  });
  await assert.rejects(
    refused.verifyAsset(
      { id: 1, state: 'uploaded', size: 1 },
      { name: 'fixture', size: 1, sha256: sha('x') },
    ),
    /unexpected release service address/,
  );
});

test('publishing an older stable build never moves the stable latest channel backwards', async (t) => {
  const args = await fixture(t);
  const g = github();
  g.releases.push({
    tag_name: 'v0.3.0',
    name: 'Newer',
    body: 'Newer',
    prerelease: false,
    draft: false,
    id: 100,
    assets: [],
  });
  await publishRelease({ ...args, client: g.client() });
  const older = g.releases.find((r) => r.tag_name === 'v0.2.0');
  assert.equal(older.draft, false);
  assert.equal(older.make_latest, 'false');
  assert.equal(
    g.releases.findLast((r) => !r.draft && !r.prerelease && r.make_latest !== 'false').tag_name,
    'v0.3.0',
  );
});
