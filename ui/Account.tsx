import { MuseSetup } from './MuseSetup';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { request } from './api';
export type AccountStatus = {
  managed: boolean;
  unavailable?: boolean;
  reconnectRequired?: boolean;
  logoutPending?: boolean;
  mode: 'loggedOut' | 'subscription' | 'apiKey';
  authenticated: boolean;
  keyConfigured: boolean | null;
  keyStorageAvailable?: boolean | null;
  subscription: { state: string; label?: string };
  pending: boolean;
  outcome?: string | null;
};
export function Account({
  account,
  refresh,
  onRuntimeReady,
}: {
  account: AccountStatus | null;
  refresh: () => Promise<void>;
  onRuntimeReady?: (ready: boolean) => void;
}) {
  const native = Boolean((window as any).__TAURI_INTERNALS__?.metadata);
  const [runtimeReady, setRuntimeReady] = useState(!native);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [flow, setFlow] = useState<{ verificationUrl?: string; userCode?: string } | null>(null);
  const [confirm, setConfirm] = useState<'logout' | 'forget' | null>(null);
  async function perform(operation: string, params = {}, after?: (value: any) => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      const value = await request(operation, params);
      if (after) await after(value);
      await refresh();
    } catch {
      setMessage(
        'Account action could not be completed. Unlock your Mac, check the connection and try again. Your API key has not been displayed or recorded in the command journal.',
      );
    } finally {
      setBusy(false);
    }
  }
  const subscription = account?.mode === 'subscription' && account.authenticated;
  const api = account?.mode === 'apiKey' && account.authenticated;
  return (
    <section className="account-panel" aria-label="Muse account">
      {native && (
        <MuseSetup
          onReady={(ready) => {
            setRuntimeReady(ready);
            onRuntimeReady?.(ready);
          }}
        />
      )}
      {(!account || account.unavailable) && (
        <div role="status">
          <p>Your account connection could not be checked. Unlock your Mac and retry.</p>
          <button
            disabled={busy}
            onClick={() =>
              void refresh().catch(() => setMessage('Account connection is still unavailable.'))
            }
          >
            Retry connection
          </button>
        </div>
      )}
      {account?.reconnectRequired && (
        <p role="alert">
          Muse requires you to reconnect your subscription. Your saved API key remains inactive.
        </p>
      )}
      {account?.logoutPending && (
        <div role="alert">
          <p>You are signed out locally. Stopping the account host still needs confirmation.</p>
          <button disabled={busy} onClick={() => void perform('account/logout')}>
            Finish signing out
          </button>
        </div>
      )}
      <div className="account-summary">
        <span className="eyebrow">
          {subscription ? 'Subscription active' : api ? 'API billing selected' : 'Connect to Muse'}
        </span>
        <h3>
          {subscription
            ? (account.subscription.label ?? 'Muse account')
            : api
              ? 'Meta API key'
              : 'Your agents, your Muse account'}
        </h3>
        <p>
          Use your subscription with browser sign-in, or connect a Meta API key for usage-based
          billing.
        </p>
      </div>
      <div className="account-choice">
        <div>
          <h3>Muse subscription</h3>
          <p>Preferred whenever you sign in. A saved API key stays inactive.</p>
        </div>
        <button
          className="primary"
          disabled={busy || !account || !runtimeReady}
          onClick={() =>
            void perform('account/login', {}, async (value) => {
              setFlow(value);
              if (value.verificationUrl)
                await invoke('open_account_browser', { url: value.verificationUrl });
            })
          }
        >
          {subscription ? 'Reconnect Muse' : 'Continue with Muse'}
        </button>
      </div>
      {account?.pending && (
        <div className="account-flow" role="status">
          <p>
            {flow?.verificationUrl
              ? 'Approve this code in your browser'
              : 'Browser sign-in is pending. Complete the open browser flow, or cancel and try again.'}
          </p>
          {flow?.userCode && <strong className="account-code">{flow.userCode}</strong>}
          <div className="account-actions">
            {flow?.verificationUrl && (
              <button
                disabled={busy}
                onClick={() =>
                  void invoke('open_account_browser', { url: flow.verificationUrl }).catch(() =>
                    setMessage('Could not open your browser. Try opening it again.'),
                  )
                }
              >
                Open browser
              </button>
            )}
            <button
              disabled={busy}
              onClick={() =>
                void perform('account/cancel', {}, async () => {
                  setFlow(null);
                })
              }
            >
              Cancel sign-in
            </button>
          </div>
        </div>
      )}
      {account?.outcome && account.outcome !== 'granted' && !account.pending && (
        <p role="status">Browser sign-in {account.outcome}. You can try again.</p>
      )}
      {api && (
        <p className="hint">Provider access and API billing are checked when you run a task.</p>
      )}
      <details className="account-api" open={api || undefined}>
        <summary>
          API key{' '}
          {account?.keyConfigured === null
            ? '· status unavailable'
            : account?.keyConfigured
              ? '· saved securely'
              : '· optional'}
        </summary>
        {account?.keyStorageAvailable === false && (
          <p role="status">
            Your secure credential store is unavailable. Unlock it to use API keys. Browser
            subscription sign-in is still available.
          </p>
        )}
        <p>
          Stored in your operating system’s secure credential store. Signing in with Muse takes
          precedence. API usage is never enabled automatically when a subscription expires.
        </p>
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const value = key;
            setKey('');
            void perform('account/setKey', { apiKey: value });
          }}
        >
          <label htmlFor="meta-api-key">Meta API key</label>
          <input
            id="meta-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            maxLength={8192}
            onChange={(event) => setKey(event.target.value)}
            placeholder={account?.keyConfigured ? 'Replace saved key' : 'Paste your API key'}
          />
          <button disabled={busy || !account || !key.trim()} type="submit">
            {subscription ? 'Save inactive API key' : 'Save and use API key'}
          </button>
        </form>
        {account?.keyConfigured && (
          <div className="account-actions">
            {!api && !subscription && !account.pending && (
              <button disabled={busy} onClick={() => void perform('account/useKey')}>
                Use API billing instead
              </button>
            )}
            <button disabled={busy} onClick={() => setConfirm('forget')}>
              Forget API key…
            </button>
          </div>
        )}
      </details>
      <p className="hint">
        Changing sign-in mode stops Muse hosts. Conversations and interrupted turns are retained;
        uncertain commands are never replayed. Closing the window keeps the supervisor running. Meta
        may still require you to reconnect if access expires or is revoked.
      </p>
      {(account?.authenticated || account?.mode !== 'loggedOut') && account?.managed && (
        <button disabled={busy} onClick={() => setConfirm('logout')}>
          Sign out of Lascoria…
        </button>
      )}
      {confirm && (
        <section
          className="account-confirm"
          aria-label={confirm === 'logout' ? 'Confirm sign out' : 'Confirm forget API key'}
        >
          <h3>{confirm === 'logout' ? 'Sign out of Lascoria?' : 'Forget the saved API key?'}</h3>
          <p>
            {confirm === 'logout'
              ? 'Active turns will be cancelled before Muse hosts stop. Saved conversation history and worktrees remain available to continue after sign-in. The saved API key stays inactive until you explicitly choose it again. Your Muse CLI login is retained; returning here requires browser approval.'
              : 'The key will be removed from your secure credential store. If API billing is active, Muse hosts will stop and you will be signed out.'}
          </p>
          <div className="account-actions">
            <button disabled={busy} onClick={() => setConfirm(null)}>
              Keep current connection
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void perform(
                  confirm === 'logout' ? 'account/logout' : 'account/forgetKey',
                  {},
                  async () => {
                    setConfirm(null);
                    setFlow(null);
                  },
                )
              }
            >
              {confirm === 'logout' ? 'Sign out and stop Muse' : 'Forget API key'}
            </button>
          </div>
        </section>
      )}
      {busy && <p role="status">Updating your connection…</p>}
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
    </section>
  );
}
