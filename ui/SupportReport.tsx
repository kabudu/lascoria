import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { request } from './api';

/**
 * R7 support report. The report holds counts, states and versions only; the user reads the
 * exact text before choosing whether to save it, and saving writes that text unchanged.
 * Nothing is uploaded or sent anywhere.
 */
export function SupportReport() {
  const [preview, setPreview] = useState<{ reportId: string; text: string }>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const failure = (e: unknown) => String(e).replace(/^Error: /, '');
  async function build() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setPreview(
        await request<{ reportId: string; text: string }>(
          'support/preview',
          {},
          crypto.randomUUID(),
        ),
      );
    } catch (e) {
      setError(`The report could not be prepared: ${failure(e)}`);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!preview) return;
    setError('');
    setMessage('');
    try {
      const path = await invoke<string | null>('pick_support_report_destination');
      if (!path) return;
      setBusy(true);
      await request('support/save', { reportId: preview.reportId, path });
      setMessage(
        'Support report saved. Only you can open the file; share it only if you choose to.',
      );
    } catch (e) {
      setError(`Report not saved: ${failure(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="support-report" aria-label="Support report" aria-busy={busy}>
      <p>
        A support report describes the state of Lascoria (versions, how many sessions are in each
        state, recent request outcomes and data sizes) to help diagnose a problem. It never contains
        your tasks, conversations, file or folder names, session names, account identity or keys,
        and Lascoria never sends it anywhere.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="support-actions">
        <button onClick={() => void build()} disabled={busy}>
          {preview ? 'Prepare again' : 'Prepare report'}
        </button>
        <button onClick={() => void save()} disabled={busy || !preview}>
          Save report…
        </button>
      </div>
      {preview && (
        <>
          <p className="hint">This is exactly what will be saved:</p>
          <pre className="support-preview" tabIndex={0} aria-label="Report contents">
            {preview.text}
          </pre>
        </>
      )}
    </section>
  );
}
