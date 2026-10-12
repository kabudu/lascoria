# Stage A: prove runtime behaviour

Implemented as a Rust control plane with an official Node SDK worker and a CLI. Tauri/React follows in Stage B. This document records the scope and the evidence rather than declaring the full MVP delivered.

## Acceptance inventory

| Requirement | Implementation and verification |
| --- | --- |
| Start a session in an existing local repository | Rust registry and one worker/host per session; real-binary lifecycle test |
| Start, steer, cancel with supported controls | Exact-turn guards; real Muse acknowledgement and native cancellation terminal |
| Approval decisions | Offered choices, current requirement token, fresh pending query; real tool effect checked exactly once |
| Structured user decisions | Current user-input ID; real Muse question and answer settlement |
| GUI-equivalent disconnect | Each diagnostic socket closes; running turns and pending decisions remain in the supervisor-owned host |
| Durable resume | Real shutdown/reopen and authoritative paged history reconstruction; cold and live item projections compared |
| Host crash | Actual Muse process receives SIGKILL; classified interruption retained and durable state recovered |
| Supervisor restart | Actual Rust process receives SIGKILL; old connection drains, new process reloads registry and resumes |
| Duplicate delivery | SDK fold regression verifies duplicate/stale revisions; public repeated request ID is tested against Rust and real Muse |
| Uncertain command outcome | Controlled worker performs an action then withholds acknowledgement; Rust is killed; retry returns unknown and action count stays one |
| Stale approval | Old stage and post-restart aborted request are rejected; pending choices are not invented |
| Writer lease contention | Second real host's resume is refused with `sessionInUse` |
| SDK mismatch | Injected incompatible host fingerprint is refused before a session opens |
| Durability posture | Real ephemeral handshake and unknown-profile SDK regression; Rust refuses unfamiliar recovery |
| Stream gaps | Actual native egress saturation produces `view/gap`; SDK paged splice repairs the live projection on the same host, followed by cold replay convergence |
| Bounded recovery | Controlled resume refusal stops after two attempts; interrupted/error state remains visible |
| IPC ownership/authentication | Private directory/socket/token; Rust peer UID check and OS lock; wrong token and duplicate supervisor tests |
| Explicit quit-and-stop | Exact affected-session set required; controlled IPC test proves stop and refusal for a stale set |
| Version/capability diagnostics | Server identity, schema fingerprint, granted capabilities, durability, command results and interruption history exposed by status |

## Actual runtime findings

The tested binary is Muse Code 1.4.6 (1.4.6-R6000.1), with SDK 1.4.6. The served schema fingerprint is `sha256:eae467ab60cb9a5d5af4de616830f065e59375c987fd59269c8cc33ed2a1137f`. The default handshake declares durable sessions and grants no optional capabilities. The service currently uses stable core methods only. The reference environment is macOS arm64, Node 24.17.0, and Rust 1.97.0.

Closing a diagnostic client leaves Muse executing because Rust continues to own the Node worker. Killing a Muse host recovers its durable view, not its uninterrupted execution. Killing the supervisor causes stdio-owner loss. In the observed approval scenario Muse aborts the decision/tool and produces a cancelled turn; recovery removes that approval and rejects later attempts to answer it. The approved tool is never rerun by recovery.

A recovered command can be marked applied only when matching runtime history proves it. An external action without such a fact stays outcome unknown. Retrying that request ID returns the saved uncertainty instead of dispatching another operation. A new request ID is a new command and must not be used to disguise a retry of an uncertain effect.

## Reproducible evidence

Run `npm ci`, `npm run check`, and `npm test` with Muse 1.4.6 installed. The Rust unit tests check stale worker generations and authoritative reconciliation. Node tests exercise the Rust public API, the official SDK, and the actual binary. The real-binary lifecycle test uses a scripted loopback model with isolated Muse data and verifies a filesystem artifact independently of agent text. It includes an approval, a user-input question, real crashes, and live/cold projection comparison.

The lost-acknowledgement and retry-exhaustion tests are control-plane integration tests using a deliberately faulty worker. The mismatch and fold-gap tests are protocol fixtures. They complement the real-binary tests; the separate saturation test exercises actual native egress and durable history with a scripted provider. Tests fail when Muse is missing or incompatible instead of silently skipping required runtime proof.

Final verification on 12 October 2026 passed eight Node tests and two Rust unit tests, using `MUSE_BIN=<absolute path to Muse 1.4.6-R6000.1> npm test`. `npm run check`, `npm audit --omit=dev`, staged whitespace checks, and tracked-text secret/em-dash scans passed. The native proof observed a gap from the empty cursor to cursor 4055, restored current state on generation 1, made exactly 26 scripted model calls, and passed cold/live item-count, item-payload and session-state comparisons. All test-owned processes were stopped. This branch is a Stage A diagnostic implementation; no merge or product release is included.

## Native saturation proof

`test/saturation.test.js` executes 1,536 actual `update_plan` calls in 24 model batches of 64. The loopback model scripts responses, but Muse executes the tools, persists the session and produces the MSP stream. A test-only byte-forwarding proxy pauses reads from the actual host stdout and issues one native history subscription from the empty cursor. The native replay overruns the host egress queue and emits `view/gap`. The proxy records and forwards those native bytes; it never manufactures a gap or item event.

The worker exposes a non-current projection during the gap. The official SDK pages and splices missing history, then exposes current state on the original worker/host generation. The test checks the native gap bounds, unchanged overlapping item revisions, item count, completed workload turn, exact subsequent response text, stable command-ID retry, and absence of extra model calls. An explicit durable resume then reconstructs the same items and session-state families from native history. This is native transport/recovery evidence with a scripted model, not paid-provider reliability or a UI performance benchmark.

An exploratory workload containing all 1,536 tool calls in a single model response caused the installed binary's `view/page` to return internal `view range read failed`, even before saturation. Splitting the workload into 64-call responses makes history readable and permits the recovery proof. Native history-read failures remain a runtime limitation: the harness keeps the projection unavailable and exhausts its bounded recovery attempts rather than presenting invented current state. The SDK upgrade alone does not promise to repair every native history failure.

## Review record

The implementation review covered state consistency, concurrency and size bounds, IPC ownership, command replay, compatibility, shutdown, test failure paths and documentation. Fixes preserve SQLite registry ordering, old-worker interruption facts and startup EOF facts; stop workers after incomplete reconstruction; validate stop/resume payloads before changing lifecycle state; preserve authoritative command application on lost replies; and bound detached-service readiness. The streaming review added coalesced snapshots with retained command facts, bounded SDK gap reads and read-only backpressure retries. The cold-replay check also identified SDK insertion-order differences after gap splice; diagnostic item windows now use native recorded time and item ID. No mutating retry was added.

## Scope still outside this spike

No graphical client, presentation store, task map, relationship/evidence review model, or 100,000-item browser is implemented. Those are Stage B/C requirements. Login launch, distributable resources, signed packaging, accessibility, provider/network failure beyond the loopback fixture, and actual production resource targets require later validation. The saturation proof covers a bounded diagnostic corpus, not Stage C scale.

All session logs remain Muse-owned. The harness does not resume ephemeral/unfamiliar sessions, replay tool side effects, bypass permission policy, merge changes, or delete worktrees.
