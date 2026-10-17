import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { SessionRow } from './types';

type Result = {
  sessionId: string;
  archived: boolean;
  itemId: string;
  kind: string;
  snippet: string;
};

/** Searches text Lascoria keeps locally; opening a result never contacts Muse. */
export function HistorySearch({
  sessions,
  name,
  open,
}: {
  sessions: SessionRow[];
  name: (session: SessionRow) => string;
  open: (sessionId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Result[]>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(undefined);
      setError('');
      return;
    }
    // Debounced, and only the newest reply is shown.
    const order = ++latest.current;
    const timer = setTimeout(() => {
      setBusy(true);
      void request<{ results: Result[]; truncated: boolean }>('search', { query: text }).then(
        (reply) => {
          if (order !== latest.current) return;
          setResults(reply.results);
          setTruncated(reply.truncated);
          setError('');
          setBusy(false);
        },
        (failure) => {
          if (order !== latest.current) return;
          setError(String(failure));
          setBusy(false);
        },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const label = (id: string) => {
    const row = sessions.find((s) => s.id === id);
    return row ? name(row) : `Session ${id.slice(-8)}`;
  };
  return (
    <section className="history-search" aria-label="Search history" aria-busy={busy}>
      <label>
        Search messages
        <input
          type="search"
          value={query}
          autoFocus
          maxLength={200}
          placeholder="Words from a task, reply or note"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="muted">
        Searches the latest 100 messages kept for each session, including archived ones.
      </p>
      {error && <p role="alert">Search is unavailable: {error}</p>}
      {results && (
        <p role="status">
          {results.length === 0
            ? 'No matching messages.'
            : `${results.length}${truncated ? '+' : ''} ${results.length === 1 ? 'match' : 'matches'}`}
        </p>
      )}
      {results && results.length > 0 && (
        <ul className="history-results" aria-label="Search results">
          {results.map((result) => (
            <li key={`${result.sessionId}:${result.itemId}`}>
              <button onClick={() => open(result.sessionId)}>
                <span className="eyebrow">
                  {label(result.sessionId)} · {result.kind === 'userMessage' ? 'You' : 'Muse'}
                  {result.archived ? ' · Archived' : ''}
                </span>
                <span>{result.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {truncated && (
        <p className="muted">Showing the first 50 matches. Add words to narrow the search.</p>
      )}
    </section>
  );
}
