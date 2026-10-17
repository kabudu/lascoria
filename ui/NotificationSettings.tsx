import { useState } from 'react';
import type { NotificationPrefs, SessionRow } from './types';

type Props = {
  settings?: NotificationPrefs;
  sessions: SessionRow[];
  name: (row: SessionRow) => string;
  update: (next: NotificationPrefs) => void;
  test: () => Promise<void>;
  lastError?: string;
};

const groups: { key: 'needsInput' | 'problems' | 'finished'; label: string }[] = [
  { key: 'needsInput', label: 'Muse asks a question or needs permission' },
  { key: 'problems', label: 'A task does not finish or a session stops unexpectedly' },
  { key: 'finished', label: 'A task finishes' },
];

export function NotificationSettings({ settings, sessions, name, update, test, lastError }: Props) {
  const current: NotificationPrefs = settings ?? { enabled: false };
  const [check, setCheck] = useState<{ pending: boolean; message?: string; failed?: boolean }>({
    pending: false,
  });
  const muted = new Set(current.mutedSessions ?? []);
  const open = sessions.filter((row) => row.lifecycle !== 'archived');
  return (
    <section className="notification-settings" aria-label="Desktop notifications">
      <p>
        Lascoria can tell you when a session needs you while its window is in the background or
        minimised. Notifications appear only while Lascoria is open: after you close it and keep
        work running, check back in Lascoria.
      </p>
      <label className="setting-toggle">
        <input
          type="checkbox"
          checked={current.enabled}
          onChange={(event) => update({ ...current, enabled: event.target.checked })}
        />
        Show desktop notifications
      </label>
      <fieldset disabled={!current.enabled}>
        <legend>Notify me when</legend>
        {groups.map((group) => (
          <label key={group.key}>
            <input
              type="checkbox"
              checked={current[group.key] !== false}
              onChange={(event) => update({ ...current, [group.key]: event.target.checked })}
            />
            {group.label}
          </label>
        ))}
      </fieldset>
      <fieldset disabled={!current.enabled}>
        <legend>Sessions</legend>
        {!open.length && <p className="muted">No open sessions.</p>}
        {open.map((row) => (
          <label key={row.id}>
            <input
              type="checkbox"
              checked={!muted.has(row.id)}
              onChange={(event) => {
                const next = new Set(muted);
                if (event.target.checked) next.delete(row.id);
                else next.add(row.id);
                // Keep only sessions that still exist, so the list cannot grow without bound.
                const known = new Set(sessions.map((s) => s.id));
                update({ ...current, mutedSessions: [...next].filter((id) => known.has(id)) });
              }}
            />
            {name(row)}
          </label>
        ))}
      </fieldset>
      <p className="setting-help">
        Notifications show the kind of update and the session name, never your task text. Your
        system may also show them on the lock screen. Nothing is sent while a Lascoria window is in
        front of you.
      </p>
      <div className="notification-check">
        <button
          disabled={check.pending}
          onClick={() => {
            setCheck({ pending: true });
            void test()
              .then(() =>
                setCheck({
                  pending: false,
                  message:
                    'Test sent. If nothing appeared, allow Lascoria in your system notification settings.',
                }),
              )
              .catch((error) => setCheck({ pending: false, failed: true, message: String(error) }));
          }}
        >
          {check.pending ? 'Sending…' : 'Send a test notification'}
        </button>
        <p role="status" className={check.failed ? 'error' : 'muted'}>
          {check.message ?? ''}
        </p>
      </div>
      {lastError && <p className="error">The last notification could not be shown: {lastError}</p>}
    </section>
  );
}
