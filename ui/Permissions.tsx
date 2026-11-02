import { useEffect, useRef, useState, useId } from 'react';
import { request } from './api';
import { modeLabels, profileLabels, permissionSummary } from './permissionPresentation';
import type { Json, SessionRow } from './types';
const safeProfiles = [':ask-me', ':auto-review', ':read-only'];
export function PermissionProfileField({
  value,
  onChange,
  disabled = false,
  name,
}: {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
}) {
  const id = useId();
  return (
    <div className="permission-profile-field">
      <label htmlFor={id}>Permission profile</label>
      <select
        id={id}
        aria-describedby={`${id}-help`}
        name={name}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
      >
        {safeProfiles.map((id) => (
          <option key={id} value={id}>
            {profileLabels[id]}
          </option>
        ))}
      </select>
      <small id={`${id}-help`}>
        Ask me reviews eligible actions. Auto-review delegates eligible decisions to Muse. Read-only
        prevents changes.
      </small>
    </div>
  );
}
export function Permissions({
  session,
  busy,
  apply,
  defaultProfile,
  saveDefault,
  probe,
}: {
  session?: SessionRow;
  busy: boolean;
  apply: (operation: string, params: Json) => Promise<Json>;
  defaultProfile: string;
  saveDefault: (value: string) => Promise<void>;
  probe: (expectedKey: string) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<Json>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [defaultSaveFailed, setDefaultSaveFailed] = useState(false);
  const [profile, setProfile] = useState('');
  const [mode, setMode] = useState('');
  const [future, setFuture] = useState(defaultProfile);
  const [proposal, setProposal] = useState<Json>();
  const mounted = useRef(true);
  const readNumber = useRef(0);
  const changeButton = useRef<HTMLButtonElement>(null);
  const latest = session?.state.permissions;
  const id = session?.id;
  async function refresh() {
    if (!id) return;
    const token = ++readNumber.current;
    setLoading(true);
    setError('');
    try {
      const result = await request('permissions', { sessionId: id });
      if (!mounted.current || readNumber.current !== token) return;
      setCatalog(result);
      setProfile(result.effective.permissionState?.profileId ?? '');
      setMode(result.effective.approvalMode?.mode ?? '');
      setProposal(undefined);
    } catch (e) {
      if (mounted.current && readNumber.current === token) setError(String(e));
    } finally {
      if (mounted.current && readNumber.current === token) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (proposal && latest?.key !== proposal.expectedKey)
      setMessage(
        'Permissions changed while this panel was open. Review the current state before making a change.',
      );
    void refresh();
    return () => {
      mounted.current = false;
      readNumber.current++;
    };
  }, [id, session?.generation, latest?.key]);
  const effective = catalog?.effective;
  const known = Boolean(
    session?.state.current &&
    session.lifecycle === 'connected' &&
    latest?.current &&
    effective?.current &&
    latest.key === effective.key,
  );
  const ready = known && !busy && !loading;
  const rows: Json[] = catalog?.profiles ?? [];
  const chosen = rows.find((r) => r.profileId === profile);
  const changed = effective?.key !== proposal?.expectedKey;
  function review(operation: string, params: Json, label: string) {
    setMessage('');
    setProposal({ operation, ...params, label, expectedKey: effective.key });
  }
  async function confirm() {
    if (!proposal || !ready || changed || !id) return;
    const { operation, label: _label, ...params } = proposal;
    setError('');
    try {
      const result =
        operation === 'permissionPreflight'
          ? await probe(params.expectedKey)
          : await apply(operation, { sessionId: id, ...params, confirmed: true });
      if (!mounted.current) return;
      if (operation !== 'permissionPreflight')
        setMessage(
          !result || ['outcomeUnknown', 'requested', 'unknown'].includes(result.status)
            ? 'The outcome is unknown. Refresh permissions and inspect the command receipt before trying again.'
            : result.status === 'rejected'
              ? (result.error?.message ?? 'Muse refused this change.')
              : 'Muse acknowledged the change. The effective access below is read back from Muse. Existing approval requests still need their own decision.',
        );
      setProposal(undefined);
      await refresh();
    } catch (e) {
      if (mounted.current) {
        setMessage(
          'The change could not be confirmed. Inspect its command receipt before retrying.',
        );
        setProposal(undefined);
        await refresh();
        if (mounted.current) setError(String(e));
      }
    }
  }
  return (
    <div className="permissions-panel">
      <p className="settings-summary">
        {session?.displayName ?? session?.workspace ?? 'Session unavailable'} ·{' '}
        {session?.id.slice(-8)}
      </p>
      <section className="setting-card" aria-label="Effective session permissions">
        <div className="setting-row">
          <strong>{permissionSummary(latest, Boolean(session?.state.current))}</strong>
          <button disabled={busy || loading || !id} onClick={() => void refresh()}>
            Refresh permissions
          </button>
        </div>
        {effective?.observedAtMs && (
          <small className="muted">
            Read from Muse {new Date(effective.observedAtMs).toLocaleTimeString()}
          </small>
        )}
        {!ready && (
          <p role="status">
            {loading
              ? 'Reading permissions from Muse…'
              : 'Permission state is unavailable, changing or disconnected. Refresh before changing access.'}
          </p>
        )}
        {effective?.error && <p role="status">{effective.error}</p>}
        {known &&
          effective?.permissionState?.reviewerAuthority === 'autoReview' &&
          effective?.permissionState?.reviewerAttached === false && (
            <p role="status">
              Auto-review is selected, but Muse reports no reviewer attached. Do not assume requests
              are being reviewed automatically.
            </p>
          )}
        <dl className="permission-facts">
          <dt>Reviewer</dt>
          <dd>
            {(known
              ? (
                  { human: 'You', autoReview: 'Muse auto-review', none: 'No reviewer' } as Record<
                    string,
                    string
                  >
                )[effective?.permissionState?.reviewerAuthority]
              : undefined) ?? 'Unknown'}
            {effective?.permissionState?.reviewerAttached === false ? ' · Not attached' : ''}
          </dd>
          <dt>Sandbox support</dt>
          <dd>
            {(known
              ? ({ available: 'Available', unavailable: 'Unavailable' } as Record<string, string>)[
                  effective?.sandboxAvailability
                ]
              : undefined) ?? 'Unknown'}
            {effective?.sandboxUnavailableReason ? ` · ${effective.sandboxUnavailableReason}` : ''}
          </dd>
          <dt>Workspace</dt>
          <dd>{(known ? effective?.workspaceRoot : undefined) ?? 'Not reported'}</dd>
        </dl>
        <p className="setting-help">
          Approval is a decision to try an action. The operating-system sandbox separately decides
          which resources it can access.
        </p>
        <details>
          <summary>
            {known ? 'Details reported by Muse' : 'Last-read details (not current)'}
          </summary>
          <pre>{JSON.stringify(effective?.permissionState ?? { state: 'unknown' }, null, 2)}</pre>
        </details>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {proposal ? (
        <section
          className="permission-confirm"
          role="group"
          aria-labelledby="permission-confirm-title"
        >
          <h3 id="permission-confirm-title">{proposal.label}</h3>
          <p>
            {proposal.operation === 'permissionPreflight'
              ? 'Starts a separate task using the current model. It asks Muse to run short, bounded probes inside its normal sandbox for process inspection, loopback binding and loopback connection. This uses model allowance. Nothing is run through Lascoria’s developer-command runner.'
              : 'Applies to this session and is saved by Muse. Work already running may continue. This does not decide pending approvals, undo completed work, or remove saved command allowances.'}
          </p>
          {proposal.profileId === ':auto-review' && (
            <p>
              Muse’s automated reviewer may approve eligible requests without asking you. Trusted
              permission hooks may also decide requests.
            </p>
          )}
          {proposal.mode === 'allowAll' && (
            <p className="error">
              Approval requests will be skipped. The sandbox remains required, but it is not a
              guarantee that an action is harmless.
            </p>
          )}
          {(changed || !ready) && (
            <p role="status">
              Permissions changed or cannot be confirmed. Cancel and refresh before reviewing again.
            </p>
          )}
          <div className="row">
            <button
              autoFocus
              onClick={() => {
                setProposal(undefined);
                changeButton.current?.focus();
              }}
            >
              Cancel change
            </button>
            <button className="primary" disabled={!ready || changed} onClick={() => void confirm()}>
              {proposal.operation === 'permissionPreflight'
                ? 'Run capability check'
                : 'Confirm permission change'}
            </button>
          </div>
        </section>
      ) : (
        <>
          <section className="setting-card">
            <label htmlFor="permission-profile">This session’s profile</label>
            <select
              id="permission-profile"
              value={profile}
              disabled={!ready}
              onChange={(e) => setProfile(e.target.value)}
            >
              {!rows.some((r) => r.profileId === profile) && (
                <option value={profile}>
                  {(profileLabels[profile] ?? profile) || 'Unknown profile'}
                </option>
              )}
              {rows.map((r) => (
                <option key={r.profileId} value={r.profileId} disabled={!r.selectable}>
                  {r.label}
                  {!r.selectable ? ' · unavailable here' : ''}
                </option>
              ))}
            </select>
            <p className="setting-help">{chosen?.description}</p>
            {!chosen?.selectable && (
              <p className="setting-help">
                {chosen?.limitation ??
                  chosen?.unavailableReasons?.join(', ') ??
                  'Muse has not made this profile available.'}
              </p>
            )}
            <button
              ref={changeButton}
              disabled={
                !ready || !chosen?.selectable || profile === effective?.permissionState?.profileId
              }
              onClick={() =>
                review(
                  'setPermissionProfile',
                  { profileId: profile },
                  `Change profile to ${chosen.label}?`,
                )
              }
            >
              Review profile change
            </button>
          </section>
          <details className="setting-card">
            <summary>Advanced approval rules</summary>
            <p className="setting-help">
              These govern approval requests, not filesystem or network grants. Stricter shell
              review does not make file-editing tools read-only.
            </p>
            <label htmlFor="permission-mode">Shell approval policy</label>
            <select
              id="permission-mode"
              value={mode}
              disabled={!ready || effective?.permissionState?.profileId === ':read-only'}
              onChange={(e) => setMode(e.target.value)}
            >
              {!modeLabels[mode] && <option value={mode}>Unknown policy</option>}
              {Object.entries(modeLabels).map(([value, label]) => (
                <option
                  key={value}
                  value={value}
                  disabled={
                    value === 'allowAll' &&
                    (effective?.permissionState?.axes?.filesystem !== 'sandboxed' ||
                      effective?.sandboxAvailability !== 'available')
                  }
                >
                  {label}
                </option>
              ))}
            </select>
            <button
              disabled={
                !ready ||
                effective?.permissionState?.profileId === ':read-only' ||
                mode === effective?.approvalMode?.mode
              }
              onClick={() =>
                review(
                  'setApprovalMode',
                  { mode },
                  `Change approval policy to “${modeLabels[mode]}”?`,
                )
              }
            >
              Review approval change
            </button>
            <p className="setting-help">
              Changing a profile or review policy does not revoke existing saved allowances.
              Persistent rules must be reviewed in Muse; this protocol does not expose a
              rule-removal command.
            </p>
          </details>
          <section className="setting-card">
            <h3>Check what the sandbox allows</h3>
            <p className="setting-help">
              A localhost connection rule does not prove that a command can bind a server port or
              inspect processes. Check through Muse, in the same boundary as your task. Probes use
              an ephemeral loopback port, not an external destination. Python 3 is required on
              macOS/Linux.
            </p>
            <button
              disabled={
                !ready ||
                effective?.permissionState?.profileId === ':read-only' ||
                Boolean(session?.state.activeTurnId) ||
                Boolean(session?.state.approvals?.length) ||
                Boolean(session?.state.userInputs?.length)
              }
              onClick={() => review('permissionPreflight', {}, 'Run a sandbox capability check?')}
            >
              Review capability check
            </button>
            <p className="setting-help">
              Results appear as a separate task. A model’s summary alone is not proof that the probe
              ran.
            </p>
          </section>
        </>
      )}
      {session?.state.permissionProbe && (
        <section className="setting-card" aria-label="Last capability check">
          <h3>Last capability check</h3>
          <p className="setting-help">
            {session.state.permissionProbe.currentBoundary
              ? 'Observed under the current permission snapshot.'
              : 'Historical result. Permissions or the host have changed since this check.'}{' '}
            These observations concern this command and its disposable loopback port, not every
            process or development port.
          </p>
          {session.state.permissionProbe.observed ? (
            <dl className="permission-facts">
              {Object.entries(session.state.permissionProbe.observed.results).map(
                ([key, value]: [string, any]) => (
                  <div key={key}>
                    <dt>
                      {
                        (
                          {
                            processInspection: 'Inspect own process',
                            loopbackBind: 'Bind loopback listener',
                            loopbackConnection: 'Connect to that listener',
                          } as Record<string, string>
                        )[key]
                      }
                    </dt>
                    <dd>
                      {value.status === 'allowed'
                        ? 'Succeeded'
                        : value.status === 'denied'
                          ? 'Refused or failed'
                          : 'Not checked'}
                      {value.detail ? ` · ${value.detail}` : ''}
                    </dd>
                  </div>
                ),
              )}
            </dl>
          ) : (
            <p role="status">
              No matching completed native probe output is available. A model summary, changed
              command, escalated tool or truncated output does not establish the result. Inspect the
              capability-check task in Transcript.
            </p>
          )}
        </section>
      )}
      <details className="setting-card">
        <summary>Default for new sessions</summary>
        <PermissionProfileField value={future} onChange={setFuture} disabled={busy} />
        <button
          disabled={busy || savingDefault || (future === defaultProfile && !defaultSaveFailed)}
          onClick={() => {
            setSavingDefault(true);
            setError('');
            void saveDefault(future)
              .then(
                () => {
                  if (mounted.current) {
                    setDefaultSaveFailed(false);
                    setMessage(
                      'New session default saved. Existing sessions keep their own permissions.',
                    );
                  }
                },
                (e) => {
                  if (mounted.current) {
                    setDefaultSaveFailed(true);
                    setError(
                      `The new-session default was not confirmed saved. Retry saving it. ${String(e)}`,
                    );
                  }
                },
              )
              .finally(() => {
                if (mounted.current) setSavingDefault(false);
              });
          }}
        >
          Save new-session default
        </button>
      </details>
    </div>
  );
}
