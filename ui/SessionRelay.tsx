import { useEffect, useState } from 'react';
import { request } from './api';
import type { useDurableDrafts } from './useDurableDrafts';
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
  viewedAtMillis?: number;
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
  draftStore,
  draftsEnabled,
  viewsEnabled,
  initialPeer,
}: {
  session: SessionRow;
  sessions: SessionRow[];
  labels: Record<string, string>;
  draftStore: ReturnType<typeof useDurableDrafts>;
  draftsEnabled: boolean;
  viewsEnabled: boolean;
  initialPeer?: string;
}) {
  const [inbox, setInbox] = useState<Inbox>();
  const [peer, setPeer] = useState(initialPeer ?? '');
  const draftKey = `${session.id}:${peer}`;
  const text = draftStore.drafts[draftKey] ?? '';
  const conflict = draftStore.conflicts[draftKey];
  const setText = (text: string) => draftStore.setDrafts((old) => ({ ...old, [draftKey]: text }));
  const [allowAgents, setAllowAgents] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<Record<string, Json>>({});
  const name = (id: string) => labels[id] || `Session ${id.slice(-8)}`;
  // What the other session can see: its Project and folder count, or its one folder.
  const scope = (s: SessionRow) =>
    s.projectContext
      ? `Project ${s.projectContext.name}, ${s.projectContext.folders.length} ${s.projectContext.folders.length === 1 ? 'folder' : 'folders'}`
      : s.workspace;
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
  const connection = inbox?.connections.find((c) => c.sessions.includes(peer));
  const active = Boolean(connection?.active);
  const toolsReady = Boolean(
    session.state.relayToolsAvailable &&
    sessions.find((s) => s.id === peer)?.state.relayToolsAvailable,
  );
  const received =
    inbox?.messages.filter((m) => m.to === session.id && (!peer || m.from === peer)) ?? [];
  const unviewed = received.filter((m) => !m.viewedAtMillis);
  return (
    <section className="session-relay" aria-label="Local session messages" aria-busy={busy}>
      <p>
        Share selected text with another Muse session on this computer. Files, permissions and
        conversation history stay separate.
      </p>
      {viewsEnabled && received.length > 0 && (
        <div className="relay-actions">
          <span role="status">
            {unviewed.length} new {unviewed.length === 1 ? 'message' : 'messages'}
          </span>
          <button
            disabled={busy || !unviewed.length}
            onClick={() =>
              void run(async () => {
                await request('relay/markViewed', {
                  sessionId: session.id,
                  messageIds: unviewed.map((m) => m.id),
                });
                await refresh();
              })
            }
          >
            Mark messages viewed
          </button>
          <p className="muted">
            Viewed means reviewed in Lascoria. It does not mean Muse has received the message.
          </p>
        </div>
      )}
      <label>
        Other session
        <select
          value={peer}
          disabled={busy}
          onChange={(e) => {
            setPeer(e.target.value);
            setAllowAgents(false);
          }}
        >
          <option value="">Choose a local session</option>
          {sessions
            .filter((s) => s.id !== session.id && (s.lifecycle !== 'archived' || s.id === peer))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {name(s.id)} · {s.id.slice(-8)}
                {viewsEnabled && inbox
                  ? ` · ${inbox.messages.filter((m) => m.from === s.id && m.to === session.id && !m.viewedAtMillis).length} new`
                  : ''}{' '}
                · {scope(s)}
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
          disabled={busy || !peer || !inbox}
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
      {peer && connection && !draftsEnabled && (
        <p>Reconnect with the current Lascoria runtime to compose saved messages.</p>
      )}
      {peer && connection && draftsEnabled && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (!active) throw new Error('Reconnect these sessions before sharing.');
              await draftStore.flushDrafts();
              const saved = draftStore.savedDraft(draftKey);
              if (!saved?.requestId || saved.text !== text)
                throw new Error('Draft changed; review it before sharing.');
              await request(
                'relay/send',
                {
                  sessionId: session.id,
                  peerId: peer,
                  body: saved.text,
                  draftRevision: saved.revision,
                },
                saved.requestId,
              );
              await draftStore.reloadDrafts();
              await refresh();
            });
          }}
        >
          <label htmlFor="relay-message">Message</label>
          <textarea
            id="relay-message"
            value={text}
            maxLength={8192}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="muted">
            Only this text is shared. Sending to the inbox does not call a model.
          </p>
          {conflict && (
            <section aria-label="Message draft conflict">
              <p>Another window saved a different message. Compare both copies before sharing.</p>
              <strong>Your draft</strong>
              <pre className="relay-body">{text}</pre>
              <strong>Saved draft</strong>
              <pre className="relay-body">{conflict.text}</pre>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => draftStore.resolveConflict(draftKey, 'mine'))}
              >
                Keep my draft
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => draftStore.resolveConflict(draftKey, 'saved'))}
              >
                Use saved draft
              </button>
            </section>
          )}
          <button
            disabled={
              busy ||
              !active ||
              Boolean(conflict) ||
              !text.trim() ||
              new TextEncoder().encode(text).length > 8192
            }
          >
            Share message
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
              {viewsEnabled && m.to === session.id && (
                <p className="muted">{m.viewedAtMillis ? 'Viewed in Lascoria' : 'New message'}</p>
              )}
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
