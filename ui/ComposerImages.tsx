import { useEffect, useRef, useState } from 'react';
import { request } from './api';

/** One image waiting in a session's composer. Bytes stay in Lascoria's private storage. */
type Staged = {
  key: string;
  id: string;
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
type Limits = { imageBytes: number; perTurn: number; perSession: number; chunkBase64: number };
const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
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
 * Compact image strip for the composer (R14). Choosing, pasting or dropping only stages an
 * image for this session; nothing reaches Muse until the user starts a task. Images waiting
 * here survive reloads because the supervisor keeps them, owned by the session.
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
  /** Ready image IDs in order, and whether sending must wait (preparing or too many). */
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
      () => live.current && setNotice('Images waiting for this session could not be loaded.'),
    );
    return () => {
      live.current = false;
    };
  }, [sessionId]);
  useEffect(() => {
    const ready = items.filter((i) => i.status === 'ready').map((i) => i.id);
    onChange(
      ready,
      items.some((i) => i.status === 'preparing') || ready.length > (limits?.perTurn ?? 4),
    );
  }, [items, limits]);
  useEffect(() => {
    if (addRequest?.files.length && addRequest.at >= mountedAt.current) void add(addRequest.files);
  }, [addRequest?.at]);

  async function upload(item: Staged, file: File) {
    const id = crypto.randomUUID();
    update(item.key, { id, status: 'preparing', progress: 0, error: undefined });
    try {
      const data = await file.arrayBuffer();
      const checksum = await sha256(data);
      await request('attachment/begin', {
        sessionId,
        attachmentId: id,
        name: file.name || 'Pasted image',
        bytes: data.byteLength,
      });
      const step = RAW_CHUNK(limits?.chunkBase64 ?? 45056);
      const bytes = new Uint8Array(data);
      for (let offset = 0; offset < bytes.length; offset += step) {
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
    const accepted: File[] = [];
    for (const file of files) {
      if (!ACCEPT.includes(file.type)) {
        setNotice(
          `${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image. Other files can't be attached yet.`,
        );
        continue;
      }
      if (limits && file.size > limits.imageBytes) {
        setNotice(`${file.name} is larger than ${size(limits.imageBytes)}.`);
        continue;
      }
      accepted.push(file);
    }
    const room = (limits?.perSession ?? 8) - items.length;
    if (accepted.length > room)
      setNotice(`A session can hold ${limits?.perSession ?? 8} waiting images; remove one first.`);
    for (const file of accepted.slice(0, Math.max(0, room))) {
      const item: Staged = {
        key: crypto.randomUUID(),
        id: '',
        name: file.name || 'Pasted image',
        bytes: file.size,
        status: 'preparing',
        progress: 0,
        file,
      };
      setItems((previous) => [...previous, item]);
      void readPreview(file).then((preview) => update(item.key, { preview }));
      await upload(item, file);
    }
  }

  async function remove(item: Staged) {
    setItems((previous) => previous.filter((i) => i.key !== item.key));
    if (item.id)
      await request('attachment/discard', { sessionId, attachmentId: item.id }).catch(() =>
        setNotice(`${item.name} was removed here but may still be stored; it will not be sent.`),
      );
  }

  const ready = items.filter((i) => i.status === 'ready').length;
  const tooMany = limits && ready > limits.perTurn;
  return (
    <div className="composer-images">
      <div className="composer-images-row">
        <button
          type="button"
          className="composer-images-add"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          Add image
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT.join(',')}
          multiple
          hidden
          aria-label="Choose images to attach"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            void add(files);
          }}
        />
        {items.length > 0 && (
          <ul className="composer-images-strip" aria-label="Images for the next task">
            {items.map((item) => (
              <li key={item.key} className={`composer-image ${item.status}`}>
                {item.preview ? (
                  <img src={item.preview} alt="" />
                ) : (
                  <span className="composer-image-icon" aria-hidden="true">
                    IMG
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
          {notice ||
            (tooMany
              ? `A task can include ${limits!.perTurn} images; remove ${ready - limits!.perTurn}.`
              : 'Images are sent with the next task, not with steering.')}
        </p>
      )}
    </div>
  );
}
