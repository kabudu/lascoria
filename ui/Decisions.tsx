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
type Settings = {
  revision: number;
  admissionEpoch: string;
  providers: Provider[];
  workspace?: string;
  recent: Json[];
};

export function DecisionResult({ row }: { row: Json }) {
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
        Optional, separately billed advice about a saved diff snapshot. Muse keeps running
        independently. Nothing is sent in the background.
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
              <DecisionResult row={row} />
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
