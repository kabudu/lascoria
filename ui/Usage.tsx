import { useEffect, useState } from 'react';
import { request } from './api';
import { allowanceFacts, readableDuration, USAGE_STALE_MS, usageWindow } from './model';

import type { SubscriptionUsage } from '@muse-code/sdk/dist/src/msp.js';

export interface UsageReading {
  usage: SubscriptionUsage | null;
  /** When Lascoria last received this observation from a Muse host. */
  receivedAtMs?: number;
}

const localTime = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Settings → Account & usage. Shows the freshest subscription observation Lascoria holds for
 * the current account, and refreshes it through a read-only Muse query on a connected session.
 * Nothing here sends a model request or touches a running task.
 */
export function Usage({
  sessionId,
  latestEnabled,
  mode,
  signedIn,
  indicator,
  setIndicator,
}: {
  /** A connected session whose Muse host can be asked for its latest observation. */
  sessionId?: string;
  /** The supervisor keeps an account-scoped observation (usage/latest). */
  latestEnabled: boolean;
  /** Account route: subscription allowance does not apply to API-key billing. */
  mode?: string;
  signedIn?: boolean;
  /** The optional toolbar figure, when the supervisor can serve it without asking Muse. */
  indicator?: boolean;
  setIndicator?: (on: boolean) => void;
}) {
  const [reading, setReading] = useState<UsageReading>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const apiKey = mode === 'apiKey';
  useEffect(() => {
    // Countdowns only; this timer never asks Muse for anything.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setError('');
    if (apiKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const accept = (value: UsageReading) => {
      if (cancelled) return;
      setReading(value);
      setNow(Date.now());
    };
    void (async () => {
      // Show what is already known straight away, then ask a connected host.
      if (latestEnabled) await request<UsageReading>('usage/latest').then(accept, () => {});
      if (sessionId)
        await request<UsageReading>('usage', { sessionId }).then(accept, () => {
          if (!cancelled)
            setError(
              'Muse could not be asked for new figures just now. Your running work has not been interrupted.',
            );
        });
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, latestEnabled, apiKey, revision]);
  const usage = reading?.usage;
  const stale = usage ? now - usage.observedAtMs > USAGE_STALE_MS : false;
  return (
    <section className="usage-panel" aria-label="Account and usage" aria-busy={loading}>
      <p className="usage-intro">Your Muse subscription allowance, without leaving your work.</p>
      {error && <p role="alert">{error}</p>}
      {apiKey ? (
        <p role="status">
          You are using an API key, so there is no subscription allowance to show. Your provider
          bills API use.
        </p>
      ) : usage ? (
        <div className="usage-windows">
          {(
            [
              ['Current window', usage.window],
              ['Weekly', usage.weekly],
            ] as const
          ).map(([label, allowance]) => {
            const facts = allowanceFacts(allowance, usage.observedAtMs, now);
            return (
              <article className="usage-window" key={label}>
                <div className="usage-window-heading">
                  <h3>{label}</h3>
                  <p className="usage-remaining">
                    {facts.reset ? (
                      <strong>Not known yet</strong>
                    ) : (
                      <>
                        <strong>{facts.remaining}%</strong> available
                      </>
                    )}
                  </p>
                </div>
                {facts.reset ? (
                  <p className="usage-used">
                    This window reset {localTime(allowance.resetsAtMs)}, after Muse last reported (
                    {facts.used}% used then). New figures appear after Muse next reports.
                  </p>
                ) : (
                  <>
                    <p className="usage-used">
                      {facts.used}% used · {facts.remaining}% remaining
                      {facts.overLimit ? ' · over the limit' : ''}
                    </p>
                    <progress
                      aria-label={`${label} used`}
                      value={Math.min(100, facts.used)}
                      max={100}
                    />
                    <p className="usage-reset">
                      Resets in {facts.resetsIn} ({localTime(allowance.resetsAtMs)})
                      {'windowDurationMins' in allowance && allowance.windowDurationMins
                        ? ` · ${usageWindow(allowance.windowDurationMins)}`
                        : ''}
                    </p>
                  </>
                )}
              </article>
            );
          })}
          <p className={`usage-observed ${stale ? 'stale' : ''}`} role={stale ? 'note' : undefined}>
            {stale ? 'May be out of date: ' : ''}Muse last reported these figures{' '}
            {readableDuration(Math.max(0, now - usage.observedAtMs))} ago (
            {localTime(usage.observedAtMs)}).
          </p>
        </div>
      ) : (
        <p role="status">
          {loading
            ? 'Reading Muse usage…'
            : signedIn === false
              ? 'Sign in to your Muse subscription to see your allowance.'
              : sessionId
                ? 'Muse has not reported subscription usage yet. It usually does after your next task.'
                : 'No usage reported yet. Open a session, or run a task, and Muse will report it.'}
        </p>
      )}
      {!apiKey && (
        <div className="usage-actions">
          <button
            disabled={loading || (!sessionId && !latestEnabled)}
            onClick={() => setRevision((value) => value + 1)}
          >
            {loading ? 'Reading usage…' : 'Refresh usage'}
          </button>
        </div>
      )}
      {!apiKey && setIndicator && (
        <label className="toggle-switch usage-indicator-setting">
          <input
            type="checkbox"
            role="switch"
            checked={Boolean(indicator)}
            onChange={(event) => setIndicator(event.currentTarget.checked)}
          />
          <span>Show the weekly allowance in the toolbar</span>
        </label>
      )}
      <details className="usage-details">
        <summary>About these numbers</summary>
        <p>
          Muse reports shared subscription windows for your account, not a separate allowance per
          session, so Lascoria shows the most recent report from any session. Refresh reads Muse's
          last observation and may return the same time. API billing is managed by your provider.
        </p>
        {usage?.tier && (
          <p>
            Plan identifier reported by the provider: <code>{usage.tier}</code>. Lascoria shows it
            as reported because there is no documented display name for it.
          </p>
        )}
      </details>
    </section>
  );
}
