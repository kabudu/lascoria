import { useEffect, useRef, useState } from 'react';
import { request } from './api';

type Kind = 'image' | 'video' | 'text';
/** One attachment waiting in a session's composer. Bytes stay in Lascoria's private storage. */
type Staged = {
  key: string;
  id: string;
  kind?: Kind;
  name: string;
  bytes: number;
  mediaType?: string;
  width?: number;
  height?: number;
  status: 'preparing' | 'ready' | 'error';
  progress: number;
  error?: string;
  preview?: string;
  file?: File;
};
type Limits = {
  imageBytes: number;
  perTurn: number;
  perSession: number;
  chunkBase64: number;
  videoBytes?: number;
  videosPerTurn?: number;
  textBytes?: number;
  textsPerTurn?: number;
};
// Used until the supervisor reports its limits (or if that read fails), so a large file is
// refused before any preview, read or hash, never only after it has been loaded into memory.
const FALLBACK: Limits = {
  imageBytes: 5 * 1024 * 1024,
  perTurn: 4,
  perSession: 8,
  chunkBase64: 44 * 1024,
  videoBytes: 100 * 1024 * 1024,
  videosPerTurn: 1,
  textBytes: 256 * 1024,
  textsPerTurn: 4,
};
const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const VIDEOS = ['video/mp4', 'video/quicktime'];
const VIDEO_NAME = /\.(mp4|m4v|mov)$/i;
// Formats Muse has no way to read here. Refused before reading, with the reason.
const UNREADABLE =
  /^(application\/(pdf|zip|x-zip|gzip|x-tar|x-7z|x-rar|vnd\.|msword)|audio\/|video\/|image\/|font\/)/;
const UNREADABLE_NAME =
  /\.(pdf|zip|gz|tgz|tar|7z|rar|docx?|xlsx?|pptx?|key|pages|numbers|mp3|wav|m4a|aac|flac|ogg|avi|mkv|webm|heic|tiff?|bmp|exe|dmg|pkg|app|so|dylib|dll|wasm|bin|sqlite|db)$/i;

/** What a chosen file will be staged as, or why it cannot be attached. */
export function kindOf(file: { name: string; type: string }): Kind | string {
  if (IMAGES.includes(file.type)) return 'image';
  if (VIDEOS.includes(file.type) || (!file.type && VIDEO_NAME.test(file.name))) return 'video';
  if (UNREADABLE.test(file.type) || UNREADABLE_NAME.test(file.name))
    return `${file.name || 'That file'} can't be attached: Lascoria attaches PNG, JPEG, GIF or WebP images, MP4 or QuickTime videos and text files.`;
  return 'text';
}
const NOUN: Record<Kind, string> = { image: 'image', video: 'video', text: 'text file' };
const ICON: Record<Kind, string> = { image: 'IMG', video: 'VID', text: 'TXT' };
const RAW_CHUNK = (base64: number) => Math.floor(base64 / 4) * 3;

function size(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
function base64(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
async function sha256(bytes: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const readPreview = (file: File) =>
  new Promise<string | undefined>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });

/**
 * Compact attachment strip for the composer (R14): images, videos and text files. Choosing,
 * pasting or dropping only stages a file for this session; nothing reaches Muse until the
 * user starts a task. Attachments waiting here survive reloads because the supervisor keeps
 * them, owned by the session.
 */
export function ComposerImages({
  sessionId,
  disabled,
  steering,
  onChange,
  addRequest,
}: {
  sessionId: string;
  disabled: boolean;
  steering: boolean;
  /** Ready attachment IDs in order, and whether sending must wait (preparing or too many). */
  onChange: (ready: string[], blocked: boolean) => void;
  /** Files pasted or dropped onto the composer by the parent form. */
  addRequest?: { files: File[]; at: number };
}) {
  const [items, setItems] = useState<Staged[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [notice, setNotice] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  // A paste or drop that happened before this strip mounted belongs to another session.
  const mountedAt = useRef(Date.now());
  const update = (key: string, change: Partial<Staged>) =>
    live.current &&
    setItems((previous) => previous.map((i) => (i.key === key ? { ...i, ...change } : i)));

  useEffect(() => {
    live.current = true;
    void request<{ attachments: Staged[]; limits: Limits }>('attachment/list', { sessionId }).then(
      (result) => {
        if (!live.current) return;
        setLimits(result.limits);
        setItems((previous) => [
          ...result.attachments
            .filter((a) => !previous.some((p) => p.id === a.id))
            .map((a) => ({ ...a, key: a.id, status: 'ready' as const, progress: 1 })),
          ...previous,
        ]);
      },
      () => live.current && setNotice('Attachments waiting for this session could not be loaded.'),
    );
    return () => {
      live.current = false;
    };
  }, [sessionId]);
  useEffect(() => {
    const ready = items.filter((i) => i.status === 'ready').map((i) => i.id);
    onChange(ready, items.some((i) => i.status === 'preparing') || Boolean(excess()));
  }, [items, limits]);
  useEffect(() => {
    if (addRequest?.files.length && addRequest.at >= mountedAt.current) void add(addRequest.files);
  }, [addRequest?.at]);

  // A retry reuses the item's upload ID, so an upload whose last reply was lost resumes (or is
  // found already finished) instead of leaving a second, orphaned copy in the session.
  async function upload(item: Staged, file: File) {
    const id = item.id || crypto.randomUUID();
    update(item.key, { id, status: 'preparing', progress: 0, error: undefined });
    try {
      const data = await file.arrayBuffer();
      const checksum = await sha256(data);
      const started = await request<{ status: string; received?: number }>('attachment/begin', {
        sessionId,
        attachmentId: id,
        name: file.name || 'Pasted image',
        bytes: data.byteLength,
        kind: item.kind ?? 'image',
      });
      const step = RAW_CHUNK((limits ?? FALLBACK).chunkBase64);
      const bytes = new Uint8Array(data);
      const resume = started.status === 'ready' ? bytes.length : (started.received ?? 0);
      for (let offset = resume; offset < bytes.length; offset += step) {
        if (!live.current) return;
        await request('attachment/append', {
          sessionId,
          attachmentId: id,
          offset,
          data: base64(bytes.subarray(offset, offset + step)),
        });
        update(item.key, { progress: Math.min(1, (offset + step) / bytes.length) });
      }
      const ready = await request<Staged>('attachment/finish', {
        sessionId,
        attachmentId: id,
        sha256: checksum,
      });
      update(item.key, { ...ready, key: item.key, status: 'ready', progress: 1 });
    } catch (error) {
      update(item.key, {
        status: 'error',
        error: String(error).replace(/^Error: /, ''),
      });
    }
  }

  async function add(files: File[]) {
    setNotice('');
    const accepted: [File, Kind][] = [];
    const current = limits ?? FALLBACK;
    for (const file of files) {
      const kind = kindOf(file);
      if (kind !== 'image' && kind !== 'video' && kind !== 'text') {
        setNotice(kind);
        continue;
      }
      const cap =
        kind === 'image'
          ? current.imageBytes
          : kind === 'video'
            ? (current.videoBytes ?? FALLBACK.videoBytes!)
            : (current.textBytes ?? FALLBACK.textBytes!);
      if (file.size > cap) {
        setNotice(
          `${file.name || 'That file'} is larger than ${size(cap)}, the ${NOUN[kind]} limit.`,
        );
        continue;
      }
      accepted.push([file, kind]);
    }
    const perSession = current.perSession;
    const room = perSession - items.length;
    if (accepted.length > room)
      setNotice(`A session can hold ${perSession} waiting attachments; remove one first.`);
    for (const [file, kind] of accepted.slice(0, Math.max(0, room))) {
      const item: Staged = {
        key: crypto.randomUUID(),
        id: '',
        kind,
        name: file.name || 'Pasted image',
        bytes: file.size,
        status: 'preparing',
        progress: 0,
        file,
      };
      setItems((previous) => [...previous, item]);
      if (kind === 'image') void readPreview(file).then((preview) => update(item.key, { preview }));
      await upload(item, file);
    }
  }

  /** The first per-task limit the ready attachments exceed, as a sentence. */
  function excess() {
    const current = limits ?? FALLBACK;
    const ready = items.filter((i) => i.status === 'ready');
    const count = (kind: Kind) => ready.filter((i) => (i.kind ?? 'image') === kind).length;
    const rules: [Kind, number][] = [
      ['image', current.perTurn],
      ['video', current.videosPerTurn ?? 1],
      ['text', current.textsPerTurn ?? 4],
    ];
    for (const [kind, most] of rules)
      if (count(kind) > most)
        return `A task can include ${most === 1 ? 'one' : most} ${NOUN[kind]}${most === 1 ? '' : 's'}; remove ${count(kind) - most}.`;
    return '';
  }

  async function remove(item: Staged) {
    setItems((previous) => previous.filter((i) => i.key !== item.key));
    if (item.id)
      await request('attachment/discard', { sessionId, attachmentId: item.id }).catch(() =>
        setNotice(`${item.name} was removed here but may still be stored; it will not be sent.`),
      );
  }

  const tooMany = excess();
  return (
    <div className="composer-images">
      <div className="composer-images-row">
        <button
          type="button"
          className="composer-images-add"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          Attach file
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Choose files to attach"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            void add(files);
          }}
        />
        {items.length > 0 && (
          <ul className="composer-images-strip" aria-label="Attachments for the next task">
            {items.map((item) => (
              <li key={item.key} className={`composer-image ${item.status}`}>
                {item.preview ? (
                  <img src={item.preview} alt="" />
                ) : (
                  <span className="composer-image-icon" aria-hidden="true">
                    {ICON[item.kind ?? 'image']}
                  </span>
                )}
                <span className="composer-image-text">
                  <span className="composer-image-name" title={item.name}>
                    {item.name}
                  </span>
                  <small role={item.status === 'error' ? 'alert' : undefined}>
                    {item.status === 'preparing'
                      ? `Preparing ${Math.round(item.progress * 100)}%`
                      : item.status === 'error'
                        ? item.error
                        : `${size(item.bytes)}${item.width ? ` · ${item.width}×${item.height}` : ''}`}
                  </small>
                </span>
                {item.status === 'error' && item.file && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void upload(item, item.file!)}
                    aria-label={`Retry ${item.name}`}
                  >
                    Retry
                  </button>
                )}
                <button
                  type="button"
                  disabled={item.status === 'preparing'}
                  onClick={() => void remove(item)}
                  aria-label={`Remove ${item.name}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {(notice || (steering && items.length > 0) || tooMany) && (
        <p className="composer-images-note" role="status">
          {notice || tooMany || 'Attachments are sent with the next task, not with steering.'}
        </p>
      )}
      {items.some((item) => item.kind === 'video') && (
        <p className="composer-images-note">
          When you send a video, Muse uploads it to your model provider&apos;s file storage, where
          it can be kept for up to 30 days, and keeps a copy in this session.
        </p>
      )}
    </div>
  );
}
