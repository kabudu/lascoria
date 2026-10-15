import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
type Runtime = {
  ready?: boolean;
  running?: boolean;
  state?: string;
  phase?: string;
  path?: string;
  version?: string;
  bytes?: number;
  total?: number;
  message?: string;
  lastInstall?: Runtime;
};
export function MuseSetup({ onReady }: { onReady: (ready: boolean) => void }) {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [later, setLater] = useState(false);
  async function check() {
    const result = await invoke<Runtime>('runtime_status');
    setRuntime(result);
    onReady(Boolean(result.ready));
  }
  useEffect(() => {
    void check().catch(() =>
      setError('Muse setup could not be checked. Retry before starting work.'),
    );
  }, []);
  useEffect(() => {
    if (!runtime?.running) return;
    const timer = setTimeout(() => {
      void check().catch(() => setError('Installation status is unavailable. Retry to check it.'));
    }, 750);
    return () => clearTimeout(timer);
  }, [runtime]);
  async function action(command: string, args = {}) {
    setError('');
    setBusy(true);
    try {
      const result = await invoke<Runtime>(command, args);
      setRuntime(result);
      onReady(Boolean(result?.ready));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!runtime)
    return (
      <section className="runtime-setup" aria-label="Muse setup" aria-busy={!error}>
        <p role="status">{error || 'Checking your Muse runtime…'}</p>
        {error && (
          <button disabled={busy} onClick={() => void action('runtime_status')}>
            Retry runtime check
          </button>
        )}
      </section>
    );
  if (runtime?.ready)
    return (
      <details className="runtime-ready">
        <summary>Muse {runtime.version} · ready</summary>
        <p className="hint">
          Compatible native runtime verified. Muse is separate from your account and Lascoria
          updates.
        </p>
        <code>{runtime.path}</code>
      </details>
    );
  if (later)
    return (
      <div className="account-choice">
        <p>Offline inspection is available. Install or select Muse before running agents.</p>
        <button onClick={() => setLater(false)}>Set up Muse</button>
      </div>
    );
  const running = runtime?.running;
  return (
    <section className="runtime-setup" aria-label="Muse setup">
      <span className="eyebrow">Before your first agent</span>
      <h3>
        {running
          ? 'Setting up Muse Code'
          : runtime?.state === 'incompatible'
            ? 'Muse needs a compatible version'
            : 'Connect the Muse runtime'}
      </h3>
      <p>
        {runtime?.message ??
          'Lascoria uses Muse Code to run agents. We can install a verified compatible copy privately, without replacing your existing CLI.'}
      </p>
      {running ? (
        <>
          <p role="status">
            {runtime.phase === 'verifying'
              ? 'Verifying compatibility…'
              : runtime.phase === 'connecting'
                ? 'Connecting to Meta…'
                : `Downloading Muse · ${Math.round((runtime.bytes ?? 0) / 1048576)} / ${Math.round((runtime.total ?? 0) / 1048576)} MB`}
          </p>
          <progress
            aria-label="Muse installation"
            value={runtime.total ? runtime.bytes : undefined}
            max={runtime.total ?? 1}
          />
          <button
            onClick={() =>
              void invoke('runtime_cancel').catch(() =>
                setError('Could not cancel. Retry checking installation status.'),
              )
            }
          >
            Cancel installation
          </button>
        </>
      ) : (
        <>
          {runtime?.lastInstall?.message && <p role="status">{runtime.lastInstall.message}</p>}
          <div className="account-actions">
            <button className="primary" disabled={busy} onClick={() => setConfirm(true)}>
              Install Muse
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void check().catch(() =>
                  setError('Muse check failed. Check your connection and retry.'),
                )
              }
            >
              Retry
            </button>
            <button disabled={busy} onClick={() => setLater(true)}>
              Later
            </button>
          </div>
          {confirm && (
            <div className="account-confirm runtime-confirm" aria-label="Confirm Muse installation">
              <p>
                Download Muse 1.4.9 from Meta, verify its checksum and protocol, and install it in
                Lascoria’s private runtime directory. The download is approximately 350–500 MB.
                Existing installations will not be replaced. No model request or paid trial is sent.
              </p>
              <div className="account-actions">
                <button onClick={() => setConfirm(false)}>Cancel</button>
                <button
                  className="primary"
                  onClick={() => {
                    setConfirm(false);
                    void action('runtime_install');
                  }}
                >
                  Download and install Muse
                </button>
              </div>
            </div>
          )}
          <details>
            <summary>Choose an existing installation</summary>
            <label htmlFor="muse-path">Absolute Muse executable path</label>
            <input
              id="muse-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="Path to the native Muse executable"
            />
            <button
              disabled={busy || !path.trim()}
              onClick={() => void action('runtime_select', { path })}
            >
              Verify and use installation
            </button>
          </details>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
