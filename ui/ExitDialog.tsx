import { useState } from 'react';
import type { SessionRow } from './types';

export type ExitChoice = 'keepRunning' | 'pause' | 'signOut';
type Account = { managed?: boolean; authenticated?: boolean; mode?: string } | undefined;

/** One contextual exit flow. Each choice states what keeps running and what needs sign-in. */
export function ExitDialog({
  sessions,
  account,
  name,
  closeBehavior,
  busy,
  onExit,
  onCancel,
}: {
  sessions: SessionRow[];
  account: Account;
  name: (session: SessionRow) => string;
  closeBehavior?: 'keepRunning' | 'pause';
  busy: boolean;
  onExit: (choice: ExitChoice, remember: boolean) => void;
  onCancel: () => void;
}) {
  const live = sessions.filter((s) => s.lifecycle !== 'archived');
  const active = live.filter(
    (s) =>
      s.state.activeTurnId ||
      (s.state.approvals?.length ?? 0) > 0 ||
      (s.state.userInputs?.length ?? 0) > 0,
  );
  const notResumable = active.filter((s) => s.durability !== 'durable');
  const signedIn = Boolean(account?.managed && account.authenticated);
  const [choice, setChoice] = useState<ExitChoice>(
    closeBehavior ?? (active.length ? 'keepRunning' : 'pause'),
  );
  const [remember, setRemember] = useState(false);
  const options: { value: ExitChoice; title: string; detail: string; hidden?: boolean }[] = [
    {
      value: 'keepRunning',
      title: 'Close Lascoria and keep work running',
      detail: active.length
        ? `${active.length === 1 ? '1 session keeps' : `${active.length} sessions keep`} working with your current sign-in. Reopen Lascoria to review progress and answer questions.`
        : 'Sessions stay ready in the background with your current sign-in.',
    },
    {
      value: 'pause',
      title: 'Pause work and quit',
      detail:
        'Running tasks stop. Saved sessions reconnect when you reopen Lascoria; anything uncertain is shown for review, never repeated. You stay signed in.',
    },
    {
      value: 'signOut',
      title: 'Sign out of Muse and quit',
      detail:
        'Running tasks are cancelled, because they cannot continue without your sign-in. Conversations and task folders are kept for when you sign in again. A saved API key stays in your system credential store but is not used.',
      hidden: !signedIn,
    },
  ];
  return (
    <section className="exit-dialog" aria-label="Log out options">
      <p>
        {live.length === 0
          ? 'No sessions are open.'
          : active.length
            ? `${active.length} of ${live.length} ${live.length === 1 ? 'session is' : 'sessions are'} working or waiting for you.`
            : `${live.length} ${live.length === 1 ? 'session is' : 'sessions are'} idle.`}
      </p>
      {active.length > 0 && (
        <ul className="exit-sessions">
          {active.map((s) => (
            <li key={s.id}>
              {name(s)} <small>· {s.id.slice(-8)}</small>
              <span className="muted">
                {' '}
                {s.state.activeTurnId
                  ? 'Working'
                  : s.state.approvals?.length
                    ? 'Waiting for permission'
                    : 'Waiting for an answer'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <fieldset className="exit-choices">
        <legend>What should happen?</legend>
        {options
          .filter((option) => !option.hidden)
          .map((option) => (
            <label key={option.value} className={choice === option.value ? 'selected' : undefined}>
              <input
                type="radio"
                name="exit-choice"
                value={option.value}
                checked={choice === option.value}
                onChange={() => setChoice(option.value)}
              />
              <span>
                <strong>{option.title}</strong>
                <span className="muted">{option.detail}</span>
              </span>
            </label>
          ))}
      </fieldset>
      {choice !== 'keepRunning' && notResumable.length > 0 && (
        <p className="data-notice" role="status">
          {notResumable.map(name).join(', ')} {notResumable.length === 1 ? 'is' : 'are'} not
          resumable: the current task stops and stays visible for review.
        </p>
      )}
      {choice !== 'signOut' && (
        <label className="exit-remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Do this whenever I close the window
        </label>
      )}
      <div className="row">
        <button
          className={choice === 'keepRunning' ? 'primary' : 'danger'}
          disabled={busy}
          onClick={() => onExit(choice, remember && choice !== 'signOut')}
        >
          {busy
            ? 'Saving…'
            : choice === 'keepRunning'
              ? 'Close Lascoria'
              : choice === 'pause'
                ? 'Pause and quit'
                : 'Sign out and quit'}
        </button>
        <button disabled={busy} onClick={onCancel}>
          Stay in Lascoria
        </button>
      </div>
    </section>
  );
}
