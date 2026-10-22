import { useState } from 'react';
import type { SessionRow } from './types';

export function ArchiveSession({
  session,
  name,
  busy,
  runningTest,
  archive,
  close,
}: {
  session?: SessionRow;
  name: string;
  busy: boolean;
  runningTest: boolean;
  archive: () => Promise<void>;
  close: () => void;
}) {
  const [error, setError] = useState<string>();
  const active = session?.state.current && session.state.activeTurnId;
  const ready = session && session.lifecycle !== 'archived' && !busy && !active && !runningTest;
  return (
    <div className="archive-session">
      <p>
        Archive <strong>{name}</strong>?
      </p>
      <p>
        Stops this session’s Muse host and frees an active session slot. Your history, evidence,
        files and commits stay available as read-only. No files are deleted.
      </p>
      {active && (
        <p role="status">Wait for the current task to finish, or cancel it before archiving.</p>
      )}
      {runningTest && <p role="status">Wait for the test command to finish before archiving.</p>}
      {!session && <p role="status">This session is no longer available.</p>}
      {session?.lifecycle === 'archived' && <p role="status">This session is already archived.</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="row">
        <button
          disabled={!ready}
          onClick={() => {
            setError(undefined);
            void archive().catch((error) => setError(String(error)));
          }}
        >
          Archive session
        </button>
        <button disabled={busy} onClick={close}>
          Keep session
        </button>
      </div>
    </div>
  );
}
