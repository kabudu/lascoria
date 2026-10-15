# Stage A architecture decisions

Recorded 12 October 2026; updated for Lascoria task workspaces on 15 October 2026.

## Process boundaries

The control plane is Rust, as confirmed during Stage A implementation. It owns the supervisor lifecycle, owner-restricted Unix IPC, client authentication, worker registry, SQLite command journal, and bounded recovery. A shared Node broker owns up to ten independent session contexts, each with an official `@muse-code/sdk` connection and one `muse serve` process. Muse owns execution, durable session logs, writer leases, sandboxing, and permissions.

```text
Diagnostic CLI / Tauri + React + TypeScript desktop client
    authenticated local Unix socket, API version 1
Rust supervisor
    private generation-tagged NDJSON, one shared SDK broker
Node SDK broker (@muse-code/sdk 1.4.9), up to ten contexts
    official MSP connection and authoritative SDK Session fold
Muse Code 1.4.9 (one independent muse serve per session)
    tools, permissions, agent execution and durable logs
```

A diagnostic client disconnect never closes the worker's stdin. An explicit stop identifies all affected sessions, closes their broker contexts and drains Muse through the SDK's shutdown ladder before closing broker stdin. If Rust dies, worker stdin closes and Muse drains or requires recovery. No surviving host discovery is promised: this binary has a single stdio connection and no exposed reattachment endpoint. Sleep suspends local work; logout and reboot require recovery.

The current source checkout is the deployment unit. The default broker and session module are loaded from `src/` next to the Rust crate at build time. `SCH_WORKER` selects a dedicated worker override. A bundled application must replace that path with an installed resource and ship a compatible Node runtime. Tauri/React is implemented in Stage B; signing, an installer and login startup remain later delivery work.

## Protocol and recovery

The public Unix API accepts one bounded JSON request per connection with `version`, `token`, `id`, `operation`, and `params`. Responses contain `result` or `error`. `start`, `turn`, `steer`, `cancel`, `decide`, `answer`, `resume`, `status`, and `stop` are available. Stage C adds `models`, `setModel`, `setEffort` and optional conditional status versions, described in the [memory and settings follow-up](stage-c-memory.md). The worker API is private and not a general MSP proxy.

Rust is the single UUIDv7 command-ID source for these SDK connections. IDs are passed through the SDK's public command override; automatic SDK command retry is disabled. SQLite uses `synchronous=FULL`. The ID, public input, target, operation, and sending status are persisted before dispatch. Requests sharing an ID must have identical semantic JSON input, even across supervisor restart.

Admission is distinct from application. Matching server-authored command facts can mark a command applied. On interruption, unresolved sending/accepted commands become outcome unknown. Recovery can reconcile them from matching authoritative history facts; absent proof leaves them unknown. No external operation is automatically resubmitted. `applied` means the control operation was applied, not that its task passed tests or was accepted by a user. A turn's native terminal is exposed separately in `state.turns`.

On recovery, the worker resumes the durable session, temporarily unsubscribes, pages authoritative history through `view/page`, constructs a fresh SDK fold, and subscribes from its observed last cursor. This uses an explicit paged rebuild instead of relying on snapshot ingestion. The actual binary is required to honor its page and subscription contracts; pruned or oversized history fails visibly. Opening/rebuilding state is not presented as current.

The SDK owns item revisions, duplicate delivery, unknown item kinds, pending approvals, structured questions, and turn state. The supervisor stores a disposable bounded diagnostic snapshot, not a second execution fold. Worker generations prevent an old reader's EOF or late state from replacing a new worker's state.

Approvals are pulled fresh immediately before dispatch. The exact runtime requirement token and an offered choice must match. The same token is sent to Muse to close a stage-advance race. User input is checked against the current pending set, and Muse validates answer contents. Server requests are acknowledged as handled; that acknowledgement never grants permission.

The installed binary aborts a pending approval when its owner connection dies. Recovery shows the interrupted turn and no longer offers the old approval. It cannot keep that decision pending merely because its transcript was durable.

## Bounds and diagnostics

There are at most 10 active and 100 retained sessions, 16 active IPC connections, 16 inbound queued calls, 16 scheduled tasks (including completed tasks awaiting collection), and 2,000 journal records. Each session admits at most four calls including its executing call. Historical command storage is retained until the diagnostic state directory is deliberately replaced; no automated session/worktree deletion is implemented. Two automatic recovery attempts per session are available per supervisor run. An explicit `resume` resets that budget; failure remains visible.

IPC requests are capped at 64 KiB. Worker frames are capped at 4 MiB, stdout buffering at 8 MiB, and stderr tails at 8 KiB. Each worker admits up to 10,000 events and 32 MiB of event content, including provisional deltas; replay admits at most 100 pages of 100 events. Budget exhaustion makes state unavailable and triggers bounded durable recovery. Native stream gaps first use the SDK paged splice on the same host, with a 60-second deadline, 100-page, 10,000-event and 32 MiB budget. Typed read backpressure has at most five attempts; mutating commands are never retried. Failed splice closes the host and invokes bounded durable recovery. Diagnostic snapshots coalesce for 25 ms while retaining command facts, and publish immediately at gap boundaries and command responses. The diagnostic snapshot orders items by native recorded time and item ID so gap splice and cold replay have the same window. It shows the last 100 items and turns, along with item count/truncation indicators. This is not the Stage C 100,000-item history implementation.

Handshake, command, connection, and shutdown waits are bounded. A timed-out worker is stopped rather than receiving more commands. Each session now owns a FIFO command lane, including workspace inspection/mutations and recovery. A slow native call or recovery does not hold another session’s lane. Admission links are established before spawning tasks so executor polling order cannot reorder queued calls. Session creation and global presentation operations share a separate serialized lane; successful starts transfer worker ownership before replying. Commands targeting a published but not yet admitted session receive an explicit refresh/retry error. The shared broker lock covers broker creation/replacement only, not native context handshakes.

Queue overflow is an explicit error, including after an IPC client times out: detached admitted work remains counted. Duplicate in-flight request IDs are rejected globally and can be retried after completion; completed journal receipts retain their existing payload check and no-replay behavior. Automatic recovery only enters idle session lanes and retains the existing two-attempt budget. Status and diagnostics bypass these lanes. Stop drains admitted work, then validates the affected-session list before acknowledging shutdown. SQLite writes still use one short synchronous lock, and broker failure remains a shared failure. These changes prove isolation for the tested workloads, not arbitrary-load latency or the remaining Stage C scale targets.

Local snapshots and journals can contain prompts, tool arguments and outputs. They are private local state, not sanitized export artifacts. No export facility is provided. Credentials remain with Muse. Repository text is emitted as JSON data, never evaluated or rendered as active markup.

## A native Rust SDK after proof

The proposed post-proof option is an owned Rust MSP implementation, not a transcript parser. The third-party `muse-codes` 1.2.1 crate documents `muse exec --json` spawning and captured CLI event models; it does not document the interactive `muse serve` control contract needed here.

Before replacing the official Node worker, a Rust adapter must pass the same public lifecycle suite plus protocol conformance for handshake/capabilities, writer leases, authoritative revisions, gap recovery, snapshots, approval stages, unknown variants, idempotent commands, and host-death durability rules. Keep the Node implementation available as a reference until parity is demonstrated. The decision to build that SDK remains conditional on the concept's usefulness being proven.

References: [official Muse SDK](https://github.com/meta-models/muse-code-sdk), [Rust headless crate](https://docs.rs/muse-codes/latest/muse_codes/), [SDK fold model](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/fold-model/).

[Stage B presentation, evidence and desktop boundaries](stage-b.md) records the new API operations, schema migration and validation.

[Stage C memory and settings](stage-c-memory.md) describes shared-broker recovery, process-scoped RSS and native mid-session model/effort controls. Dedicated workers remain available for diagnostic comparison.

[Lascoria daily coding workflow](daily-coding-workflow.md) adds developer-operated workspace execution, managed Git worktrees and schema-3 archival. These are distinct from Muse execution and human-attested evidence.

## Account coordination

The [account coordinator](accounts.md) owns managed credential selection outside the session journal. Browser login uses app-owned Muse metadata with a potentially shared Muse Keychain credential; API keys use macOS Keychain and enter SDK process environments only in explicitly selected API mode. A persistent official-SDK account host plus bounded background observation outlives GUI windows and individual session hosts. Credential changes drain session work, stop affected hosts and gate recovery; logout is durable and a retained API key never silently reactivates. The experimental account API and provider renewal limits are documented separately from session protocol guarantees.

A [Rust-native SDK assessment](rust-sdk-assessment.md) recommends a measured experimental MSP adapter, with Node retained as the conformance reference. No backend migration is implied by the account flow.
