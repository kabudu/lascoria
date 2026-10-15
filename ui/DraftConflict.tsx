import { useEffect, useRef, useState } from 'react';

export function DraftConflict({
  local,
  saved,
  resolve,
  focusRequested,
  onFocused,
}: {
  local: string;
  saved: string;
  resolve: (choice: 'mine' | 'saved') => Promise<void>;
  focusRequested: boolean;
  onFocused: () => void;
}) {
  const firstChoice = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusRequested) {
      firstChoice.current?.focus();
      if (document.activeElement === firstChoice.current) onFocused();
    }
  }, [focusRequested, onFocused]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function choose(choice: 'mine' | 'saved') {
    setBusy(true);
    setError('');
    try {
      await resolve(choice);
      document.getElementById('message')?.focus();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not check the saved draft. Reconnect and try again.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="draft-conflict" aria-label="Draft conflict" aria-busy={busy}>
      <h3>Another window saved a different draft</h3>
      <p>Your text is still here. Compare both copies, then choose which one to keep.</p>
      <div className="draft-comparison">
        <div>
          <h4>Your draft</h4>
          <pre>{local || '(Empty draft)'}</pre>
        </div>
        <div>
          <h4>Saved in another window</h4>
          <pre>{saved || '(Empty draft)'}</pre>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="row">
        <button ref={firstChoice} type="button" disabled={busy} onClick={() => void choose('mine')}>
          Keep my draft
        </button>
        <button type="button" disabled={busy} onClick={() => void choose('saved')}>
          Use saved draft
        </button>
      </div>
    </section>
  );
}
