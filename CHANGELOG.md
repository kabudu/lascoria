# Changelog

User-visible changes in Lascoria. Detailed development and validation records live in [implementation progress](docs/implementation-progress.md).

## Unreleased

- Keep Archive in the Sessions panel header and hide archived sessions unless Show archived sessions is enabled.
- Prevent workspace labels and session details painting over floating-panel headers.

## 0.1.5 - 2026-10-25

- Update Tokio to address RUSTSEC-2026-0386.

- Add a header shortcut for subscription usage, with current and weekly allowance and freshness information.
- Automatically finish older background-service updates when work is idle, preserving conversations and drafts and offering a retry if needed.

## 0.1.4 - 2026-10-23

- Fix universal macOS update discovery and add a direct macOS Check for Updates menu command.
- Show updates in a focused dialog with a persistent toolbar action and quiet checks every six hours.
- Update a transitive cryptography dependency to address RUSTSEC-2026-0385.

## 0.1.3 - 2026-10-22

- Make token use easier to scan with separate session, task and context figures and an expandable breakdown.
- Add a direct session-archive action in the Sessions panel with confirmation and compatibility guidance.

- Replace notification and background-activity checkboxes with accessible, aligned toggles that remain readable with wrapped labels.

## 0.1.2 - 2026-10-22

- Provide one universal macOS download for Apple Silicon and Intel, including the complete runtime.

### Fixed

- Retry transient macOS installer ticket-verification failures without relaxing signature or notarization checks.

## 0.1.1 - 2026-10-22

Initial release.

### Added

- Spatial workspace with draggable tasks, curved connections, zoom, panning and collapsible panels.
- Muse Code sessions with subscription login, optional API keys, model and effort controls, and reported usage.
- Projects spanning multiple folders, file attachments and local session-to-session messaging.
- An attention queue for questions and permissions, alongside transcripts, diff inspection and revision-bound evidence.
- Editor handoff, isolated task workspaces and optional decision assistance with your own provider keys.
- Checkpoint recovery, Muse onboarding and signed updater support.

### Compatibility

- Targets macOS, Windows and Linux. Windows publisher signing is deferred for the first release; security policies may block unsigned installers.
- Updates pause active work and retain checkpoints. Uncertain actions are not automatically replayed.

See the [release notes](docs/releases/v0.1.1.md) for installation and support information.
