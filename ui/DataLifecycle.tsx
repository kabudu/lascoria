import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { request } from './api';

type Backup = {
  id: string;
  createdAtMillis: number;
  reason: string;
  sessions: number;
  bytes: number;
  schema: number;
};
type Archived = {
  sessionId: string;
  name?: string | null;
  archivedAtMillis?: number | null;
  workspace?: string | null;
  retainedWorktree?: string | null;
  hasLocalMessages: boolean;
};
type Summary = {
  sessions: number;
  archivedSessions: number;
  sessionLimit: number;
  journalEntries: number;
  journalLimit: number;
  compactableEntries: number;
  databaseBytes: number;
  archived: Archived[];
  backups: Backup[];
  pendingRestore?: { backupId: string; stagedAtMillis: number } | null;
  lastRestore?: {
    status: 'restored' | 'failed';
    backupId: string;
    error?: string;
    atMillis: number;
  } | null;
};
type Pending =
  | { kind: 'remove'; sessions: string[] }
  | { kind: 'restore'; backup: Backup }
  | { kind: 'compact' };

const reasons: Record<string, string> = {
  manual: 'Backup',
  imported: 'Imported',
  beforeRestore: 'Automatic, before restore',
  beforeCleanup: 'Automatic, before cleanup',
  beforeCompact: 'Automatic, before compacting',
};
const size = (bytes: number) =>
  bytes < 1_000_000
    ? `${Math.max(1, Math.round(bytes / 1000))} KB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`;
const when = (millis?: number | null) => (millis ? new Date(millis).toLocaleString() : 'unknown');
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

export function DataLifecycle({
  refreshStatus,
  quit,
}: {
  refreshStatus: () => Promise<unknown> | void;
  quit: () => void;
}) {
  const [summary, setSummary] = useState<Summary>();
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<Pending>();
  // A retry after a lost reply reuses its identity; the supervisor returns the original result.
  const attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const identity = (key: string) => {
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    return attempt.current.id;
  };
  const load = async () => {
    try {
      setSummary(await request<Summary>('data/summary'));
    } catch (failure) {
      setError(`Local data details are unavailable: ${String(failure)}`);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const run = async (label: string, key: string, action: (id: string) => Promise<string>) => {
    setBusy(label);
    setError('');
    setMessage('');
    try {
      setMessage(await action(identity(key)));
      attempt.current = undefined;
      setPending(undefined);
      await load();
    } catch (failure) {
      setError(
        `${String(failure)}. Your data is unchanged unless the details below say otherwise; retrying is safe.`,
      );
    } finally {
      setBusy('');
    }
  };
  if (!summary)
    return (
      <section className="data-panel" aria-label="Data and backups" aria-busy={!error}>
        {error ? <p role="alert">{error}</p> : <p role="status">Reading local data…</p>}
      </section>
    );
  const removable = summary.archived.filter((row) => !row.hasLocalMessages);
  const nearLimit =
    summary.sessions >= summary.sessionLimit - 5 ||
    summary.journalEntries >= summary.journalLimit - 100;
  return (
    <section className="data-panel" aria-label="Data and backups" aria-busy={Boolean(busy)}>
      <p className="data-intro">
        Lascoria keeps sessions, transcripts, drafts and saved changes on this computer. Backups
        stay private to your account. Account sign-in and API keys are never included.
      </p>
      {summary.pendingRestore && (
        <div className="data-notice" role="status">
          <p>
            <strong>Restore ready.</strong> The backup from{' '}
            {when(
              summary.backups.find((b) => b.id === summary.pendingRestore!.backupId)
                ?.createdAtMillis,
            )}{' '}
            replaces current data the next time Lascoria starts. Current data is backed up first.
          </p>
          <div className="data-actions">
            <button onClick={quit}>Quit Lascoria to restore</button>
            <button
              className="quiet"
              disabled={Boolean(busy)}
              onClick={() =>
                run('Cancelling restore…', 'cancel', async () => {
                  await request('data/cancelRestore');
                  return 'Restore cancelled. Nothing was changed.';
                })
              }
            >
              Cancel restore
            </button>
          </div>
        </div>
      )}
      {summary.lastRestore && (
        <p className={summary.lastRestore.status === 'failed' ? 'data-error' : 'muted'}>
          {summary.lastRestore.status === 'restored'
            ? `Last restore completed ${when(summary.lastRestore.atMillis)}.`
            : `The restore on ${when(summary.lastRestore.atMillis)} was not applied: ${summary.lastRestore.error}. Your data was kept.`}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}

      <h3>Storage</h3>
      <dl className="data-usage">
        <div>
          <dt>Sessions kept</dt>
          <dd>
            {summary.sessions} of {summary.sessionLimit}
            {summary.archivedSessions ? ` · ${summary.archivedSessions} archived` : ''}
          </dd>
        </div>
        <div>
          <dt>Command history</dt>
          <dd>
            {summary.journalEntries.toLocaleString()} of {summary.journalLimit.toLocaleString()}{' '}
            entries
          </dd>
        </div>
        <div>
          <dt>Local data</dt>
          <dd>{size(summary.databaseBytes)}</dd>
        </div>
      </dl>
      {nearLimit && (
        <p className="data-notice" role="status">
          Lascoria is close to its storage limits. New sessions or tasks stop being accepted when a
          limit is reached. Remove archived sessions or compact older history below.
        </p>
      )}

      <h3>Backups</h3>
      <div className="data-actions">
        <button
          disabled={Boolean(busy)}
          onClick={() =>
            run('Backing up…', 'backup', async (id) => {
              await request('data/backup', {}, id);
              return 'Backup saved.';
            })
          }
        >
          {busy === 'Backing up…' ? busy : 'Back up now'}
        </button>
        <button
          className="quiet"
          disabled={Boolean(busy)}
          onClick={async () => {
            setError('');
            let path: string | null;
            try {
              path = await invoke<string | null>('pick_backup_file');
            } catch (failure) {
              setError(String(failure));
              return;
            }
            if (path)
              void run('Importing…', `import:${path}`, async (id) => {
                await request('data/import', { path }, id);
                return 'Backup imported. Choose Restore to use it.';
              });
          }}
        >
          Import backup…
        </button>
      </div>
      {summary.backups.length === 0 ? (
        <p className="muted">No backups yet.</p>
      ) : (
        <ul className="data-list" aria-label="Backups">
          {summary.backups.map((backup) => (
            <li key={backup.id}>
              <div>
                <strong>{when(backup.createdAtMillis)}</strong>
                <span className="muted">
                  {reasons[backup.reason] ?? 'Backup'} · {plural(backup.sessions, 'session')} ·{' '}
                  {size(backup.bytes)}
                </span>
              </div>
              <div className="data-row-actions">
                <button
                  className="quiet"
                  disabled={Boolean(busy)}
                  aria-label={`Export backup from ${when(backup.createdAtMillis)}`}
                  onClick={async () => {
                    setError('');
                    let path: string | null;
                    try {
                      path = await invoke<string | null>('pick_backup_destination', {
                        suggested: `lascoria-backup-${stamp()}.sqlite`,
                      });
                    } catch (failure) {
                      setError(String(failure));
                      return;
                    }
                    if (path)
                      void run('Exporting…', `export:${backup.id}:${path}`, async () => {
                        await request('data/export', { backupId: backup.id, path });
                        return `Exported to ${path}. It contains your transcripts; store it privately.`;
                      });
                  }}
                >
                  Export…
                </button>
                <button
                  className="quiet"
                  disabled={Boolean(busy) || Boolean(summary.pendingRestore)}
                  aria-label={`Restore backup from ${when(backup.createdAtMillis)}`}
                  onClick={() => setPending({ kind: 'restore', backup })}
                >
                  Restore…
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3>Clean up</h3>
      {summary.archived.length === 0 ? (
        <p className="muted">No archived sessions.</p>
      ) : (
        <fieldset className="data-archived">
          <legend>Archived sessions</legend>
          {summary.archived.map((row) => (
            <label key={row.sessionId} className={row.hasLocalMessages ? 'muted' : undefined}>
              <input
                type="checkbox"
                disabled={row.hasLocalMessages || Boolean(busy)}
                checked={selected.includes(row.sessionId)}
                onChange={(event) =>
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, row.sessionId]
                      : current.filter((id) => id !== row.sessionId),
                  )
                }
              />
              <span>
                {row.name || 'Unnamed session'} <small>· {row.sessionId.slice(-8)}</small>
                <small className="muted">
                  {' '}
                  Archived {when(row.archivedAtMillis)}
                  {row.hasLocalMessages ? ' · Kept: has local messages' : ''}
                </small>
              </span>
            </label>
          ))}
          <div className="data-actions">
            <button
              disabled={!selected.length || Boolean(busy)}
              onClick={() => setPending({ kind: 'remove', sessions: selected })}
            >
              Remove selected…
            </button>
            {removable.length > 0 && selected.length < removable.length && (
              <button
                className="quiet"
                disabled={Boolean(busy)}
                onClick={() => setSelected(removable.map((row) => row.sessionId))}
              >
                Select all removable
              </button>
            )}
          </div>
        </fieldset>
      )}
      <div className="data-actions">
        <button
          className="quiet"
          disabled={!summary.compactableEntries || Boolean(busy)}
          onClick={() => setPending({ kind: 'compact' })}
        >
          Compact older history
        </button>
        <span className="hint">
          {summary.compactableEntries
            ? `${plural(summary.compactableEntries, 'finished entry', 'finished entries')} older than 7 days`
            : 'Nothing older than 7 days to compact'}
        </span>
      </div>

      {pending && (
        <div className="data-confirm" role="alertdialog" aria-labelledby="data-confirm-title">
          {pending.kind === 'remove' && (
            <>
              <h4 id="data-confirm-title">
                Remove {plural(pending.sessions.length, 'archived session')}?
              </h4>
              <p>
                Their transcripts, saved changes and drafts are removed from Lascoria. A backup is
                made first, so you can restore them. Task folders on disk are not deleted.
              </p>
              <div className="data-actions">
                <button
                  className="danger"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    run('Removing…', `remove:${pending.sessions.join(',')}`, async (id) => {
                      const receipt = await request<{
                        retainedWorktrees: { path: string }[];
                      }>('data/removeArchived', { sessionIds: pending.sessions }, id);
                      setSelected([]);
                      await refreshStatus();
                      const kept = receipt.retainedWorktrees.map((w) => w.path);
                      return `Removed ${plural(pending.sessions.length, 'session')}.${
                        kept.length ? ` Task folders kept on disk: ${kept.join(', ')}.` : ''
                      }`;
                    })
                  }
                >
                  {busy || 'Remove sessions'}
                </button>
                <button
                  className="quiet"
                  disabled={Boolean(busy)}
                  onClick={() => setPending(undefined)}
                >
                  Keep sessions
                </button>
              </div>
            </>
          )}
          {pending.kind === 'restore' && (
            <>
              <h4 id="data-confirm-title">
                Restore the backup from {when(pending.backup.createdAtMillis)}?
              </h4>
              <p>
                When Lascoria next starts, current sessions, transcripts and drafts are replaced by
                this backup. Current data is backed up first. Your Muse sign-in and billing choice
                stay as they are now. Work started after the backup is not repeated.
              </p>
              <div className="data-actions">
                <button
                  disabled={Boolean(busy)}
                  onClick={() =>
                    run('Preparing restore…', `restore:${pending.backup.id}`, async () => {
                      await request('data/restore', { backupId: pending.backup.id });
                      return 'Restore prepared. Quit Lascoria to apply it.';
                    })
                  }
                >
                  {busy || 'Prepare restore'}
                </button>
                <button
                  className="quiet"
                  disabled={Boolean(busy)}
                  onClick={() => setPending(undefined)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
          {pending.kind === 'compact' && (
            <>
              <h4 id="data-confirm-title">Compact older command history?</h4>
              <p>
                Finished entries older than 7 days keep only their identity and outcome, so they are
                never repeated. Test output, local message deliveries and uncertain entries are kept
                in full. A backup is made first.
              </p>
              <div className="data-actions">
                <button
                  disabled={Boolean(busy)}
                  onClick={() =>
                    run('Compacting…', 'compact', async (id) => {
                      const receipt = await request<{ compacted: number }>('data/compact', {}, id);
                      return `Compacted ${plural(receipt.compacted, 'entry', 'entries')}.`;
                    })
                  }
                >
                  {busy || 'Compact history'}
                </button>
                <button
                  className="quiet"
                  disabled={Boolean(busy)}
                  onClick={() => setPending(undefined)}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <details className="usage-details">
        <summary>About local data</summary>
        <p>
          Lascoria keeps the 10 most recent backups. Restoring an older backup cannot resume work
          that happened after it: sessions reconnect to Muse, and anything uncertain is shown for
          review rather than repeated. Backups from a newer Lascoria version are refused.
        </p>
      </details>
    </section>
  );
}
