# Changelog

User-visible changes in Lascoria. Detailed development and validation records live in [implementation progress](docs/implementation-progress.md).

## Unreleased

## 0.1.1 - 2026-10-21

First release candidate.

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
