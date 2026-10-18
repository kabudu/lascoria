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

const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Settings → Updates (R3). Check, download with progress, then install and restart, each an
 * explicit step. Installing never interrupts running work by surprise: on Windows it pauses
 * work first with the user's agreement; elsewhere running work continues in the background
 * and the background service restarts once it is idle.
 */
export function UpdateSettings({
  prefs,
  update,
  workRunning,
  pauseWork,
}: {
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
  const reload = () => invoke<UpdateStatus>('update_status').then(setStatus, () => {});
  useEffect(() => {
    void reload();
    let unlisten: (() => void) | undefined;
    void listen('update-progress', () => void reload())
      .then((stop) => (unlisten = stop))
      .catch(() => {});
    return () => unlisten?.();
  }, []);
  const failure = (e: unknown) => String(e).replace(/^Error: /, '');
  async function check() {
    setBusy(true);
    setError('');
    try {
      setStatus({ ...(status as UpdateStatus), ...(await invoke('update_check', { channel })) });
      update({ updates: { ...settings, lastCheckedAtMs: Date.now() } });
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
      void reload();
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
  if (!status) return <p role="status">Reading update status…</p>;
  const progress = status.progress;
  return (
    <section className="settings-group" aria-label="Update settings" aria-busy={busy}>
      <p>
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
          {error && <p role="alert">{error}</p>}
          {status.available ? (
            <article className="update-available" aria-label="Available update">
              <h4>Lascoria {status.available.version} is available</h4>
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
                  <button onClick={() => void invoke('update_cancel').then(reload)}>
                    Cancel download
                  </button>
                )}
                {status.downloaded && !confirming && (
                  <>
                    <button className="primary" onClick={() => setConfirming(true)}>
                      Install and restart…
                    </button>
                    <button onClick={() => void invoke('update_cancel').then(reload)}>Later</button>
                  </>
                )}
              </div>
              {status.downloaded && confirming && (
                <div className="update-confirm" role="group" aria-label="Confirm installation">
                  <p>
                    {status.installStopsWork
                      ? workRunning
                        ? 'Installing on this computer pauses running work first: tasks stop at a checkpoint and can be resumed after the restart.'
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
            status.lastCheckedAtMs && !error && <p role="status">Lascoria is up to date.</p>
          )}
          <div className="settings-actions">
            <button disabled={busy || status.downloading} onClick={() => void check()}>
              {busy ? 'Checking…' : 'Check for updates'}
            </button>
            <span className="hint">Contacts GitHub only; no model request.</span>
          </div>
          <fieldset>
            <legend>Checking</legend>
            <label className="settings-choice">
              <input
                type="checkbox"
                checked={settings.automatic !== false}
                onChange={(event) =>
                  update({ updates: { ...settings, automatic: event.currentTarget.checked } })
                }
              />
              Check automatically once a day (updates are never installed without you)
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
                  onChange={() => update({ updates: { ...settings, channel: value } })}
                />
                {label}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </section>
  );
}
