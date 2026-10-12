# Stage B implementation and evidence

Started 12 October 2026. The desktop client is Tauri 2 with React 19 and TypeScript, connected to the Rust supervisor. Light mode is the default, following the implementation direction and user feedback. Dark mode remains an optional preference.

## Requirements inventory

| Requirement | Implemented behaviour and proof |
| --- | --- |
| Concurrent sessions | Session picker and global attention queue; implementation, testing and native workflow review sessions run against real Muse in the UI integration test |
| Task map and equivalent list | Stable native turn/item IDs, labelled derived turn groupings, native workflow children, keyboard node navigation, search and command palette |
| Relationships | Native ownership/delegation edges cite native item identities and revisions; dependency/handoff edges are explicit user assertions, including across sessions |
| Spatial/presentation state | SQLite presentation record with schema and optimistic revision; selection per session, positions, viewport, collapse state, labels, annotations, filters and theme survive reopen |
| Attention | Approvals, questions, unread interruption history even after recovery, native task failures and completed work needing inspection; completion never means verified or accepted |
| Transcript | Last 100-item snapshot and 100-item read pages from the authoritative SDK fold; native revision/source-range/cursor diagnostics and separate provisional text |
| Tool output | Inline runtime output plus guarded 64 KiB stored-output/native-patch pages; unknown kinds render generically as escaped text |
| Diff | Read-only Git capture of HEAD, tracked changes and untracked regular files; immutable fingerprint, diff pages and file contents remain inspectable |
| Revision-bound evidence | Human test/review/acceptance attestations bind to a captured content fingerprint and native source item/revision, including a separate session in the same workspace |
| Evidence freshness | Current-content check when inspecting a capture, repeated every three seconds; edits disable new attestations and mark old evidence stale; server rechecks on save |
| Runtime controls | Start/steer/cancel, actual offered approval choices and structured answers; stale/unavailable state disables mutation; stable request IDs and journal acknowledgement remain visible |
| GUI reopen | Browser integration checks persisted state with the same supervisor; actual Tauri close/reopen retained host generation and pending approval, then produced one approved filesystem effect |
| Supervisor restart | Real supervisor stop/reopen reconstructs the sessions while presentation, artifacts and evidence persist |
| Accessible interaction | Semantic map buttons, equivalent list, labelled forms, native dialog focus, visible focus, keyboard palette/navigation, reduced motion and 200% text-scaling exercise; native macOS accessibility tree inspected |

## Trust and revision model

Muse and its official SDK remain the execution authority. A task grouped by turn is explicitly derived; a native workflow child uses the runtime child ID and attempt within its owning workflow. A child ID is never guessed to be a session ID. Native `childSessionId`, when supplied on a subagent item, enables read-only child transcript inspection. The tested workflow-child envelope supplies outcome and result reference but no child-session transcript ID. Missing worktree or artifact provenance remains unavailable.

Capturing a working-tree diff does not establish that a particular task produced it. The producing-turn association is a user assertion. Each capture stores base/HEAD, unified binary-aware Git patch, untracked-file contents or binary hashes, environment, time and content fingerprint. Actual tracked-file bytes and modes are hashed independently of Git stat caching. Assume-unchanged and skip-worktree files are refused. Capture repeats the read to detect concurrent changes. This detects a changing checkout; it is not an atomic filesystem snapshot or a promise that external writers cannot edit immediately afterwards.

Test records contain an attested command, exit status, time, environment, author and native source revision. Reviews retain reviewer, scope, findings and outcome. Acceptance is a separate record. These are labelled `userAttested`, with revision association explicitly shown as unverified: the harness does not infer a passing test from an agent's message or claim that a source item alone establishes exact revision association. The UI exposes the supporting native output for human inspection. A stale source revision, mismatched outcome/exit status, wrong workspace, provisional source, stale capture or changed retry payload is rejected.

Git captures include Git-visible tracked changes and non-ignored untracked files, not ignored build products, dependencies or an external environment. Content returning to an identical captured fingerprint is current again; this is content freshness, not historical ancestry. Freshness is shown as of its last check. Failed checks leave freshness unknown and disable new records. Immutable old captures and attestations remain inspectable after edits or collapse.

## Local API and bounds

API version 1 gains `transcript`, `output`, `presentation/get`, `presentation/save`, `artifact/capture`, `artifact/check`, `artifact/read`, `review/list` and `evidence/record`. The SQLite schema migrates from version 1 to version 2 by adding separate presentation/artifact/evidence tables. Older Stage A binaries deliberately refuse version 2 instead of silently downgrading the store.

The desktop Rust bridge reads the socket token privately. No token, filesystem execution plugin or generic shell capability is exposed to React. Repository content, patches, tool output and model text render as text; no active HTML or remote embedded content is allowed. Production assets have a restrictive CSP. The test-only diagnostic Rust bridge entry point uses exactly the same socket client as Tauri commands.

Existing Stage A execution limits still apply. Presentation data is capped at 48 KiB, immutable captures at 100, and evidence at 500. Capture requires the repository root as its workspace so patch and file-fingerprint scopes match. A capture allows a 1 MiB tracked patch, 2,000 tracked regular files with a 1 MiB per-file and 16 MiB aggregate fingerprint budget, up to 200 untracked regular files, at most 1 MiB per untracked file and 4 MiB total. Symlinks/special untracked files and paths resolving outside the workspace are refused. Git commands have five-second deadlines and bounded stdout/stderr; review operations have a twelve-second deadline. Evidence source snapshots are capped at 128 KiB. Review listing returns artifact metadata and at most 100 evidence records per page; captured patch/file bytes are fetched separately. Output pages are 64 KiB; formatted diff pages are 200 lines. Runtime mutations remain serialized. Socket acceptance and snapshot reads now remain available while that actor is busy; this is not a claim of independent per-session command scheduling.

## Run and validate

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` builds the supervisor and starts Vite/Tauri. `SCH_PROVIDER=meta` and `MUSE_BIN` are inherited at startup; default `echo` needs no credential. Closing the native window flushes presentation changes and disconnects only the GUI. Explicit stop names every affected session. Failed presentation flush leaves the window open with an error so data loss is visible.

```sh
npm run ui:build
npm run check
npm run check:ui
npm test
npx playwright install chromium
npm run test:ui
```

The browser test scripts only the Tauri invoke transport into the compiled native bridge; the Rust socket, supervisor, SDK, Muse, Git checkout and executed implementation/test commands are real. Its model is scripted loopback, not a paid-provider quality evaluation. The workflow child reports through Muse's actual `submit_result` tool. It checks native child completion, test tool output, evidence rejection and retry semantics, cross-session relationships, escaped malicious-looking file content, persisted light-mode layout, GUI reopen, reduced motion, 200% scaling and supervisor restart. Browser automation complements the separately observed native Tauri workflow; it does not replace native WebView validation.

The desktop development bundle is unsigned and tied to this source checkout, its supervisor binary, Node installation and compatible Muse binary. Distribution, signing, installed-resource paths, login launch and Stage C scale/performance budgets are not delivered here. Automated WCAG A/AA checks, including contrast, pass on the exercised light-mode screen. VoiceOver speech navigation and an exhaustive keyboard/accessibility audit remain release gates. The reviewed implementation is committed and pushed on the Stage B development branch; merge and product release are separate work.

## Validation record

On 12 October 2026 the full execution suite passed ten Node tests, including native saturation and cold/live convergence. A further focused regression verifies single/multiple/free-text answer serialization against the native nested selection contract. The Rust suite passed three tests, including actual Git-content, hidden-index and symlink capture checks. The expanded React/native-bridge/Muse workflow passed, including explicit stop. React production build, supervisor and Tauri builds, both Clippy checks with warnings denied, formatting checks and npm audit passed. No dependency vulnerabilities were reported. Native Tauri close/reopen retained the same supervisor PID and host generation with an unchanged pending approval; resolving it created exactly one filesystem effect. Test-owned processes and repositories were cleaned up.

## Stage B review fixes

The review corrected late transcript responses crossing task selections, empty child pages falling back to parent output, evidence offsets mixing captures, stored-output display surviving an item revision change, and provenance metadata using a different item window after replay. Child stored-output paging is disabled until a native child-output boundary is implemented; inline child transcript content remains inspectable.

Labels and annotations update presentation state on each edit, including while focused. The close flush reads that state synchronously. Presentation saves retain their request ID and payload across an uncertain acknowledgement; the server recognises a retry of the latest committed save and rejects changed retry payloads. A competing client's CAS conflict remains explicit. Mutation dispatch has an immediate guard against duplicate interaction before React renders the disabled state. Inspector tabs support arrow keys, Home and End with associated tab panels.

Git capture rejects a subdirectory workspace and enforces per-file limits after reading as well as before reading. These checks do not turn working-tree capture into an atomic snapshot or a sandbox against a hostile local filesystem writer.

Review validation passed 11 Node tests and four Rust tests, the real Muse/native-bridge UI workflow with light-mode automated WCAG checks, production frontend build, formatting/type checks, both Clippy checks, and the unsigned native development bundle build. The workflow delays a real transcript response while switching sessions and verifies it cannot replace the new selection. It also verifies a focused label persists before blur and a repeated presentation save produces the same acknowledgement. Native saturation again recovered a real gap across 1,536 tool events with generation 1 and exact final text. Full VoiceOver and installed distribution validation remain outside this development-branch proof.

## Native live-provider QA follow-up

A live Meta provider run on 12 October 2026 exercised actual Muse implementation and a structured cancellation question through the native Tauri window. Muse wrote queue.mjs and queue.test.mjs in a separate local demo repository and ran six passing Node tests. Native stored-patch inspection, task labels/annotations, list navigation, working-tree capture and a revision-bound human test attestation were exercised in that window. GUI close/reopen retained the same supervisor and session. A reversible external file edit made the capture stale and rejected new evidence through the public API; restoring the exact bytes restored content freshness.

The first delegated workflows returned a parent-route-unavailable failure. New non-echo sessions now select the provider and unique default model advertised by model/list, recording both on session/start. A later live run completed three native child attempts for test audit, independent review and synthesis, with actual result references and a returned summary. That run was launched through the supervisor public API while the Mac was locked, not through a substitute browser UI. The completed child graph was subsequently inspected in the native window. That inspection exposed clipping in the fixed three-column layout. The rebuilt client uses viewport-fitting default columns and includes pinned-node extents in its canvas. Final inspection of the rebuilt native window confirmed the complete viewport-fitting graph, readable child outcome metadata, disabled child execution controls, editable session display labels and an inspection acknowledgement removing its matching attention entry. A native freshness check showed the stale badge, stale existing attestation and disabled save control after a reversible external edit; restoring the exact file bytes restored freshness.

Authentication remained a separate observed limit: fresh browser sign-in enabled live turns, but later default and explicit-route turns reported missing credentials. This is not classified as a proven expiry or routing defect. A long-running browser-login recovery proof remains outstanding; the native errors are preserved and visible, and Muse manages credentials. A user-supplied local API key was subsequently passed privately to the supervisor environment, with the local credential directory ignored and the file restricted to its owner. A new turn submitted in the native window reached Meta but failed with HTTP 402 billing verification failure. The real failure remains visible in the inspector and attention queue; no new pending model question is claimed. No tokens or provider secrets are exposed to React or included in this record.

The QA findings led to native error guidance, readable returned workflow summaries labelled unverified, native entry IDs used as workflow labels, first-line task labels, user session display labels, explicit inspection acknowledgements, viewport-fitting map columns, optional runtime-reminder inspection, and per-session drafts cleared only after acknowledged dispatch. Completed/cancelled routine reminders no longer flood attention; failed/rejected reminders remain visible. Human attestations remain separate from model-reported workflow results.

Automated validation passed 16 Node tests and four Rust tests, including real native saturation recovery; the expanded UI/native-bridge/Muse workflow passed with catalog-route assertions, full-width default-node bounds, inspection acknowledgements, persisted session labels and per-session draft isolation. Type/build/formatting checks, both Clippy checks and npm audit passed. The rebuilt native app was visually checked in light mode and closed/reopened after flushing presentation state. Session labels, child inspection acknowledgement, retained live history and the billing failure persisted with the same supervisor process. A new paid-provider question remains blocked by provider billing, not by a simulated replacement.

## Live browser-login answer completion

On 12 October 2026, browser login verified Meta model access and the supervisor was restarted without the API-key override. A turn entered through the native Tauri app read queue.mjs and presented a real structured backpressure question. The user selected `Add max depth` in the app. Public supervisor inspection confirmed exactly one applied answer command for that input, native request_user_input completion at revision 2 with the matching selected label, an empty pending-input list and a settled completed turn. The supervisor retained PID 43935 and worker generation 3 across answering and completion. The model acknowledged the decision without modifying files, as instructed; implementing a queue-depth limit is separate work.

Native inspection confirmed the session became idle, the question form and question attention entry disappeared, the completed task appeared in review attention, and the transcript retained both the answered tool output and the model acknowledgement. No runtime correction was required. This proves browser-login continuation after the question remained pending for approximately two and a half hours; it does not establish indefinite credential renewal. The earlier API-key billing failure remains retained history.
