// Explicit release-only publisher. Never run from local CI or private development. The
// transport is injectable for controlled acceptance; the CLI uses only GitHub's fixed API.
// Reference: https://docs.github.com/en/rest/releases/releases and /releases/assets.
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { compare, parse } from './release.js';

const REPO = '/repos/kabudu/lascoria';
const MAX_ASSETS = 64;
const MAX_ASSET_BYTES = 2 * 1024 ** 3;
const MAX_JSON = 2 * 1024 ** 2;
const BETA_BODY = 'Updater manifest for beta releases. Install releases from their own pages.';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const id = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw Error('Invalid GitHub resource identity');
  return value;
};

class ApiFailure extends Error {
  constructor(status, retryAfter, transient = false) {
    super(
      status ? `GitHub request failed (HTTP ${status})` : 'GitHub request outcome is uncertain',
    );
    Object.assign(this, { status, retryAfter, transient });
  }
}

async function bytes(response, limit, hashOnly = false) {
  const length = Number(response.headers.get('content-length'));
  if (length > limit) {
    await response.body?.cancel();
    throw Error('GitHub response exceeds its size budget');
  }
  const chunks = [];
  const digest = hashOnly ? createHash('sha256') : null;
  let count = 0;
  if (response.body)
    for await (const chunk of response.body) {
      count += chunk.length;
      if (count > limit) throw Error('GitHub response exceeds its size budget');
      if (digest) digest.update(chunk);
      else chunks.push(chunk);
    }
  return digest ? { size: count, sha256: digest.digest('hex') } : Buffer.concat(chunks, count);
}

export class GitHubReleaseClient {
  constructor({
    token,
    fetcher = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = {}) {
    if (!token) throw Error('GH_TOKEN is required for explicit release publication');
    Object.assign(this, { token, fetcher, sleep, now, waited: 0, requests: 0 });
    this.deadline = now() + 20 * 60_000;
  }
  async pause(error, attempt) {
    const raw = error.retryAfter;
    let delay = Math.min(1000 * 2 ** attempt, 4000);
    if (raw !== null && raw !== undefined) {
      if (/^\d+$/.test(raw)) delay = Number(raw) * 1000;
      else {
        const at = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)
          ? Date.parse(raw)
          : NaN;
        if (!Number.isFinite(at)) throw Error('Invalid GitHub Retry-After; no automatic retry');
        delay = Math.max(0, at - this.now());
      }
    }
    if (
      !Number.isFinite(delay) ||
      delay > 60_000 - this.waited ||
      this.now() + delay >= this.deadline
    )
      throw Error('GitHub Retry-After exceeds the release retry budget; retry later');
    this.waited += delay;
    await this.sleep(delay);
  }
  async raw(method, url, { json, file, binary = false, limit = MAX_JSON, hashOnly = false } = {}) {
    if (++this.requests > 512 || this.now() >= this.deadline)
      throw Error('Release request/time budget exhausted');
    const address = new URL(url);
    const authenticated = ['https://api.github.com', 'https://uploads.github.com'].includes(
      address.origin,
    );
    if (
      !authenticated &&
      (!binary ||
        address.protocol !== 'https:' ||
        !address.hostname.endsWith('.githubusercontent.com'))
    )
      throw Error('Refused an unexpected release service address');
    const headers = {
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (authenticated) headers.Authorization = `Bearer ${this.token}`;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (file) {
      headers['Content-Type'] = 'application/octet-stream';
      headers['Content-Length'] = String(file.size);
    }
    const stream = file ? createReadStream(file.path, { highWaterMark: 64 * 1024 }) : null;
    let response;
    try {
      response = await this.fetcher(address, {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.min(file ? 120_000 : 30_000, this.deadline - this.now())),
        ...(file
          ? { body: stream, duplex: 'half' }
          : json !== undefined
            ? { body: JSON.stringify(json) }
            : {}),
      });
    } catch {
      throw new ApiFailure(null, null, true);
    } finally {
      stream?.destroy();
    }
    if (binary && response.status === 302) {
      if (!authenticated) {
        await response.body?.cancel();
        throw Error('Unexpected second asset redirect');
      }
      const location = response.headers.get('location');
      await response.body?.cancel();
      const destination = new URL(location ?? '', address);
      if (destination.origin === address.origin) throw Error('Unexpected asset redirect');
      // GitHub's signed asset CDN URL receives no control token. A second redirect is refused.
      const next = await this.raw('GET', destination, { binary, limit, hashOnly });
      return next;
    }
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
      throw new ApiFailure(
        response.status,
        retryAfter,
        response.status === 429 ||
          response.status >= 500 ||
          (response.status === 403 && retryAfter !== null),
      );
    }
    try {
      const body = await bytes(response, limit, hashOnly);
      return binary ? body : JSON.parse(body.toString('utf8'));
    } catch (error) {
      if (error.message?.includes('size budget')) throw error;
      throw new ApiFailure(null, null, true);
    }
  }
  async get(path, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.raw('GET', `https://api.github.com${path}`, options);
      } catch (error) {
        if (!error.transient || attempt === 2) throw error;
        await this.pause(error, attempt);
      }
    }
  }
  async mutation(action, reconcile) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await action();
      } catch (error) {
        if (!error.transient && error.status !== 422) throw error;
        // A failed response can follow a committed mutation. Observe before any retry.
        if (error.transient) await this.pause(error, attempt);
        const found = await reconcile();
        if (found !== undefined) return found;
        if (attempt === 2 || error.status === 422) throw error;
      }
    }
  }
  async authenticate() {
    const repo = await this.get(REPO);
    if (repo.private !== false)
      throw Error(
        'Publication is disabled while the repository is private or its visibility is unknown',
      );
    if (
      repo.full_name?.toLowerCase() !== 'kabudu/lascoria' ||
      !(repo.permissions?.push || repo.permissions?.admin)
    )
      throw Error(
        'Release publication requires authenticated push access to the intended repository',
      );
  }
  async find(tag) {
    // GitHub documents the tag endpoint as published-only. Listing with push access also
    // sees interrupted drafts. A failure is never interpreted as an absent release.
    for (let page = 1; page <= 50; page++) {
      const releases = await this.get(`${REPO}/releases?per_page=20&page=${page}`);
      if (!Array.isArray(releases)) throw Error('Invalid release listing');
      const matches = releases.filter((r) => r.tag_name === tag);
      if (matches.length > 1) throw Error('Ambiguous release identity');
      if (matches.length) return matches[0];
      if (releases.length < 20) return null;
    }
    throw Error('Release history exceeds reconciliation budget; inspect it manually');
  }
  async tagCommit(tag) {
    let object = (await this.get(`${REPO}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
    for (let depth = 0; depth < 5; depth++) {
      if (!/^[a-f0-9]{40,64}$/.test(object?.sha ?? '')) throw Error('Invalid release tag object');
      if (object.type === 'commit') return object.sha;
      if (object.type !== 'tag') throw Error('Release tag does not resolve to a commit');
      object = (await this.get(`${REPO}/git/tags/${object.sha}`)).object;
    }
    throw Error('Release tag nesting exceeds its budget');
  }
  async assets(release) {
    const assets = await this.get(`${REPO}/releases/${id(release.id)}/assets?per_page=100`);
    if (
      !Array.isArray(assets) ||
      assets.length > MAX_ASSETS ||
      new Set(assets.map((a) => a.name)).size !== assets.length
    )
      throw Error('Ambiguous or oversized release asset list');
    return assets;
  }
  async assetBytes(asset, limit) {
    if (asset.size > limit) throw Error('Release asset exceeds its size budget');
    return this.get(`${REPO}/releases/assets/${id(asset.id)}`, { binary: true, limit });
  }
  async verifyAsset(asset, expected) {
    if (asset.state !== 'uploaded' || asset.size !== expected.size)
      throw Error(`Conflicting release asset: ${expected.name}`);
    const digest = asset.digest;
    if (digest) {
      if (digest !== `sha256:${expected.sha256}`)
        throw Error(`Conflicting release asset: ${expected.name}`);
    } else {
      const downloaded = await this.get(`${REPO}/releases/assets/${id(asset.id)}`, {
        binary: true,
        limit: expected.size,
        hashOnly: true,
      });
      if (downloaded.size !== expected.size || downloaded.sha256 !== expected.sha256)
        throw Error(`Conflicting release asset: ${expected.name}`);
    }
  }
  async upload(release, expected) {
    const current = await this.assets(release);
    const previous = current.find((a) => a.name === expected.name);
    if (previous) {
      await this.verifyAsset(previous, expected);
      return previous;
    }
    await this.mutation(
      () =>
        this.raw(
          'POST',
          `https://uploads.github.com${REPO}/releases/${id(release.id)}/assets?name=${encodeURIComponent(expected.name)}`,
          { file: expected },
        ),
      async () => {
        const asset = (await this.assets(release)).find((a) => a.name === expected.name);
        if (!asset) return undefined;
        await this.verifyAsset(asset, expected);
        return asset;
      },
    );
    const saved = (await this.assets(release)).find((a) => a.name === expected.name);
    if (!saved) throw Error('Upload was not confirmed; no publication attempted');
    await this.verifyAsset(saved, expected);
    return saved;
  }
  async rename(release, asset, name) {
    await this.mutation(
      () =>
        this.raw('PATCH', `https://api.github.com${REPO}/releases/assets/${id(asset.id)}`, {
          json: { name },
        }),
      async () => {
        const now = (await this.assets(release)).find((a) => a.id === asset.id);
        if (now?.name === name) return now;
        if (!now || now.name !== asset.name)
          throw Error('Channel asset changed during reconciliation');
        return undefined;
      },
    );
  }
}

async function digestFile(path) {
  const meta = await lstat(path);
  if (!meta.isFile() || meta.size > MAX_ASSET_BYTES)
    throw Error('Release assets must be bounded regular files');
  const digest = createHash('sha256');
  let count = 0;
  for await (const chunk of createReadStream(path)) {
    count += chunk.length;
    if (count > meta.size) throw Error('Release asset changed while hashing');
    digest.update(chunk);
  }
  if (count !== meta.size) throw Error('Release asset changed while hashing');
  return { name: basename(path), path, size: count, sha256: digest.digest('hex') };
}

function metadata(release, expected) {
  const keys = ['tag_name', 'name', 'body', 'prerelease'];
  // The rolling alias retains its initial target; immutable version releases do not.
  if (expected.tag_name !== 'updater-beta') keys.push('target_commitish');
  for (const key of keys)
    if (release[key] !== expected[key]) throw Error(`Release metadata conflict: ${key}`);
  id(release.id);
}

async function createDraft(client, expected) {
  let release = await client.find(expected.tag_name);
  if (!release)
    release = await client.mutation(
      () =>
        client.raw('POST', `https://api.github.com${REPO}/releases`, {
          json: { ...expected, draft: true },
        }),
      async () => (await client.find(expected.tag_name)) ?? undefined,
    );
  metadata(release, expected);
  return release;
}

async function publishDraft(client, release, expected) {
  if (!release.draft) return;
  let makeLatest = 'false';
  if (!expected.prerelease) {
    let latest;
    try {
      latest = await client.get(`${REPO}/releases/latest`);
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (latest) {
      if (!latest.tag_name?.startsWith('v'))
        throw Error('Current stable release has an unknown version');
      makeLatest =
        compare(expected.tag_name.slice(1), latest.tag_name.slice(1)) > 0 ? 'true' : 'false';
    } else makeLatest = 'true';
  }
  await client.mutation(
    () =>
      client.raw('PATCH', `https://api.github.com${REPO}/releases/${id(release.id)}`, {
        json: { draft: false, make_latest: makeLatest },
      }),
    async () => {
      const current = await client.find(expected.tag_name);
      if (!current) throw Error('Release disappeared while publishing');
      metadata(current, expected);
      return current.draft ? undefined : current;
    },
  );
  const current = await client.find(expected.tag_name);
  if (!current || current.draft) throw Error('Publication was not confirmed; inspect the release');
  metadata(current, expected);
}

/** Resume only the same immutable artifact set; no draft/release/asset is ever deleted. */
export async function publishRelease({ client, tag, commit, directory, title, body }) {
  const version = tag?.startsWith('v') ? tag.slice(1) : '';
  const parsed = parse(version);
  if (
    !/^[a-f0-9]{40,64}$/.test(commit ?? '') ||
    !title ||
    title.length > 200 ||
    !body ||
    body.length > 64_000
  )
    throw Error('Invalid release commit/title/body');
  const names = await readdir(directory);
  if (!names.length || names.length > MAX_ASSETS || names.some((n) => !/^[A-Za-z0-9_.-]+$/.test(n)))
    throw Error('Invalid release asset inventory');
  for (const required of ['latest.json', 'SHA256SUMS.txt'])
    if (!names.includes(required)) throw Error(`Missing ${required}`);
  const expectedAssets = [];
  for (const name of names) expectedAssets.push(await digestFile(join(directory, name)));
  if (expectedAssets.find((a) => a.name === 'SHA256SUMS.txt').size > 32_000)
    throw Error('Checksum inventory exceeds its budget');
  const sumsText = await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8');
  if (sumsText.length > 32_000) throw Error('Checksum inventory exceeds its budget');
  const sums = new Map();
  for (const line of sumsText.trim().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || sums.has(match[2])) throw Error('Invalid checksum inventory');
    sums.set(match[2], match[1]);
  }
  if (
    sums.size !== expectedAssets.length - 1 ||
    expectedAssets.some((a) => a.name !== 'SHA256SUMS.txt' && sums.get(a.name) !== a.sha256)
  )
    throw Error('Local artifact bytes do not match their checksum inventory');
  await client.authenticate();
  if ((await client.tagCommit(tag)) !== commit)
    throw Error('Release tag does not match the reviewed commit');
  const expected = {
    tag_name: tag,
    target_commitish: commit,
    name: title,
    body,
    prerelease: parsed.prerelease !== null,
  };
  const release = await createDraft(client, expected);
  const validate = async (complete) => {
    const assets = await client.assets(release);
    for (const asset of assets) {
      const local = expectedAssets.find((a) => a.name === asset.name);
      if (!local) throw Error(`Unexpected remote release asset: ${asset.name}`);
      await client.verifyAsset(asset, local);
    }
    if (complete && assets.length !== expectedAssets.length)
      throw Error('Published release has missing assets');
  };
  await validate(!release.draft);
  if (!release.draft) return { result: 'already-published', tag };
  for (const asset of expectedAssets) await client.upload(release, asset);
  await validate(true);
  if ((await client.tagCommit(tag)) !== commit) throw Error('Release tag moved before publication');
  await publishDraft(client, release, expected);
  await validate(true);
  return { result: 'published', tag };
}

/** Mutable beta alias, under the workflow's global publication lock. Never clobbers: first
 * stage verified bytes, rename the old manifest to a digest backup, then promote the stage.
 * An interrupted swap is recovered by choosing the highest verified version already present.
 * Existing immutable per-tag artifacts are never modified. */
export async function updateBeta({ client, commit, manifestPath, serialized = false }) {
  if (!serialized) throw Error('The beta channel requires globally serialized publication');
  if (!/^[a-f0-9]{40,64}$/.test(commit ?? '')) throw Error('Invalid beta channel commit');
  const incoming = await digestFile(manifestPath);
  if (incoming.size > 1024 ** 2) throw Error('Beta manifest exceeds its budget');
  const localBytes = await readFile(manifestPath);
  const local = JSON.parse(localBytes);
  parse(local.version);
  if (hash(localBytes) !== incoming.sha256) throw Error('Beta manifest changed while reading');
  await client.authenticate();
  const expected = {
    tag_name: 'updater-beta',
    target_commitish: commit,
    name: 'Beta updater channel',
    body: BETA_BODY,
    prerelease: true,
  };
  const release = await createDraft(client, expected);
  const assets = await client.assets(release);
  if (
    assets.some(
      (a) => a.name !== 'latest.json' && !/^(staged|previous)-[a-f0-9-]+\.json$/.test(a.name),
    )
  )
    throw Error('Unexpected beta-channel asset; reconcile manually');
  const candidates = [
    { version: local.version, sha256: incoming.sha256, size: incoming.size, local: true },
  ];
  for (const asset of assets) {
    const data = await client.assetBytes(asset, 1024 ** 2);
    const sha256 = hash(data);
    await client.verifyAsset(asset, { name: asset.name, size: data.length, sha256 });
    const value = JSON.parse(data);
    parse(value.version);
    candidates.push({ version: value.version, sha256, size: data.length, asset });
  }
  candidates.sort((a, b) => compare(b.version, a.version));
  const highest = candidates[0];
  if (candidates.some((c) => c.version === highest.version && c.sha256 !== highest.sha256))
    throw Error('Beta manifests disagree for the same version');
  const current = candidates.find((c) => c.asset?.name === 'latest.json');
  if (current?.version === highest.version && current.sha256 === highest.sha256) {
    await publishDraft(client, release, expected);
    return { result: 'kept-current', version: current.version };
  }
  let stage = candidates.find((c) => c.asset && c.sha256 === highest.sha256)?.asset;
  if (!stage)
    stage = await client.upload(release, { ...incoming, name: `staged-${highest.sha256}.json` });
  // Re-read immediately before the swap. The workflow lock excludes other release jobs;
  // unexpected manual mutation fails closed rather than replacing an unseen manifest.
  const refreshed = await client.assets(release);
  const latest = refreshed.find((a) => a.name === 'latest.json');
  if ((latest?.id ?? null) !== (current?.asset.id ?? null))
    throw Error('Beta channel changed before its swap');
  if (latest) {
    await client.verifyAsset(latest, {
      name: latest.name,
      size: current.size,
      sha256: current.sha256,
    });
    await client.rename(release, latest, `previous-${latest.id}-${current.sha256}.json`);
  }
  const beforePromote = await client.assets(release);
  if (beforePromote.some((a) => a.name === 'latest.json'))
    throw Error('Beta channel changed during its swap');
  await client.rename(release, stage, 'latest.json');
  const confirmed = (await client.assets(release)).find((a) => a.name === 'latest.json');
  if (!confirmed) throw Error('Beta promotion was not confirmed; rerun to reconcile');
  await client.verifyAsset(confirmed, {
    name: confirmed.name,
    size: highest.size,
    sha256: highest.sha256,
  });
  await publishDraft(client, release, expected);
  return { result: 'updated', version: highest.version };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const client = new GitHubReleaseClient({ token: process.env.GH_TOKEN });
    const [command, ...args] = process.argv.slice(2);
    let result;
    if (command === 'release' && args.length === 5) {
      const [tag, commit, directory, titleFile, notesFile] = args;
      result = await publishRelease({
        client,
        tag,
        commit,
        directory,
        title: (await readFile(titleFile, 'utf8')).trim(),
        body: (await readFile(notesFile, 'utf8')).trim(),
      });
    } else if (command === 'beta' && args.length === 2)
      result = await updateBeta({
        client,
        commit: args[0],
        manifestPath: args[1],
        serialized: process.env.LASCORIA_SERIALIZED_PUBLISH === '1',
      });
    else
      throw Error(
        'Usage: publish-release.js release <tag> <commit> <dir> <title-file> <notes-file> | beta <commit> <latest.json>',
      );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
