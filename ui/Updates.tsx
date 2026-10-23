import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Prefs } from './types';

export interface UpdateStatus {
  configured: boolean;
  currentVersion: string;
  installStopsWork: boolean;
  available: { version: string; date?: number | null; notes?: string | null } | null;
  downloaded: boolean;
  downloading: boolean;
  progress: { received: number; total?: number | null } | null;
  lastCheckedAtMs?: number | null;
  lastError?: string | null;
}

// The timer and native menu may ask together. Share one bounded native check per channel.
let pendingCheck: { channel: string; result: Promise<Partial<UpdateStatus>> } | undefined;
export function checkForUpdates(channel: string) {
  if (pendingCheck?.channel === channel) return pendingCheck.result;
  const result = invoke<Partial<UpdateStatus>>('update_check', { channel });
  const pending = { channel, result };
  pendingCheck = pending;
  void result
    .finally(() => {
      if (pendingCheck === pending) pendingCheck = undefined;
    })
    .catch(() => {});
  return result;
}

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Settings → Updates (R3). Check, download with progress, then install and restart, each an
 * explicit step. Full-runtime installation pauses work with the user's agreement and
 * waits for the background writer to stop before replacing any installed resources.
 */
export function UpdateSettings({
  prefs,
  update,
  workRunning,
  pauseWork,
  onStatus,
  checkRequest = 0,
  compact = false,
}: {
  onStatus?: (status: UpdateStatus) => void;
  checkRequest?: number;
  compact?: boolean;
  prefs: Prefs;
  update: (patch: Partial<Prefs>) => void;
  /** Tasks are running or waiting for an answer. */
  workRunning: boolean;
  /** Pauses work and stops the background service, resolving once it has stopped. */
  pauseWork: () => Promise<void>;
}) {
  const [status, setStatus] = useState<UpdateStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const settings = prefs.updates ?? {};
  const channel = settings.channel ?? 'stable';
  const receive = (next: UpdateStatus) => {
    setStatus(next);
    onStatus?.(next);
  };
  const reload = () =>
    invoke<UpdateStatus>('update_status').then(receive, (error) =>
      setError(String(error).replace(/^Error: /, '')),
    );
  useEffect(() => {
    void reload();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const release = (stop: () => void) => void Promise.resolve(stop()).catch(() => {});
    void listen('update-progress', () => {
      if (!disposed) void reload();
    })
      .then((stop) => {
        if (disposed) release(stop);
        else unlisten = stop;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) release(unlisten);
    };
  }, []);
  useEffect(() => {
    if (checkRequest) void check();
  }, [checkRequest]);
  const failure = (e: unknown) => String(e).replace(/^Error: /, '');
  async function check() {
    setBusy(true);
    setError('');
    try {
      await checkForUpdates(channel);
      update({ updates: { ...settings, lastCheckedAtMs: Date.now() } });
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
      void reload();
    }
  }
  async function changeChannel(next: 'stable' | 'beta') {
    setBusy(true);
    setError('');
    update({ updates: { ...settings, channel: next, lastCheckedAtMs: undefined } });
    try {
      await invoke('update_cancel', { clearAvailable: true });
      setConfirming(false);
      await reload();
    } catch (e) {
      update({ updates: settings });
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }
  async function install() {
    setBusy(true);
    setError('');
    try {
      if (status?.installStopsWork) await pauseWork();
      await invoke('update_install');
    } catch (e) {
      setError(failure(e));
      setBusy(false);
    }
  }
  if (!status)
    return error ? (
      <div role="alert">
        <p>Could not read update status. {error}</p>
        <button onClick={() => void reload()}>Try again</button>
      </div>
    ) : (
      <p role="status">Reading update status…</p>
    );
  const AvailableHeading = compact ? 'h3' : 'h4';
  const progress = status.progress;
  const visibleError = error || status.lastError;
  return (
    <section
      className="settings-group update-content"
      aria-label="Update settings"
      aria-busy={busy}
    >
      <p className="update-version">
        You have Lascoria <strong>{status.currentVersion}</strong>.
        {status.lastCheckedAtMs
          ? ` Last checked ${new Date(status.lastCheckedAtMs).toLocaleString()}.`
          : settings.lastCheckedAtMs
            ? ` Last checked ${new Date(settings.lastCheckedAtMs).toLocaleString()}.`
            : ''}
      </p>
      {!status.configured ? (
        <p role="status">
          This build of Lascoria was not set up for in-app updates (development and test builds are
          not). Install releases from the Lascoria releases page instead.
        </p>
      ) : (
        <>
          {visibleError && <p role="alert">{visibleError}</p>}
          {status.available ? (
            <article className="update-available" aria-label="Available update">
              <AvailableHeading>Lascoria {status.available.version} is available</AvailableHeading>
              {status.available.date && (
                <p className="hint">
                  Released {new Date(status.available.date).toLocaleDateString()}
                </p>
              )}
              {status.available.notes && (
                <details>
                  <summary>What&apos;s new</summary>
                  <p className="update-notes">{status.available.notes}</p>
                </details>
              )}
              {status.downloading && progress && (
                <>
                  <progress
                    aria-label="Download progress"
                    value={progress.received}
                    max={progress.total ?? undefined}
                  />
                  <p className="hint">
                    {size(progress.received)}
                    {progress.total ? ` of ${size(progress.total)}` : ''} downloaded
                  </p>
                </>
              )}
              <div className="settings-actions">
                {!status.downloaded && !status.downloading && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={async () => {
                      setError('');
                      try {
                        await invoke('update_download');
                      } catch (e) {
                        setError(failure(e));
                      }
                      void reload();
                    }}
                  >
                    Download
                  </button>
                )}
                {status.downloading && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void invoke('update_cancel')
                        .catch((e) => setError(failure(e)))
                        .finally(() => void reload())
                    }
                  >
                    Cancel download
                  </button>
                )}
                {status.downloaded && !confirming && (
                  <>
                    <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
                      Install and restart…
                    </button>
                  </>
                )}
              </div>
              {status.downloaded && confirming && (
                <div className="update-confirm" role="group" aria-label="Confirm installation">
                  <p>
                    {status.installStopsWork
                      ? workRunning
                        ? 'Installing pauses running work first. Lascoria saves progress and stops its background service before updating. You can continue the same sessions after restart; interrupted commands are never automatically replayed.'
                        : 'Lascoria will close, install the update and reopen. Nothing is running.'
                      : workRunning
                        ? 'Lascoria will restart with the new version. Running work keeps going in the background; the background service moves to the new version once it is idle.'
                        : 'Lascoria will restart with the new version.'}
                  </p>
                  <button className="primary" disabled={busy} onClick={() => void install()}>
                    {status.installStopsWork && workRunning
                      ? 'Pause work, install and restart'
                      : 'Install and restart'}
                  </button>
                  <button disabled={busy} onClick={() => setConfirming(false)}>
                    Not now
                  </button>
                </div>
              )}
            </article>
          ) : (
            status.lastCheckedAtMs &&
            !busy &&
            !visibleError && <p role="status">Lascoria is up to date.</p>
          )}
          <div className="settings-actions">
            <button disabled={busy || status.downloading} onClick={() => void check()}>
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
          </div>
          {!compact && (
            <>
              <fieldset>
                <legend>Checking</legend>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={settings.automatic !== false}
                    onChange={(event) =>
                      update({ updates: { ...settings, automatic: event.currentTarget.checked } })
                    }
                  />
                  <span>Check every 6 hours. You choose when to install.</span>
                </label>
              </fieldset>
              <fieldset>
                <legend>Release channel</legend>
                {(
                  [
                    ['stable', 'Stable releases'],
                    ['beta', 'Beta releases: earlier access, less tested'],
                  ] as const
                ).map(([value, label]) => (
                  <label key={value} className="settings-choice">
                    <input
                      type="radio"
                      name="update-channel"
                      checked={channel === value}
                      disabled={busy}
                      onChange={() => void changeChannel(value)}
                    />
                    {label}
                  </label>
                ))}
              </fieldset>
            </>
          )}
        </>
      )}
    </section>
  );
}
