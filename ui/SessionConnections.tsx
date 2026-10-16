import type { SessionRow, Status } from './types';

function activity(row: SessionRow) {
  if (row.lifecycle === 'archived') return 'Archived';
  if (!row.state.current) return 'Unavailable';
  if (row.state.userInputs?.length) return 'Answer needed';
  if (row.state.approvals?.length) return 'Permission needed';
  return row.state.activeTurnId ? 'Muse working' : 'Idle';
}

export function SessionConnections({
  session,
  sessions,
  connections,
  unread,
  name,
  onOpen,
}: {
  session: SessionRow;
  sessions: SessionRow[];
  connections: NonNullable<Status['relayConnections']>;
  unread: NonNullable<Status['relayUnread']>;
  name: (row: SessionRow) => string;
  onOpen: (peer?: string) => void;
}) {
  const peers = connections
    .filter((c) => c.sessions.includes(session.id))
    .flatMap((connection) => {
      const peer = sessions.find(
        (row) => row.id !== session.id && connection.sessions.includes(row.id),
      );
      return peer
        ? [
            {
              peer,
              agents: connection.allowAgentMessages,
              count:
                unread.find((entry) => entry.sessionId === session.id && entry.peerId === peer.id)
                  ?.count ?? 0,
            },
          ]
        : [];
    });
  const height = Math.max(128, peers.length * 112);
  const ownerY = Math.min(height / 2, 168);
  return (
    <section className="session-connections" aria-label="Connected local sessions">
      <p className="muted">
        Dotted curves show local message connections. Files and permissions stay separate.
      </p>
      {peers.length ? (
        <div className="session-links-scroll" tabIndex={0} aria-label="Scrollable session links">
          <div className="session-links-map" style={{ height }}>
            <svg viewBox={`0 0 360 ${height}`} preserveAspectRatio="none" aria-hidden="true">
              {peers.map(({ peer }, index) => {
                const curve = `M 144 ${ownerY} C 180 ${ownerY + 32}, 180 ${index * 112 + 24}, 216 ${index * 112 + 56}`;
                return (
                  <g key={peer.id}>
                    <path className="session-link-hit" d={curve} onClick={() => onOpen(peer.id)} />
                    <path className="session-link-curve" d={curve} />
                  </g>
                );
              })}
            </svg>
            <div className="session-link-owner" style={{ top: ownerY - 48 }}>
              <strong>{name(session)}</strong>
              <small>
                {session.id.slice(-8)} · {activity(session)}
              </small>
              <small>This session</small>
            </div>
            {peers.map(({ peer, agents, count }, index) => (
              <button
                key={peer.id}
                className="session-link-peer"
                style={{ top: index * 112 + 8 }}
                aria-label={`Open local conversation with ${name(peer)} (${peer.id.slice(-8)}), ${count} new for this session`}
                onClick={() => onOpen(peer.id)}
              >
                <strong>{name(peer)}</strong>
                <small>
                  {peer.id.slice(-8)} · {activity(peer)}
                </small>
                <small>
                  {count
                    ? `${count} new for this session`
                    : agents
                      ? 'Muse messaging enabled'
                      : 'Selected text only'}
                </small>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p>No connected sessions yet.</p>
      )}
      <button className="session-settings-trigger" onClick={() => onOpen()}>
        Connect sessions
      </button>
    </section>
  );
}
