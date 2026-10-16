# Inter-session communication

Status: R16, a first-release requirement requested on 15 October. Initial user-directed local relay implemented; full release gate remains open. Independent sessions must not be confused with child agents inside one session.

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

## Implemented local inbox and explicit delivery

The Rust supervisor owns the relay in its existing private SQLite journal and owner-authenticated Unix socket / Windows named pipe. There is no network listener, machine discovery, user directory, external messaging service or cross-user transport. Only session IDs in this supervisor registry are eligible.

From **Workspace menu → Local messages**, select another local session, connect explicitly and share selected text. Sharing stores it in the local inbox without calling a model. The recipient can choose **Ask Muse about this** to start a normal Muse turn when idle. It does not steer active work, answer questions or approve tools. Replies remain in that session's transcript; the user must explicitly select and share any reply. This user-directed path labels messages user-originated; the separate Muse tool path retains agent attribution.

Protocol v1 adds the optional `localRelay` feature and these owner-authenticated operations:

| Operation | Input | Behaviour |
| --- | --- | --- |
| `relay/get` | `sessionId` | Connections and messages involving this session only; indexed journal delivery receipts where present. |
| `relay/connect`, `relay/disconnect` | `sessionId`, `peerId`, `expectedRevision` | Atomic revision-checked pair selection; stale choices fail and require refresh. Disconnect affects subsequent admission, not already admitted model turns. |
| `relay/send` | `sessionId`, `peerId`, `body`; stable request ID | Atomic inbox insertion; identical retry returns the original message even after disconnect; changed payload reuse fails. |
| `relay/deliver` | Recipient `sessionId`, `messageId` | Explicit model call with untrusted peer-context attribution; uses stable `relay_<messageId>` command identity, ordinary account/session/idle checks and native permissions. Repeated or uncertain requests reconcile that command instead of dispatching another turn. |

Limits: 8,192 UTF-8 bytes per message, 20 new messages per sender per minute, 128 retained pairs, 256 retained messages globally, 24-hour admission expiry. Bounds reject new work rather than silently discard history. At most about 2 MiB of message bodies is retained in the atomic relay record; no automatic polling, fan-out or paid replies occur. The existing 16-work-item admission and 2,000-command journal limits still apply. Normal backups/retention remain an R5 release dependency.

An inbox entry means **saved locally**, not seen by Muse. A command receipt records admission/execution facts with the existing `accepted` / `applied` / `rejected` / `outcomeUnknown` vocabulary; it does not establish that the model read or understood a message. Transcript/native turn completion is the independent observation. Reservations are durable under the same lock as connection validation; a crash between reservation and dispatch cannot trigger a replay. The UI now saves pair-specific drafts and consumes them atomically when sharing. Exact saved-draft identity reconciles uncertain sends across close/restart; newer drafts are retained.

Remaining R16 work: full lifecycle/platform validation of agent send/receive tools, curved communication links, unread/acknowledgement semantics, complete lifecycle coverage, communication presentation, and Linux native acceptance. This increment must not close the whole R16 gate.

## Validation for the initial increment

The native macOS release bundle ran two independent browser-authenticated Muse Wonder sessions. The user-directed exchange went both ways: a bounded-inbox proposal and an independent review of silent eviction. Both turns completed in their own transcripts. A final rebuilt-bundle check pasted and read back exactly 738 bytes, completed with `LASCORIA_RELAY_FINAL_OK`, displayed the concise generated task title and reconciled the same command identity without another model call. QA used its own state directory; the original user's pending question was preserved. Local evidence is retained under `.dev/backlog-native/relay-*-proof.json` and native screenshots, excluded from source control.

Validation passed eight Rust tests, 31 Node integration/unit tests, five Playwright workflows, formatting/type/Clippy checks and Windows supervisor cross-compilation. After the final title/reconciliation review fix, the four affected lifecycle/account/relay/scheduling integration cases and the relay UI workflow passed again. Windows/Linux native relay execution is not established by cross-compilation. No hosted CI ran while the repository remains private, per the user's instruction.


## Session-scoped Muse tools

The agent increment uses Muse's negotiated `sessionMcp` capability. Each session gets a Rust stdio helper exposing `local_peers`, `read_messages` and `send_message`. The helper binds its owning session at launch; model arguments cannot replace that identity. It connects to the existing owner-authenticated local IPC endpoint and never starts a model turn or modifies peer permissions.

Agent access is off by default. Users explicitly enable it when connecting a pair; changing the selected peer resets that choice. Existing pairs require disconnect/reconnect to change access. Native Muse tool approval still applies. Disconnect revokes new reads and sends immediately; an exact retry can reconcile an already stored message without creating another message. An enabled connection permits eight agent messages total across both directions. Only another explicit user connection can renew that budget. Reads return one non-expired peer message per page and a continuation cursor; no background polling or automatic replies occur.

Messages retain user/agent attribution. Agent text is untrusted peer context and cannot approve tools, transfer filesystem authority or accept evidence. Sharing and model receipt remain separate states. Helpers use bounded line/IPC sizes and ten-second IPC deadlines. On macOS, the dedicated helper resolves its own state directory then uses a relative socket path, preventing canonical `/private/var` aliases from exceeding Unix socket limits; the Muse workspace and supervisor working directory are unchanged.

Controlled-provider integration has proved real Muse tool execution in both directions, native approvals, third-session isolation, spoofed-owner rejection, quotas, revocation and exact retry. Native macOS live Wonder sessions also exchanged a proposal and independent review through these tools, with successful read/send results inspected in the app. Windows native proof is recorded below; Linux acceptance and broader lifecycle proof remain open gates. This is not completion of R16.


## Durable message composition and Windows evidence

The optional protocol-v1 `relayDrafts` capability adds `relay/draftsGet` and `relay/draftSave`. The UI only offers saved composition when this capability is present. Each source/recipient direction has a separate revision-checked draft, limited to 8,192 UTF-8 bytes. A draft requires a previously connected pair; the 128 retained-pair bound permits at most 256 direction drafts, about 2 MiB of body text in addition to the inbox bound. No new model tool can access drafts.

The shared draft hook saves after a short debounce, flushes on native close and presents competing copies explicitly. It also detects a saved copy that arrives after typing has begun. Unresolved conflicts remain reachable from the header's Review drafts action even after closing the conversation. Before sharing, the UI flushes the exact draft and uses its persisted request identity as the message identity. Rust checks that identity, text and revision, then atomically records the inbox message and clears only that revision. An identical retry returns the original message and cannot erase a newer draft. A failed admission retains the draft. An incompatible older supervisor can still display messages but cannot offer this composer.

The Windows x64 installed-resource test executes through actual named pipes, the packaged Node/SDK and vendor Muse. It proves agent messaging in both directions, isolation, opt-in, spoof rejection, message budgets, revocation and exact retry, then restarts the supervisor, resumes both sessions, checks retained drafts/revocation and reconciles an atomic user send. The revised test passed on the laptop in 72.5 seconds, including endpoint-protection scanning; no exception or protection change was made.

A separate native Windows trial used the existing subscription login and Muse Wonder. Two independent sessions exchanged a proposal and critical review through session-scoped tools; the source read and summarised the reverse review with WINDOWS_REVIEW_RECEIVED. Restarting the QA supervisor and resuming both sessions retained both messages and completed transcripts. The final installed Windows build restored an exact unsent draft after native window close and supervisor restart, shared it once with user attribution, and cleared the composer. Disconnected-pair draft conflicts remain reviewable; archiving first flushes drafts. Linux native acceptance, unread/communication-link UX and the complete lifecycle/security/resource matrix remain open.


## Local viewed-message receipts

The optional `relayViews` capability adds owner-authenticated `relay/markViewed` with a recipient `sessionId` and 1 to 256 exact `messageIds`. Every identity must belong to a message received by that session; validation completes before any write. An invalid identity rejects the whole batch. Only those messages gain a persisted `viewedAtMillis`; later arrivals remain new. Repeating the action preserves the original timestamp without another revision/write. This presentation acknowledgement does not dispatch a turn, confer permissions or claim Muse read the message. Agents cannot access this UI-only operation.

The conversation shows new-message counts for its selected peer (or all received messages when no peer is selected), an explicit **Mark messages viewed** action, and per-message local view state. Refresh remains explicit; there is no additional background polling or model call. Older supervisors without the capability retain the prior conversation UI. The existing 256-message global bound limits additional storage to one timestamp per message and limits validation to at most 65,536 identity comparisons. Read markers are not network read receipts. Spatial links, global unread navigation, Linux native acceptance and the complete R16 lifecycle matrix remain separate gates.


## Repeatable installed-resource runtime test

After building the debug supervisor and staging the runtime with the tested platform Node and SDK:

```sh
node scripts/package-runtime.js --debug
node scripts/package-native-qa.js
LASCORIA_RELAY_APP="$PWD/.dev/native-qa" node --test .dev/native-qa/testing/relay-agent.test.js
```

Set `MUSE_BIN` to the compatible vendor Muse binary. The test uses a local controlled provider and isolated temporary state, not a subscription or paid API key. The same portable test is included in the Windows QA package. Ubuntu 26.04 ARM64 with Rust 1.97.0, Node 24.17.0 and Muse 1.4.9-R6297.1 passed the packaged test in 20.5 seconds, including restart, drafts and viewed-state retention. This is native-OS runtime integration evidence; it does not establish Tauri desktop interaction or live-provider acceptance on Linux.


## Finding new local messages

The optional protocol-v1 `relayUnread` capability adds `relayUnread` to a full status snapshot: an array of `{sessionId, peerId, count}` grouped by recipient and sender. Counts cover retained messages without a local viewed receipt, including expired or disconnected exchanges that still need review. Expiry continues to govern model delivery separately. There are at most 256 messages; the summary contains no body text, performs no writes and uses the existing versioned status refresh. Unchanged snapshots skip the summary read.

When new messages exist, the workspace header shows one compact entry. It opens a keyboard-accessible list with recipient, sender, stable short IDs and counts, then opens the exact conversation. Archived recipients remain reviewable. Opening neither marks messages viewed nor calls Muse; use the existing explicit actions for those separate decisions. Older supervisors omit the optional field and retain the existing Local messages menu. Curved spatial communication links and the full native platform matrix remain open.
