import { useEffect, useState } from 'react';
import { request } from './api';

import type { SubscriptionUsage } from '@muse-code/sdk/dist/src/msp.js';

export function Usage({ sessionId }: { sessionId?: string }) {
  const [observation, setObservation] = useState<SubscriptionUsage>();
  const [loading, setLoading] = useState(Boolean(sessionId));
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    setLoading(Boolean(sessionId));
    if (sessionId) {
      void request<{ usage?: SubscriptionUsage }>('usage', { sessionId }).then(
        (result) => {
          if (!cancelled) {
            setObservation(result.usage);
            setLoading(false);
          }
        },
        () => {
          if (!cancelled) {
            setError('Usage is unavailable. Your running task has not been interrupted.');
            setLoading(false);
          }
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);
  return (
    <section className="usage-panel" aria-label="Subscription usage" aria-busy={loading}>
      <p className="usage-intro">Your Muse subscription allowance, without leaving your work.</p>
      {error && <p role="alert">{error}</p>}
      {!sessionId ? (
        <p>Select a connected session to read its Muse usage.</p>
      ) : observation ? (
        <div className="usage-windows">
          {(
            [
              ['Current window', observation.window],
              ['Weekly', observation.weekly],
            ] as const
          ).map(([label, allowance]) => (
            <article className="usage-window" key={label}>
              <div className="usage-window-heading">
                <h3>{label}</h3>
                <p className="usage-remaining">
                  <strong>{Math.max(0, 100 - allowance.usedPercent)}%</strong> available
                </p>
              </div>
              <p className="usage-used">
                {allowance.usedPercent}% used · {Math.max(0, 100 - allowance.usedPercent)}%
                remaining
              </p>
              <progress
                aria-label={`${label} used`}
                value={Math.min(100, allowance.usedPercent)}
                max={100}
              />
              <p className="usage-reset">
                Resets {new Date(allowance.resetsAtMs).toLocaleString()}
                {'windowDurationMins' in allowance && allowance.windowDurationMins
                  ? ` · ${allowance.windowDurationMins} minute window`
                  : ''}
              </p>
            </article>
          ))}
          <p className="usage-observed">
            Last reported {new Date(observation.observedAtMs).toLocaleString()}
          </p>
        </div>
      ) : (
        <p role="status">
          {loading
            ? 'Reading Muse usage…'
            : 'Muse has not reported subscription usage on this connection yet.'}
        </p>
      )}
      <div className="usage-actions">
        <button disabled={loading || !sessionId} onClick={() => setRevision((value) => value + 1)}>
          {loading ? 'Reading usage…' : 'Refresh usage'}
        </button>
        <span className="hint">No model request</span>
      </div>
      <details className="usage-details">
        <summary>About these numbers</summary>
        <p>
          Muse reports shared subscription windows, not a per-session allocation. Refresh reads its
          last observation and may return the same timestamp. API billing is managed by your
          provider.
        </p>
      </details>
    </section>
  );
}
