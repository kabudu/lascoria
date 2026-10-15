import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import type { Json, SessionRow } from './types';

type Message = {
  id: string;
  from: string;
  to: string;
  body: string;
  createdAtMillis: number;
  expiresAtMillis: number;
  delivery?: { id: string; status: string };
  origin: 'user' | 'agent';
};
type Inbox = {
  revision: number;
  connections: { sessions: string[]; active: boolean; allowAgentMessages?: boolean }[];
  messages: Message[];
};
export function SessionRelay({
  session,
  sessions,
  labels,
}: {
  session: SessionRow;
  sessions: SessionRow[];
  labels: Record<string, string>;
}) {
  const [inbox, setInbox] = useState<Inbox>();
  const [peer, setPeer] = useState('');
  const [text, setText] = useState('');
  const [allowAgents, setAllowAgents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<Record<string, Json>>({});
  const pending = useRef<{ id: string; peer: string; text: string } | undefined>(undefined);
  const name = (id: string) => labels[id] || `Session ${id.slice(-8)}`;
  const refresh = async () =>
    setInbox(await request<Inbox>('relay/get', { sessionId: session.id }));
  useEffect(() => {
    void refresh().catch(() => setError('Local messages are unavailable. Refresh to reconnect.'));
  }, [session.id]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const connection = inbox?.connections.find((c) => c.active && c.sessions.includes(peer));
  const active = Boolean(connection);
  const toolsReady = Boolean(
    session.state.relayToolsAvailable &&
    sessions.find((s) => s.id === peer)?.state.relayToolsAvailable,
  );
  return (
    <section className="session-relay" aria-label="Local session messages" aria-busy={busy}>
      <p>
        Share selected text with another Muse session on this computer. Files, permissions and
        conversation history stay separate.
      </p>
      <label>
        Other session
        <select
          value={peer}
          disabled={busy || Boolean(pending.current)}
          onChange={(e) => {
            setPeer(e.target.value);
            setAllowAgents(false);
          }}
        >
          <option value="">Choose a local session</option>
          {sessions
            .filter((s) => s.id !== session.id && s.lifecycle !== 'archived')
            .map((s) => (
              <option key={s.id} value={s.id}>
                {name(s.id)} · {s.workspace}
              </option>
            ))}
        </select>
      </label>
      {peer && (
        <label className="relay-agent-permission">
          <input
            type="checkbox"
            checked={active ? Boolean(connection?.allowAgentMessages) : allowAgents}
            disabled={busy || active || !toolsReady}
            onChange={(e) => setAllowAgents(e.target.checked)}
          />
          Allow Muse to send and read task messages (up to 8 per connection)
        </label>
      )}
      {peer && !toolsReady && (
        <p className="muted">
          Resume both sessions with the current runtime to enable Muse messaging tools.
        </p>
      )}
      {connection?.allowAgentMessages && (
        <p className="muted">
          Muse may exchange selected task context with this peer. No model turn starts
          automatically. Disconnect to revoke this permission.
        </p>
      )}
      <div className="relay-actions">
        <button
          disabled={busy || !peer || !inbox || Boolean(pending.current)}
          onClick={() =>
            void run(async () => {
              await request(active ? 'relay/disconnect' : 'relay/connect', {
                sessionId: session.id,
                peerId: peer,
                expectedRevision: inbox!.revision,
                allowAgentMessages: allowAgents,
              });
              await refresh();
            })
          }
        >
          {active ? 'Disconnect sessions' : 'Connect sessions'}
        </button>
        <button className="quiet-action" disabled={busy} onClick={() => void run(refresh)}>
          Refresh messages
        </button>
      </div>
      {peer && active && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const intent = pending.current ?? { id: crypto.randomUUID(), peer, text };
              pending.current = intent;
              await request(
                'relay/send',
                { sessionId: session.id, peerId: intent.peer, body: intent.text },
                intent.id,
              );
              pending.current = undefined;
              setText('');
              await refresh();
            });
          }}
        >
          <label>
            Message
            <textarea
              value={text}
              maxLength={8192}
              disabled={busy || Boolean(pending.current)}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <p className="muted">
            Only this text is shared. Sending to the inbox does not call a model.
          </p>
          <button disabled={busy || !text.trim() || new TextEncoder().encode(text).length > 8192}>
            {pending.current ? 'Retry same message' : 'Share message'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="relay-messages">
        {inbox?.messages
          .filter((m) => !peer || m.from === peer || m.to === peer)
          .map((m) => (
            <article key={m.id}>
              <strong>
                {name(m.from)} → {name(m.to)}
              </strong>
              <p className="muted">
                {m.origin === 'agent' ? 'Shared by Muse' : 'Shared by you'} ·{' '}
                {new Date(m.createdAtMillis).toLocaleString()} · Saved in local inbox
              </p>
              <p className="relay-body">{m.body}</p>
              {!m.delivery && Date.now() >= m.expiresAtMillis && (
                <p className="muted">Expired. Share a new message to ask Muse.</p>
              )}
              {m.to === session.id && (
                <>
                  <button
                    disabled={
                      busy ||
                      Boolean(session.state.activeTurnId) ||
                      !session.state.current ||
                      session.lifecycle !== 'connected'
                    }
                    onClick={() =>
                      void run(async () => {
                        const result = await request('relay/deliver', {
                          sessionId: session.id,
                          messageId: m.id,
                        });
                        setReceipts((old) => ({ ...old, [m.id]: result }));
                        await refresh();
                      })
                    }
                  >
                    {m.delivery ? 'Check delivery' : 'Ask Muse about this'}
                  </button>
                  <p className="muted">
                    Starts a model turn when this session is idle. Existing approvals are preserved.
                  </p>
                  {(receipts[m.id] || m.delivery) && (
                    <p role="status">
                      {(receipts[m.id] ?? m.delivery).status === 'outcomeUnknown'
                        ? 'Delivery outcome unknown. Inspect the transcript before continuing.'
                        : `Muse command: ${(receipts[m.id] ?? m.delivery).status}. Check the transcript for its response.`}
                    </p>
                  )}
                </>
              )}
            </article>
          ))}
      </div>
      {inbox && !inbox.messages.length && <p>No shared messages yet.</p>}
    </section>
  );
}
