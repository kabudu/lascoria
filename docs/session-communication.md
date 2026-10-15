# Inter-session communication

Status: R16, a first-release requirement requested on 15 October. Not implemented. Independent sessions must not be confused with child agents inside one session.

## Native capability findings

The installed Muse 1.4.9-R6297.1 CLI exposes `session-message list --json` and `session-message send --target ...`, with the message on stdin. The pinned SDK also has owner-to-child `subagent/sendMessage` and `subagent/followupTask`; these are not independent-session transports.

Meta's [session messaging documentation](https://dev.meta.ai/docs/muse-code/session-messaging) limits native independent messaging to eligible interactive sessions for the same user on one macOS/Linux machine. Windows and headless launches are excluded. Native messages do not merge files, transcripts, permissions or ownership. The documented maximum body is 8,192 bytes; duplicate message IDs are deduplicated, and recipient approval can be required.

Offline export from the installed binary (`muse schema generate-json-schema --out .dev/muse-native-schema --experimental`) declares experimental `peerMessaging` and `peer/list`. An isolated two-host echo probe requested the capability, received it, started two sessions and queried peers. The list was empty. The CLI returned `external_agent_ingress_closed`. Capability negotiation and peer discovery alone therefore do not prove eligible send/receive support for Lascoria's `muse serve` architecture. Both probe hosts closed in finally; no message went to a user session.

The user selected an explicit Lascoria-managed relay across all three platforms on 15 October. Implement that relay as the first-release path. Scope is strictly independent Muse sessions managed by this Lascoria supervisor for the same OS user on the same machine. No cross-machine listener, remote transport or cross-user discovery is included. Do not bypass native rollout/platform gates or claim that a queued note is delivered. Native peer integration can be added separately when its target/runtime contract is verified.

## Recommended experience

From a session or its constellation node, **Connect sessions** selects a named recipient and opens a compact conversation. A curved communication link appears only for connected sessions, distinct from parentage/dependency edges. Its activity indicator reveals an unread/update count; clicking it opens the exchange. Do not add a permanent chat panel to every session.

Show source and recipient names, workspace/project scope, the exact content being shared and a plain delivery state. Connect/reply is explicit; users can disconnect or mute. Each message remains attributed to its source session and linked to the relevant task/revision where supplied. A recipient sees peer text as untrusted context, never as system instructions or permission to execute tools.

## Required safety and lifecycle contract

- Distinguish native Muse peer messaging from a Lascoria relay in implementation, diagnostics and support claims. Use an upgraded SDK only after matched runtime/contract and native conformance checks.
- A Lascoria relay needs session identity checks, explicit peer/project scope, durable bounded outbox/inbox records, request IDs, message/queue limits, expiry and loop/rate budgets. No broadcast or automatic cross-project disclosure by default.
- Separate accepted/queued, delivered and read/acknowledged. Unknown outcomes stay unknown and reconcile by identity; never blindly resubmit a turn/model request or assume receipt from an admission acknowledgement.
- Define handling for idle versus active/waiting recipients. Preserve pending approvals/questions and avoid surprise interruption. Any action that starts inference or steers running work must be visible and use the normal supported session command and permission boundary.
- Bound automatic replies, coordination concurrency and token use; handle deadlocks, circular conversations, stale recipients, logout, close, crash and reconnect. A message cannot confer filesystem/tool approval or evidence acceptance.
- Persist source/recipient/provenance safely, without putting credentials or private raw attachments in message metadata. Make selected sharing and deletion/retention policy clear.
- Validate actual independent sessions, both directions and concurrent tasks on all three operating systems. Include unavailable transport, pending peer approval, rejected messages, duplicates, timeout/unknown delivery, agent loops and recovery. A parent/child demo does not satisfy this requirement.
