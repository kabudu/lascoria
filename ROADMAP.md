# Roadmap

Planned after the first public release. Nothing here is available yet or promised for a date; the first release keeps the scope recorded in [release readiness](docs/release-readiness.md). Items move into that checklist only when they are scheduled.

## Git delivery (after D1)

The first release ships the guarded commit: it stages every Git-visible change in the session's folder, shows exactly what will be committed and never pushes. Later:

- Choose which files, and which hunks, go into a commit.
- Show and switch branches, with clear warnings before anything changes the working tree.
- Push to a remote and open a pull request, using the user's own Git credentials and hosting account.
- Help with merges and conflicts, without resolving them silently.
- Respect repository hooks and commit signing where the user has set them up (the guarded commit currently runs Git with hooks and signing off).

## Editing and terminal (after D2)

The first release opens a session's folder or a changed file in the user's own editor. Later:

- An embedded editor for quick changes without leaving Lascoria.
- An interactive terminal tied to a session's folder, with the same process-tree cleanup as test commands. The current runner stays bounded and non-interactive.

## Muse capabilities management (D5)

- Turn skills on or off for the user, a project or a plugin through Muse's native activation controls.
- Browse, install and update plugins and marketplaces, and show which hooks and MCP servers they add.
- Show and change Muse settings that affect sessions, with the same revision and conflict handling as the rest of Settings.

## Other candidates

- A Rust-native Muse protocol adapter, only after it passes the parity gates in the [SDK assessment](docs/rust-sdk-assessment.md).
- A dependency-aware task scheduler and automatic evidence acceptance, once their meaning and trust boundaries are agreed.
- Optional passphrase encryption for backups and exports (security finding F5).

## Windows publisher signing

- [ ] Add Authenticode publisher signing for the Windows app and installer, with secure key/service ownership and native validation. The owner approved unsigned Windows installers for the first release on 21 October; signed updater artifacts remain required. Smart App Control and managed policies that refuse unsigned apps remain an explicit distribution limitation until validated support is available.
