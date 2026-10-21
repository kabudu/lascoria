import { useEffect, useState } from 'react';
import { request } from './api';
import type { SessionRow } from './types';

export type SearchResult = {
  sessionId: string;
  archived: boolean;
  turnId?: string | null;
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
  open: (result: SearchResult) => string | undefined;
}) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [retry, setRetry] = useState(0);
  const [results, setResults] = useState<SearchResult[]>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [navigationError, setNavigationError] = useState('');
  const [busy, setBusy] = useState(false);
  const scopeAvailable = !scope || sessions.some((session) => session.id === scope);
  useEffect(() => {
    const text = query.trim();
    setResults(undefined);
    setTruncated(false);
    setError('');
    setNavigationError('');
    setBusy(Boolean(text) && scopeAvailable);
    if (!text || !scopeAvailable) return;
    // Query, scope and unmount each invalidate both successful and failed older replies.
    let cancelled = false;
    const timer = setTimeout(() => {
      void request<{ results: SearchResult[]; truncated: boolean }>('search', {
        query: text,
        ...(scope ? { sessionId: scope } : {}),
      }).then(
        (reply) => {
          if (cancelled) return;
          setResults(reply.results);
          setTruncated(reply.truncated);
          setBusy(false);
        },
        (failure) => {
          if (cancelled) return;
          setError(String(failure));
          setBusy(false);
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, scope, scopeAvailable, retry]);
  const duplicates = new Map<string, number>();
  for (const session of sessions)
    duplicates.set(name(session), (duplicates.get(name(session)) ?? 0) + 1);
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
      <label>
        Search in
        <select
          aria-label="Search in"
          value={scope}
          onChange={(event) => setScope(event.target.value)}
        >
          <option value="">All sessions</option>
          {!scopeAvailable && <option value={scope}>Unavailable session</option>}
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>
              {name(session)}
              {session.lifecycle === 'archived' ? ' · Archived' : ''}
              {(duplicates.get(name(session)) ?? 0) > 1 ? ` · ${session.id.slice(-8)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        Searches the latest 100 messages kept for{' '}
        {scope ? 'this session' : 'each session, including archived ones'}.
      </p>
      {!scopeAvailable && (
        <p role="alert">
          This session is no longer available. Choose another session or All sessions.
        </p>
      )}
      {busy && <p role="status">Searching…</p>}
      {(error || navigationError) && (
        <div>
          <p role="alert">{navigationError || `Search is unavailable: ${error}`}</p>
          <button onClick={() => setRetry((value) => value + 1)}>Retry search</button>
        </div>
      )}
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
              <button
                onClick={() => {
                  const failure = open(result);
                  if (failure) setNavigationError(failure);
                }}
              >
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
