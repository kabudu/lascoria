import { useEffect, useRef, useState, type ReactNode } from 'react';
import { request } from './api';
import { allowanceFacts, USAGE_STALE_MS } from './model';
import type { UsageReading } from './Usage';

/** Account-scoped cached readings only: opening this never starts or interrupts Muse. */
export function UsageShortcut({
  enabled,
  subscription,
  accountKey,
  manage,
  fallback,
}: {
  enabled: boolean;
  subscription: boolean;
  accountKey: string;
  manage: () => void;
  fallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [reading, setReading] = useState<UsageReading>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setReading(undefined);
    setOpen(false);
  }, [accountKey]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    root.current?.addEventListener('keydown', escape);
    const element = root.current;
    return () => {
      document.removeEventListener('pointerdown', outside);
      element?.removeEventListener('keydown', escape);
    };
  }, [open]);
  useEffect(() => {
    if (!open || !enabled || !subscription) return;
    let disposed = false;
    let pending = false;
    const read = async () => {
      if (pending || document.hidden) return;
      pending = true;
      setLoading(true);
      try {
        const next = await request<UsageReading>('usage/latest');
        if (!disposed) {
          setReading(next);
          setError(false);
        }
      } catch {
        if (!disposed) setError(true);
      } finally {
        pending = false;
        if (!disposed) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 60_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [open, enabled, subscription, accountKey]);
  const now = Date.now();
  const usage = reading?.usage;
  return (
    <div
      className="usage-shortcut"
      ref={root}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node))
          setOpen(false);
      }}
    >
      <button
        ref={button}
        className="usage-shortcut-button"
        aria-label="Subscription usage"
        title="Subscription usage"
        aria-expanded={open}
        aria-controls="subscription-usage-popover"
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M12 5.5a6.5 6.5 0 0 1 6.5 6.5"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path d="m9 12 3-3 3 3-3 3z" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          ref={panel}
          tabIndex={-1}
          id="subscription-usage-popover"
          className="usage-popover"
          role="dialog"
          aria-label="Subscription usage"
        >
          <h2 className="visually-hidden">Subscription usage</h2>
          {!enabled ? (
            fallback
          ) : (
            <>
              <p className="usage-popover-source">Usage source: Muse subscription</p>
              {!subscription ? (
                <p>Sign in to your Muse subscription to see your allowance.</p>
              ) : usage ? (
                <>
                  {(
                    [
                      ['Current window', usage.window],
                      ['Weekly limit', usage.weekly],
                    ] as const
                  ).map(([label, window]) => {
                    const facts = allowanceFacts(window, usage.observedAtMs, now);
                    return (
                      <div className="usage-popover-row" key={label}>
                        <span>{label}</span>
                        <strong>
                          {facts.reset ? 'Awaiting update' : `${facts.remaining}% left`}
                        </strong>
                      </div>
                    );
                  })}
                  <p className="hint">
                    {now - usage.observedAtMs > USAGE_STALE_MS ? 'May be out of date. ' : ''}Last
                    reported {new Date(usage.observedAtMs).toLocaleString()}.
                  </p>
                </>
              ) : (
                <p role="status">
                  {loading
                    ? 'Reading usage…'
                    : error
                      ? 'Usage could not be read. Try again in Account & usage.'
                      : 'Muse has not reported usage yet. Figures appear after Muse reports from a session.'}
                </p>
              )}
              {error && usage && (
                <p role="status">Could not refresh. Showing the last reported figures.</p>
              )}
              <button
                className="usage-popover-manage"
                onClick={() => {
                  setOpen(false);
                  button.current?.focus();
                  manage();
                }}
              >
                Account &amp; usage <span aria-hidden="true">›</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
