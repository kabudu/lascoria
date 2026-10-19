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
export async function droppedFiles(drop: NativeDrop) {
  const files: File[] = [];
  const folders: string[] = [];
  for (const [index, entry] of drop.entries.entries()) {
    if (entry.directory) {
      folders.push(entry.name);
      continue;
    }
    const bytes = await invoke<ArrayBuffer>('read_dropped', { token: drop.token, index });
    files.push(new File([bytes], entry.name, { type: typeFor(entry.name) }));
  }
  return { files, folders };
}
