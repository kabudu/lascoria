# Changelog

## Unreleased

- Preserve pair-specific local message drafts across close/restart, compare competing copies and share with atomic, duplicate-safe draft consumption; validate agent relay and live Wonder coordination in the Windows native app.

- Add opt-in session-scoped Muse messaging tools, bounded agent exchanges, peer isolation, revocation and retry reconciliation; retain full platform/lifecycle release gates.

- Add explicit local session connections and selected-text inboxes, with idle-only Muse delivery, bounded durable identities and no automatic model calls or permission sharing. Full agent-to-agent coordination remains a release gate.

- Show readable allowance durations, simplify saved-change and transcript controls, and add explicit UX/DX/language and attachment release gates.
- Resolve competing draft edits with visible comparisons and explicit choices; recover committed saves after lost replies while retaining safe retry identities.

- Add read-only Muse subscription usage and a local `/usage` view, plus session-scoped slash-skill discovery and native typed invocation. Keep observations and explicit skill selection separate from model execution.
- Preserve constellation scene positions and zoom/pan when floating panels expand or collapse, and show a checking state before offering Muse installation.
- Add pinned Muse installation onboarding with verified vendor downloads, progress, cancellation, existing-runtime selection and SDK compatibility checks.
- Package Node, supervisor and official SDK resources independently of the source checkout; add Windows native IPC, protected local state, Credential Manager storage, browser handoff and bounded test-process cleanup; correct Windows resource paths, HTTPS browser handoff and repository labels.
- Persist session drafts with revision checks and retry-safe writes; flush drafts before native close/quit and restore them after reload.
- Show current work, tool activity, pending answers/permissions and reconnecting state directly on constellation nodes, with reduced-motion support.
- Rename the private repository to `kabudu/lascoria`, add native-foundation CI for macOS/Windows/Linux and maintain a release implementation checklist with explicit validation gaps.

- Specify subscription allowance in Settings, a non-interrupting local `/usage` view, and a session-scoped searchable Muse slash-skill picker as release requirements.

- Consolidate release-readiness gates for Muse installation onboarding, signed platform GitHub updates, the planned repository rename, packaging, lifecycle, accessibility and developer/token-efficiency work.

- Gracefully cancel active turns before account host shutdown, retain cancellation evidence across recovery, and verify detached background completion and same-session continuation.
- Add native Muse browser sign-in, subscription-first routing, separate macOS Keychain API-key storage, durable logout and background account observation without automatic paid fallback.
- Keep Bézier connectors visibly curved when nodes are aligned; retain native/user relationship styles.
- Assess a Rust-native interactive MSP adapter for packaging and fault isolation, retaining Node until conformance and live recovery parity pass.

- Isolate session commands and recovery with bounded FIFO lanes; retain serialized session admission, global request-ID protection and durable no-replay semantics. Add a repeatable concurrent Muse trial and native-host isolation coverage.

- Verify native Wonder question/resumption, implementation, diff capture and independent tests using Muse browser-account login; document API-key precedence for subscription trials.

- Adopt Lascoria with a folded-wing mark, lowercase wordmark, porcelain/ink/periwinkle themes, welcome copy and native app icons. Use repository/display names for isolated sessions rather than worktree UUIDs. Preserve existing state and revision identities; new isolated task branches use `lascoria/`.

- Add isolated task worktrees, Git-visible file context, direct streamed test commands, guarded commits/discard and persistent read-only session archives.
- Upgrade the official Muse SDK and strict runtime compatibility pin to 1.4.9 after the installed host's schema advance.
- Use muted indigo for interaction and selection, with separate green success, amber attention and red failure colours.

- Reorganize the light workspace with a persistent compact canvas dock, workspace utilities menu, quieter floating panels, actionable attention and progressive transcript detail.

- Refine inspector spacing and session settings with a labelled effort slider, model-specific defaults and explicit unavailable states.

- Share a bounded Node SDK broker across independent Muse hosts to reduce ten-session control-plane memory; retain visible single-host and broker-wide recovery.
- Avoid repeated idle snapshot allocation with authenticated conditional status reads and unchanged GUI state retention.
- Add catalog-backed mid-session model and reasoning-effort controls with durable native setting commands.
- Measure native GUI and WebKit helper memory alongside the supervisor and SDK, with enforced budget gates.

- Start Stage C with bounded local diagnostics and repeatable runtime and UI projection benchmarks, including resource-budget reporting.
- Add explicit Wonder/Spark selection for new live sessions and authoritative model labels after resume.
- Pin Muse SDK/runtime compatibility to 1.4.8 and keep scripted-provider permission posture deterministic.

- Add trackpad pinch handling, cursor-centred Ctrl/Cmd+wheel zoom and frame-coalesced canvas panning, with floating-panel scroll isolation.

- Add persistent canvas zoom, fit-to-view around floating panels, and direct node dragging with zoom-aware coordinates and keyboard movement.

- Make the constellation a full-window canvas with pointer/keyboard panning and persistent floating, collapsible Sessions, Attention and Task inspector panels.

- Surface native task errors and workflow summaries, reduce routine reminder noise, isolate per-session drafts and bind live sessions to an explicit native catalog model for delegation.

- Review Stage B state races, capture-scoped evidence paging, focused-field persistence, save retries, keyboard tabs and capture limits; validate light mode with automated WCAG checks.
- Add a Tauri/React/TypeScript desktop workflow with a light default theme, task map/list, attention queue, transcript, permission decisions and contextual controls.
- Persist presentation state separately from Muse execution; add immutable Git captures and revision-bound test, review and acceptance attestations with freshness rejection.
- Add native workflow-child projection, bounded transcript/output/diff pages and real Muse UI integration coverage across implementation, testing, review and reopen.
- Migrate the supervisor store to schema 2 and keep snapshot reads available during serialized control operations.

- Add a Rust Stage A supervisor with authenticated Unix IPC, exclusive ownership, a durable command journal, and bounded worker recovery.
- Add an official Muse SDK 1.4.6 Node worker and a diagnostic client for sessions, steering, cancellation, approvals, structured questions, and explicit stop.
- Prove native egress saturation with real Muse gaps, bounded official-SDK splice recovery on the same host, and cold/live projection convergence.
- Add real Muse lifecycle tests and controlled protocol/recovery tests, including uncertain outcomes without duplicate external actions.
- Record actual stdio shutdown and pending-approval recovery limits, the Tauri/React direction, and a conditional native Rust MSP SDK follow-up.
