import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { SessionRow } from './types';

export function RenameSession({
  session,
  initialName,
  refresh,
  close,
}: {
  session: SessionRow;
  initialName: string;
  refresh: () => Promise<unknown>;
  close: () => void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [name, setName] = useState(initialName);
  const [revision, setRevision] = useState(session.nameRevision ?? 0);
  const [attempt, setAttempt] = useState<{
    id: string;
    params: { sessionId: string; name: string; expectedRevision: number };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError('');
        const next = attempt ?? {
          id: crypto.randomUUID(),
          params: { sessionId: session.id, name, expectedRevision: revision },
        };
        setAttempt(next);
        try {
          await request('session/rename', next.params, next.id);
          if (!mounted.current) return;
          await refresh();
          if (mounted.current) close();
        } catch (error) {
          if (!mounted.current) return;
          const message = String(error);
          setError(message);
          if (message.includes('Session name changed')) {
            setAttempt(null);
            setConflict(true);
          }
        } finally {
          if (mounted.current) setBusy(false);
        }
      }}
    >
      <label>
        Session name
        <input
          name="sessionName"
          value={name}
          maxLength={100}
          disabled={busy || !!attempt || conflict}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="muted">
        Leave blank to use the folder name. Renaming does not change folders, Muse history or
        permissions.
      </p>
      {error && <p role="alert">{error}</p>}
      {conflict && (
        <section aria-label="Session name conflict">
          <p>
            Current name: <strong>{initialName || 'Folder default'}</strong>. Your edit is retained
            above.
          </p>
          <div className="relay-actions">
            <button
              type="button"
              onClick={() => {
                setName(initialName);
                setRevision(session.nameRevision ?? 0);
                setConflict(false);
                setError('');
              }}
            >
              Use current name
            </button>
            <button
              type="button"
              onClick={() => {
                setRevision(session.nameRevision ?? 0);
                setConflict(false);
                setError('');
              }}
            >
              Keep my edit
            </button>
          </div>
        </section>
      )}
      {attempt && !busy && (
        <button
          type="button"
          onClick={() => {
            setAttempt(null);
            setError('');
          }}
        >
          Edit name
        </button>
      )}
      <button className="primary" disabled={busy || conflict}>
        {busy ? 'Saving…' : attempt ? 'Retry save' : 'Save name'}
      </button>
    </form>
  );
}
