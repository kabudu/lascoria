import { invoke } from '@tauri-apps/api/core';

/** One entry of a native drop: the desktop app reports names, folder flags and sizes. */
export type DropEntry = {
  name: string;
  path: string | null;
  directory: boolean;
  bytes: number | null;
};
export type NativeDrop = { token: number; entries: DropEntry[]; more: number };

/** Dispatched on the drop target (an element with `data-drop-target`) under the pointer. */
export const DROP_EVENT = 'lascoria-native-drop';

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
};
/** A type from the extension, so the composer's own checks (and the supervisor's content
 * checks after it) apply as they do to chosen files. */
export function typeFor(name: string) {
  return TYPES[name.split('.').at(-1)?.toLowerCase() ?? ''] ?? '';
}

/**
 * The files of a native drop as File objects, read through the desktop app one at a time.
 * Folders are not files; their names are returned so the caller can say so.
 */
let reading = false;
const MAX_BATCH_BYTES = 100 * 1024 * 1024;
export async function droppedFiles(
  drop: NativeDrop,
  current: () => boolean = () => true,
  read: (token: number, index: number, maxBytes: number) => Promise<ArrayBuffer> = (
    token,
    index,
    maxBytes,
  ) => invoke<ArrayBuffer>('read_dropped', { token, index, maxBytes }),
) {
  if (reading) throw new Error('A drop is already being prepared; try again when it finishes.');
  const entries = drop.entries.filter((entry) => !entry.directory);
  if (drop.more || entries.length > 8) throw new Error('Drop at most eight files at a time.');
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes! < 0)
      throw new Error(`${entry.name} is not a readable regular file.`);
    total += entry.bytes!;
    if (total > MAX_BATCH_BYTES) throw new Error('A drop can contain at most 100 MB in total.');
  }
  reading = true;
  try {
    const files: File[] = [];
    const folders: string[] = [];
    let remaining = MAX_BATCH_BYTES;
    const check = () => {
      if (!current())
        throw new Error('The session changed; drop the files again in the intended session.');
    };
    for (const [index, entry] of drop.entries.entries()) {
      check();
      if (entry.directory) {
        folders.push(entry.name);
        continue;
      }
      const bytes = await read(drop.token, index, remaining);
      check();
      if (bytes.byteLength > remaining)
        throw new Error('A drop can contain at most 100 MB in total.');
      remaining -= bytes.byteLength;
      files.push(new File([bytes], entry.name, { type: typeFor(entry.name) }));
    }
    return { files, folders };
  } finally {
    reading = false;
  }
}
