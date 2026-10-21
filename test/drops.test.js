import test from 'node:test';
import assert from 'node:assert/strict';
import { droppedFiles } from '../ui/drops.ts';
const entry = (bytes, name = 'clip.mp4') => ({ name, path: '/fixture', directory: false, bytes });
const drop = (entries) => ({ token: 1, entries, more: 0 });
test('native drops reject an oversized batch before reading any bytes', async () => {
  let reads = 0;
  await assert.rejects(
    droppedFiles(
      drop([entry(80 * 1024 ** 2), entry(80 * 1024 ** 2)]),
      () => true,
      async () => {
        reads++;
        return new ArrayBuffer(0);
      },
    ),
    /100 MB/,
  );
  assert.equal(reads, 0);
});
test('native drops stop after a session change and never read the next file', async () => {
  let current = true,
    reads = 0;
  await assert.rejects(
    droppedFiles(
      drop([entry(1, 'a.txt'), entry(1, 'b.txt')]),
      () => current,
      async () => {
        reads++;
        current = false;
        return new ArrayBuffer(1);
      },
    ),
    /session changed/,
  );
  assert.equal(reads, 1);
});
test('native drops refuse concurrent reads and recover after the first completes', async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const first = droppedFiles(
    drop([entry(1, 'a.txt')]),
    () => true,
    async () => {
      await gate;
      return new ArrayBuffer(1);
    },
  );
  try {
    await assert.rejects(droppedFiles(drop([entry(1)])), /already being prepared/);
  } finally {
    release();
  }
  assert.equal((await first).files.length, 1);
});
test('native drops bound actual bytes when a file changes after the drop', async () => {
  let reads = 0;
  await assert.rejects(
    droppedFiles(
      drop([entry(1)]),
      () => true,
      async (_token, _index, limit) => {
        reads++;
        assert.equal(limit, 100 * 1024 ** 2);
        return { byteLength: limit + 1 };
      },
    ),
    /100 MB/,
  );
  assert.equal(reads, 1);
});
test('native drops report folders without reading them and enforce file count', async () => {
  const result = await droppedFiles(drop([{ ...entry(null, 'folder'), directory: true }]));
  assert.deepEqual(result.folders, ['folder']);
  await assert.rejects(
    droppedFiles(drop(Array.from({ length: 9 }, () => entry(1)))),
    /eight files/,
  );
});
