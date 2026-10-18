import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import { request } from './api';
import type { Artifact, Json } from './types';

type Provider = {
  id: string;
  name: string;
  endpoint: string;
  policyUrl: string;
  model: string;
  enabled: boolean;
  keySaved: boolean;
  workspaces: string[];
};
type Mode = { provider: string | null; workspaces: string[]; share?: string[]; dailyLimit: number };
type Settings = {
  revision: number;
  admissionEpoch: string;
  providers: Provider[];
  modes?: { triage: Mode; tool: Mode };
  workspace?: string;
  recent: Json[];
};
const SHARE_LABELS: Record<string, string> = {
  request: 'What you asked for (your own words)',
  reply: "Muse's latest reply and the task outcome",
  question: 'That Muse is waiting for you, and its question',
};

export function DecisionResult({ row, onFeedback }: { row: Json; onFeedback?: () => void }) {
  const [verdict, setVerdict] = useState<string | undefined>(row.userVerdict);
  const result = row.result;
  const usable = row.status === 'completed' && Boolean(result);
  const answer = result?.answer;
  const probability = answer?.probability ?? answer?.noul;
  return (
    <article className="decision-result" aria-label="Decision result">
      <strong>
        {usable
          ? 'Advisory result'
          : ((
              {
                stale: 'Result out of date',
                unknown: 'Outcome unavailable',
                sending: 'Request in progress',
                failed: 'Request failed',
                cancelled: 'Request cancelled',
                completed: 'Request completed',
                retained: 'Request identity retained',
              } as Record<string, string>
            )[row.status] ?? 'Request outcome')}
      </strong>
      <p>
        {row.provider} · {result?.model ?? row.model} ·{' '}
        {new Date(row.createdAtMillis).toLocaleString()}
      </p>
      {row.message && <p role="status">{row.message}</p>}
      {row.detailsPruned && (
        <p>The full advice details are no longer retained. This request will not be sent again.</p>
      )}
      {result && (
        <>
          {!usable && (
            <p>This result is not current. Review a fresh snapshot before using advice.</p>
          )}
          {usable && (
            <p className="decision-answer">
              {typeof probability === 'number'
                ? `${Math.round(probability * 100)}% provider-estimated probability of yes`
                : answer?.type === 'choice'
                  ? `Choice: ${row.question?.options?.[Number(String(answer.choice).replace('option_', ''))] ?? answer.choice}`
                  : `Score: ${answer?.score} on a 0 to ${(row.question?.options?.length ?? 1) - 1} scale`}
            </p>
          )}
          <p>Advice only. It has not approved a permission, accepted evidence or changed Muse.</p>
          {usable &&
            (verdict ? (
              <p className="hint">
                You marked this answer as {verdict === 'agree' ? 'right' : 'wrong'}.
              </p>
            ) : (
              <div className="settings-actions" role="group" aria-label="Was this answer right?">
                {(['agree', 'disagree'] as const).map((choice) => (
                  <button
                    key={choice}
                    onClick={() =>
                      void request('decision/feedback', {
                        requestId: row.id,
                        verdict: choice,
                      }).then(
                        () => {
                          setVerdict(choice);
                          onFeedback?.();
                        },
                        () => {},
                      )
                    }
                  >
                    {choice === 'agree' ? 'Seems right' : 'Seems wrong'}
                  </button>
                ))}
              </div>
            ))}
          <details>
            <summary>Source, rubric and reported metrics</summary>
            <p>
              Rubric {row.rubricVersion} · {row.latencyMs ?? 'Unknown'} ms · API price not reported.
              Charges are separate from Muse.
            </p>
            <p>
              Checked{' '}
              {row.checkedAtMillis
                ? new Date(row.checkedAtMillis).toLocaleString()
                : 'not reported'}
              . Files can change afterwards.
            </p>
            <pre>
              {JSON.stringify(
                {
                  source: row.source,
                  fingerprint: row.fingerprint,
                  question: row.question,
                  answer,
                  usage: result.usage,
                  providerRequestId: result.providerRequestId,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
      {row.reused && <p>Retrieved the original request. No second call was sent.</p>}
      {row.mayHaveBeenBilled && !usable && (
        <p>The provider may have billed this request. Lascoria will not retry it automatically.</p>
      )}
    </article>
  );
}

export function DecisionSettings({
  sessionId,
  changed,
}: {
  sessionId?: string;
  changed?: () => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Json>();
  const [remove, setRemove] = useState<string>();
  const reload = () =>
    request<Settings>('decision/status', sessionId ? { sessionId } : {}).then(setSettings);
  useEffect(() => {
    void reload().catch((e) => setError(String(e)));
  }, [sessionId]);
  async function change(operation: string, params: Json) {
    setBusy(true);
    setError('');
    try {
      const row = await request(operation, params);
      if (operation === 'decision/test') setResult(row);
      await reload();
      if (operation !== 'decision/test') changed?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!settings) return <p role="status">{error || 'Reading integration settings…'}</p>;
  return (
    <section
      aria-label="Decision assistance settings"
      className="settings-group decision-settings"
      aria-busy={busy}
    >
      <p>
        Optional, separately billed advice from a decision model, with your own API key. Muse keeps
        running independently. Nothing is sent in the background unless you turn on Background
        triage below for a workspace.
      </p>
      <p>
        Review the destination and provider policy before enabling a key. Lascoria does not change
        your provider's retention settings or promise zero retention.
      </p>
      <p>
        Saving a replacement key turns this provider off and clears its workspace consent. Enable it
        again after checking the billed account.
      </p>
      {!sessionId && <p>Open a session to enable assistance for its workspace.</p>}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void reload()
            .catch((e) => setError(String(e)))
            .finally(() => setBusy(false));
        }}
      >
        Refresh settings and request history
      </button>
      {settings.providers.map((p) => (
        <details key={`${p.id}:${settings.revision}`} className="decision-provider">
          <summary>
            {p.name} · {p.enabled ? 'Enabled' : 'Off'} · {p.keySaved ? 'Key saved' : 'No key saved'}
          </summary>
          <p className="decision-destination">
            Destination: <code>{p.endpoint}</code>
          </p>
          <p>
            Data policy: <code>{p.policyUrl}</code>
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void invoke('open_provider_policy', { url: p.policyUrl }).catch((e) =>
                setError(String(e)),
              )
            }
          >
            Read provider data policy
          </button>
          {p.id === 'subq' && (
            <p>
              SubQ retains data indefinitely by default. Check your organisation's policy before
              sending a snapshot.
            </p>
          )}
          {p.id === 'jev' && (
            <p>
              TypeSafe retention depends on your agreement and any agreed zero-retention
              arrangement.
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const apiKey = String(new FormData(form).get('apiKey') ?? '');
              // Never retain a credential in React state or leave it in the input while IPC runs.
              form.reset();
              void change('decision/setKey', {
                provider: p.id,
                apiKey,
                expectedRevision: settings.revision,
              });
            }}
          >
            <label>
              API key for {p.name}
              <input
                name="apiKey"
                type="password"
                autoComplete="off"
                required
                minLength={8}
                maxLength={4096}
                disabled={busy}
              />
            </label>
            <button disabled={busy}>Save key securely</button>
          </form>
          <div className="settings-actions">
            <button
              disabled={busy || !p.keySaved}
              onClick={() =>
                void change('decision/test', {
                  provider: p.id,
                  admissionEpoch: settings.admissionEpoch,
                })
              }
            >
              Test connection (paid API)
            </button>
            <button disabled={busy || !p.keySaved} onClick={() => setRemove(p.id)}>
              Remove key…
            </button>
          </div>
          <p className="hint">
            Connection testing sends only a fixed public sentence about arithmetic. It may incur a
            provider charge.
          </p>
          {remove === p.id && (
            <div role="group" aria-label="Confirm key removal">
              <p>
                Remove this provider's key and turn its assistance off for every workspace? Your
                Muse login is unaffected.
              </p>
              <button
                disabled={busy}
                onClick={() => {
                  setRemove(undefined);
                  void change('decision/forgetKey', {
                    provider: p.id,
                    expectedRevision: settings.revision,
                  });
                }}
              >
                Remove key and turn off
              </button>
              <button onClick={() => setRemove(undefined)}>Keep key</button>
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              void change('decision/configure', {
                provider: p.id,
                expectedRevision: settings.revision,
                model: String(data.get('model')),
                enabled: data.get('enabled') === 'on',
                ...(sessionId
                  ? { sessionId, workspaceEnabled: data.get('workspace') === 'on' }
                  : {}),
              });
            }}
          >
            <label>
              Model for {p.name}
              <input name="model" defaultValue={p.model} required maxLength={128} disabled={busy} />
            </label>
            <label className="settings-choice">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={p.enabled}
                disabled={busy || !p.keySaved}
              />
              Enable manual reviews with this provider
            </label>
            {sessionId && (
              <label className="settings-choice">
                <input
                  name="workspace"
                  type="checkbox"
                  defaultChecked={p.workspaces.includes(settings.workspace ?? '')}
                  disabled={busy || !p.keySaved}
                />
                Allow sending selected snapshots from this workspace
              </label>
            )}
            <button disabled={busy}>Save provider settings</button>
          </form>
        </details>
      ))}
      {result && <DecisionResult row={result} />}
      <ModeSettings settings={settings} sessionId={sessionId} busy={busy} change={change} />
      <DecisionMetrics revision={settings.revision} />
      <details>
        <summary>Recent requests and metrics</summary>
        <p>
          Latest {settings.recent.length} requests, including connection tests. Cost stays unknown
          unless reported; these calls are not included in your Muse subscription.
        </p>
        {settings.recent.length === 0 ? (
          <p>No requests yet.</p>
        ) : (
          settings.recent.map((row) => (
            <details key={row.id}>
              <summary>
                {row.provider} · {row.status} · {new Date(row.createdAtMillis).toLocaleString()}
              </summary>
              <DecisionResult row={row} onFeedback={() => void reload()} />
            </details>
          ))
        )}
      </details>
    </section>
  );
}

export function DecisionReview({
  artifact,
  openSettings,
}: {
  artifact: Artifact;
  openSettings: () => void;
}) {
  const [settings, setSettings] = useState<Settings>();
  const [provider, setProvider] = useState('');
  const [prompt, setPrompt] = useState('Does this change show a concrete correctness defect?');
  const [kind, setKind] = useState('predicate');
  const [options, setOptions] = useState('Needs changes\nReady for human review');
  const [preview, setPreview] = useState<Json>();
  const [row, setRow] = useState<Json>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState<string>();
  const [retry, setRetry] = useState<{ id: string; params: Json }>();
  useEffect(() => {
    void request<Settings>('decision/status', { sessionId: artifact.sessionId }).then(
      setSettings,
      (e) => setError(String(e)),
    );
  }, [artifact.sessionId]);
  const providers =
    settings?.providers.filter(
      (p) => p.enabled && p.workspaces.includes(settings.workspace ?? ''),
    ) ?? [];
  const selected = provider || providers[0]?.id || '';
  const params = {
    sessionId: artifact.sessionId,
    artifactId: artifact.id,
    provider: selected,
    question: {
      type: kind,
      prompt,
      ...(kind !== 'predicate'
        ? {
            options: options
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          }
        : {}),
    },
  };
  async function readPreview() {
    setBusy(true);
    setError('');
    setRow(undefined);
    setPreview(undefined);
    try {
      setPreview(await request('decision/preview', params));
      setRetry(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function send(saved?: { id: string; params: Json }) {
    const next = saved ?? {
      id: crypto.randomUUID(),
      params: { ...params, fingerprint: preview.fingerprint },
    };
    setRetry(next);
    setRunning(next.id);
    setBusy(true);
    setError('');
    try {
      setRow(await request('decision/evaluate', next.params, next.id));
      setRetry(undefined);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(undefined);
      setBusy(false);
    }
  }
  const change = () => {
    setPreview(undefined);
    setRow(undefined);
    setRetry(undefined);
    setError('');
  };
  return (
    <details className="decision-review">
      <summary>Optional decision assistance</summary>
      <p>
        A separate provider can evaluate this snapshot. Advice never accepts evidence or changes
        Muse permissions.
      </p>
      {error && <p role="alert">{error}</p>}
      {providers.length === 0 ? (
        <>
          <p>Enable a provider and this workspace in Settings first.</p>
          <button onClick={openSettings}>Configure decision assistance</button>
        </>
      ) : (
        <>
          <label>
            Decision provider
            <select
              value={selected}
              disabled={busy}
              onChange={(e) => {
                setProvider(e.target.value);
                change();
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Question
            <textarea
              value={prompt}
              maxLength={2000}
              disabled={busy}
              onChange={(e) => {
                setPrompt(e.target.value);
                change();
              }}
            />
          </label>
          <label>
            Answer type
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => {
                setKind(e.target.value);
                change();
              }}
            >
              <option value="predicate">Yes or no probability</option>
              <option value="choice">Choose from options</option>
              <option value="score">Score ordered levels</option>
            </select>
          </label>
          {kind !== 'predicate' && (
            <label>
              {kind === 'choice' ? 'Options' : 'Levels, lowest first'} (one per line, two to eight)
              <textarea
                value={options}
                disabled={busy}
                onChange={(e) => {
                  setOptions(e.target.value);
                  change();
                }}
              />
            </label>
          )}
          <button disabled={busy} onClick={() => void readPreview()}>
            Preview exactly what will be sent
          </button>
          {preview && (
            <section aria-label="Decision disclosure preview" className="decision-preview">
              <p>
                <strong>{preview.model}</strong> at <code>{preview.endpoint}</code>
              </p>
              <p>
                {preview.bytes} bytes of snapshot text. This is a separately billed API call. The
                provider's retention policy applies.
              </p>
              <p>Request body, authenticated with this provider’s saved API key:</p>
              <pre>{JSON.stringify(preview.payload, null, 2)}</pre>
              <button
                className="primary"
                disabled={busy || !!row || !!retry}
                onClick={() => void send()}
              >
                Send this snapshot for advice
              </button>
            </section>
          )}
          {running && (
            <button
              onClick={() =>
                void request<Json>('decision/cancel', { requestId: running }).then(
                  (r) => {
                    if (!r.requested)
                      setError(
                        'The request has not started or has finished. Refresh its outcome before sending anything else.',
                      );
                  },
                  (e) => setError(String(e)),
                )
              }
            >
              Cancel request
            </button>
          )}
          {retry && !busy && (
            <button
              onClick={() => {
                setBusy(true);
                setError('');
                void request('decision/result', { requestId: retry.id })
                  .then(
                    (r) => {
                      setRow(r);
                      setRetry(undefined);
                    },
                    (e) => setError(String(e)),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              Retrieve original request (never sends twice)
            </button>
          )}
          {row && <DecisionResult row={row} />}
        </>
      )}
    </details>
  );
}

/** Background triage (b) and the Muse tool (c): each has its own provider and workspace consent. */
function ModeSettings({
  settings,
  sessionId,
  busy,
  change,
}: {
  settings: Settings;
  sessionId?: string;
  busy: boolean;
  change: (operation: string, params: Json) => Promise<void>;
}) {
  const usable = settings.providers.filter((p) => p.enabled && p.keySaved);
  const modes = settings.modes;
  if (!modes) return null;
  const save = (mode: 'triage' | 'tool', params: Json) =>
    change('decision/configureMode', { mode, expectedRevision: settings.revision, ...params });
  const section = (mode: 'triage' | 'tool', title: string, explain: string) => {
    const current = modes[mode];
    const here = Boolean(settings.workspace && current.workspaces.includes(settings.workspace));
    return (
      <fieldset key={mode} className="decision-mode" aria-label={title}>
        <legend>{title}</legend>
        <p className="hint">{explain}</p>
        <label>
          Provider
          <select
            value={current.provider ?? ''}
            disabled={busy || usable.length === 0}
            onChange={(event) => void save(mode, { provider: event.currentTarget.value || null })}
          >
            <option value="">Off</option>
            {usable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {usable.length === 0 && (
          <p className="hint">Enable a provider with a saved key above first.</p>
        )}
        {current.provider &&
          (sessionId ? (
            <label className="settings-choice">
              <input
                type="checkbox"
                checked={here}
                disabled={busy}
                onChange={(event) =>
                  void save(mode, { sessionId, workspaceEnabled: event.currentTarget.checked })
                }
              />
              Use it for this session&apos;s workspace
            </label>
          ) : (
            <p className="hint">Open a session to turn it on for its workspace.</p>
          ))}
        {current.provider && mode === 'triage' && (
          <div role="group" aria-label="What triage shares">
            {Object.entries(SHARE_LABELS).map(([part, label]) => (
              <label key={part} className="settings-choice">
                <input
                  type="checkbox"
                  checked={current.share?.includes(part) ?? false}
                  disabled={busy}
                  onChange={(event) => {
                    const next = event.currentTarget.checked
                      ? [...(current.share ?? []), part]
                      : (current.share ?? []).filter((s) => s !== part);
                    if (next.length) void save(mode, { share: next });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        )}
        {current.provider && (
          <label>
            At most
            <select
              value={current.dailyLimit}
              disabled={busy}
              onChange={(event) =>
                void save(mode, { dailyLimit: Number(event.currentTarget.value) })
              }
            >
              {[10, 25, 50, 100, 250].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            requests a day
          </label>
        )}
      </fieldset>
    );
  };
  return (
    <>
      {section(
        'triage',
        'Background triage',
        'When a task finishes or Muse waits for you in a workspace you turn on, Lascoria sends the parts you choose to estimate whether it needs you soon, at most once per update. A quiet note appears beside the session name. This sends data without asking each time.',
      )}
      {section(
        'tool',
        'Muse can ask',
        'In workspaces you turn on, Muse gets a tool to ask your decision model one question about text Muse chooses (up to 16,000 characters). Muse sees the advice; it never approves anything.',
      )}
    </>
  );
}

/** Aggregate metrics over the retained request history (optional, read-only). */
function DecisionMetrics({ revision }: { revision: number }) {
  const [metrics, setMetrics] = useState<Json>();
  useEffect(() => {
    void request('decision/metrics').then(setMetrics, () => {});
  }, [revision]);
  const rows = Object.entries((metrics?.providers ?? {}) as Record<string, Json>);
  if (!rows.length) return null;
  const purposes: Record<string, string> = {
    manual: 'reviews',
    triage: 'triage',
    museTool: 'Muse',
    connectionTest: 'tests',
  };
  return (
    <details className="decision-metrics">
      <summary>Usage summary</summary>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>Requests (24 h)</th>
            <th>By use</th>
            <th>Input tokens</th>
            <th>Typical time</th>
            <th>You disagreed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, m]) => (
            <tr key={id}>
              <td>{id}</td>
              <td>
                {m.requests} ({m.last24h})
              </td>
              <td>
                {Object.entries(m.byPurpose as Record<string, number>)
                  .map(([k, v]) => `${v} ${purposes[k] ?? k}`)
                  .join(', ')}
              </td>
              <td>{m.tokensReported ? m.inputTokens.toLocaleString() : 'not reported'}</td>
              <td>
                {typeof m.latencyP50Ms === 'number'
                  ? `${(m.latencyP50Ms / 1000).toFixed(1)} s (95%: ${(m.latencyP95Ms / 1000).toFixed(1)} s)`
                  : 'n/a'}
              </td>
              <td>
                {m.disagreed} of {m.agreed + m.disagreed} marked
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        Billed by each provider to your own account, separately from Muse. Cost is unknown because
        these APIs do not report a billed amount.
      </p>
    </details>
  );
}

/** Background triage (b): a quiet note beside the session name when it likely needs you. */
export function TriageNote({
  sessionId,
  latestTurn,
  trigger,
}: {
  sessionId: string;
  latestTurn?: string;
  /** Changes when the latest task finishes or starts waiting, the moments triage runs. */
  trigger: string;
}) {
  const [row, setRow] = useState<Json>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Triage answers arrive within seconds of an update; check twice a minute, not on every
    // status change, so a streaming session does not re-read history continuously.
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void request<Settings>('decision/status', { sessionId }).then(
      (settings) => {
        if (cancelled) return;
        const enabled =
          settings.modes?.triage.provider &&
          settings.workspace &&
          settings.modes.triage.workspaces.includes(settings.workspace);
        setRow(
          enabled
            ? settings.recent.find(
                (r) =>
                  r.purpose === 'triage' &&
                  r.status === 'completed' &&
                  r.source?.sessionId === sessionId &&
                  r.source?.turnId === latestTurn,
              )
            : undefined,
        );
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, latestTurn, trigger, tick]);
  const answer = row?.result?.answer;
  const probability = answer?.probability ?? answer?.noul;
  if (typeof probability !== 'number' || probability < 0.5) return null;
  return (
    <span
      className="triage-note"
      title={`Estimated by ${row?.provider} at ${new Date(row?.createdAtMillis).toLocaleString()}; advice only`}
    >
      Likely needs you ({Math.round(probability * 100)}%)
    </span>
  );
}
