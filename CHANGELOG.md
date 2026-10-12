# Changelog

## Unreleased

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
