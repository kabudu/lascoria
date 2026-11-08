# Changelog

User-visible changes in Lascoria. Detailed development and validation records live in [implementation progress](docs/implementation-progress.md).

## Unreleased

## 0.3.0 - 2026-11-08

- Deliver work from an isolated task's Workspace tab with one next step at a time: check the changes, send a failing check to Muse, stage, commit, push and open a pull request. Test results count only for the exact files they ran on. Push and pull requests show the destination, branch and commits first, use your own Git and GitHub CLI sign-in, never force-push and never open a duplicate.
- Make larger maps easier to read: clearer task names, who owns each task, subtasks folded into their task's card, and Next to review (⌘J or Ctrl+J) to go straight to what needs you. Folding never hides work that needs attention.

## 0.2.0 - 2026-11-05

- Stage and unstage whole files or individual hunks in an isolated task's Workspace tab, preview the exact commit content and commit only what is staged; unselected edits stay in the worktree. Actions are refused, with nothing changed, if files or the index changed after the list loaded. Commits still never push and do not run hooks or signing.

## 0.1.9 - 2026-11-03

- Make working tasks and helper agents easier to spot with a moving activity bar; waiting, disconnected and finished nodes stay still.
- Keep long node titles readable with a two-line ellipsis.
- Add visible session-header controls for model/effort and native permission profiles, with confirmed scoped changes and saved defaults for new sessions.
- Separate approval policy from sandbox capabilities, show effective access, and offer an explicit sandbox capability check through Muse.
- Upgrade the pinned Muse CLI/SDK pair to stable 1.4.14 and verify onboarding against the matching vendor manifest and schema.

## 0.1.8 - 2026-11-02

- Connect successive tasks with distinct session-order curves and keep current work easy to reveal.
- Place new task cards in available viewport space around panels, preserve saved positions, and show explicit offscreen navigation.

## 0.1.7 - 2026-10-26

- Hide archived sessions from the canvas and inspector when Show archived sessions is off; switch to unarchived work or show a clear empty state.

## 0.1.6 - 2026-10-26

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
