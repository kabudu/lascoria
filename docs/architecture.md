# Stage A architecture decisions

Recorded 12 October 2026.

## Process boundaries

The control plane is Rust, as confirmed during Stage A implementation. It owns the supervisor lifecycle, owner-restricted Unix IPC, client authentication, worker registry, SQLite command journal, and bounded recovery. A per-session Node worker owns an official `@muse-code/sdk` connection and one `muse serve` process. Muse owns execution, durable session logs, writer leases, sandboxing, and permissions.

```text
Diagnostic CLI / Tauri + React + TypeScript desktop client
    authenticated local Unix socket, API version 1
Rust supervisor
    private NDJSON stdin/stdout, one worker per top-level session
Node SDK worker (@muse-code/sdk 1.4.8)
    official MSP connection and authoritative SDK Session fold
Muse Code 1.4.8 (muse serve)
    tools, permissions, agent execution and durable logs
```

A diagnostic client disconnect never closes the worker's stdin. An explicit stop identifies all affected sessions and closes worker stdin; the worker drains Muse through the SDK's shutdown ladder. If Rust dies, worker stdin closes and Muse drains or requires recovery. No surviving host discovery is promised: this binary has a single stdio connection and no exposed reattachment endpoint. Sleep suspends local work; logout and reboot require recovery.

The current source checkout is the deployment unit. `SCH_WORKER` defaults to the worker next to the Rust crate at build time. A bundled application must replace that path with an installed resource and ship a compatible Node runtime. Tauri/React is implemented in Stage B; signing, an installer and login startup remain later delivery work.

## Protocol and recovery

The public Unix API accepts one bounded JSON request per connection with `version`, `token`, `id`, `operation`, and `params`. Responses contain `result` or `error`. `start`, `turn`, `steer`, `cancel`, `decide`, `answer`, `resume`, `status`, and `stop` are available. The worker API is private and not a general MSP proxy.

Rust is the single UUIDv7 command-ID source for these SDK connections. IDs are passed through the SDK's public command override; automatic SDK command retry is disabled. SQLite uses `synchronous=FULL`. The ID, public input, target, operation, and sending status are persisted before dispatch. Requests sharing an ID must have identical semantic JSON input, even across supervisor restart.

Admission is distinct from application. Matching server-authored command facts can mark a command applied. On interruption, unresolved sending/accepted commands become outcome unknown. Recovery can reconcile them from matching authoritative history facts; absent proof leaves them unknown. No external operation is automatically resubmitted. `applied` means the control operation was applied, not that its task passed tests or was accepted by a user. A turn's native terminal is exposed separately in `state.turns`.

On recovery, the worker resumes the durable session, temporarily unsubscribes, pages authoritative history through `view/page`, constructs a fresh SDK fold, and subscribes from its observed last cursor. This uses an explicit paged rebuild instead of relying on snapshot ingestion. The actual binary is required to honor its page and subscription contracts; pruned or oversized history fails visibly. Opening/rebuilding state is not presented as current.

The SDK owns item revisions, duplicate delivery, unknown item kinds, pending approvals, structured questions, and turn state. The supervisor stores a disposable bounded diagnostic snapshot, not a second execution fold. Worker generations prevent an old reader's EOF or late state from replacing a new worker's state.

Approvals are pulled fresh immediately before dispatch. The exact runtime requirement token and an offered choice must match. The same token is sent to Muse to close a stage-advance race. User input is checked against the current pending set, and Muse validates answer contents. Server requests are acknowledged as handled; that acknowledgement never grants permission.

The installed binary aborts a pending approval when its owner connection dies. Recovery shows the interrupted turn and no longer offers the old approval. It cannot keep that decision pending merely because its transcript was durable.

## Bounds and diagnostics

There are at most 10 registered sessions, 16 active IPC connections, 16 queued calls, and 2,000 journal records. Historical command storage is retained until the diagnostic state directory is deliberately replaced; no automated session/worktree deletion is implemented. Two automatic recovery attempts per session are available per supervisor run. An explicit `resume` resets that budget; failure remains visible.

IPC requests are capped at 64 KiB. Worker frames are capped at 4 MiB, stdout buffering at 8 MiB, and stderr tails at 8 KiB. Each worker admits up to 10,000 events and 32 MiB of event content, including provisional deltas; replay admits at most 100 pages of 100 events. Budget exhaustion makes state unavailable and triggers bounded durable recovery. Native stream gaps first use the SDK paged splice on the same host, with a 60-second deadline, 100-page, 10,000-event and 32 MiB budget. Typed read backpressure has at most five attempts; mutating commands are never retried. Failed splice closes the host and invokes bounded durable recovery. Diagnostic snapshots coalesce for 25 ms while retaining command facts, and publish immediately at gap boundaries and command responses. The diagnostic snapshot orders items by native recorded time and item ID so gap splice and cold replay have the same window. It shows the last 100 items and turns, along with item count/truncation indicators. This is not the Stage C 100,000-item history implementation.

Handshake, command, connection, and shutdown waits are bounded. A timed-out worker is stopped rather than receiving more commands. The serialized control actor favors a small, auditable Stage A implementation; long recovery can delay other control calls. Stage B adds paged inspector reads and independent snapshot acceptance. Mutating control work is still serialized; independent session command scheduling remains necessary before claiming scalable interactive performance.

Local snapshots and journals can contain prompts, tool arguments and outputs. They are private local state, not sanitized export artifacts. No export facility is provided. Credentials remain with Muse. Repository text is emitted as JSON data, never evaluated or rendered as active markup.

## A native Rust SDK after proof

The proposed post-proof option is an owned Rust MSP implementation, not a transcript parser. The third-party `muse-codes` 1.2.1 crate documents `muse exec --json` spawning and captured CLI event models; it does not document the interactive `muse serve` control contract needed here.

Before replacing the official Node worker, a Rust adapter must pass the same public lifecycle suite plus protocol conformance for handshake/capabilities, writer leases, authoritative revisions, gap recovery, snapshots, approval stages, unknown variants, idempotent commands, and host-death durability rules. Keep the Node implementation available as a reference until parity is demonstrated. The decision to build that SDK remains conditional on the concept's usefulness being proven.

References: [official Muse SDK](https://github.com/meta-models/muse-code-sdk), [Rust headless crate](https://docs.rs/muse-codes/latest/muse_codes/), [SDK fold model](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/fold-model/).

[Stage B presentation, evidence and desktop boundaries](stage-b.md) records the new API operations, schema migration and validation.
