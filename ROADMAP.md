# Roadmap

Updated 4 November 2026, after [v0.1.9](https://github.com/kabudu/lascoria/releases/tag/v0.1.9). The source and binary releases are public. What has shipped, and what is implemented but still incompletely validated, is tracked in the [release-readiness status summary](docs/release-readiness.md#status-summary-4-november).

Everything below is **planned**: a proposal, not available, not scheduled and not authorised for implementation. An item moves into the release-readiness checklist only when it is explicitly scheduled, with its own acceptance criteria. Architecture constraints stay unchanged: the Rust supervisor owns durable control, the official Node SDK worker remains the production Muse integration, and Muse CLI/SDK pins stay exact, are upgraded together and are never auto-updated on a user's machine.

## Git delivery (after D1)

Shipped today: the guarded commit stages every Git-visible change in the session's folder, shows exactly what will be committed and never pushes. Hooks and commit signing are off for that commit. Proposed:

- Choose which files, and which hunks, go into a commit.
- Show and switch branches, with clear warnings before anything changes the working tree.
- Push to a remote and open a pull request, using the user's own Git credentials and hosting account.
- Help with merges and conflicts, without resolving them silently.
- Respect repository hooks and commit signing where the user has set them up.

## Editing and terminal (after D2)

Shipped today: open a session's folder or a changed file in the user's own editor; test commands run in a bounded, non-interactive runner. Proposed:

- An embedded editor for quick changes without leaving Lascoria.
- An interactive terminal tied to a session's folder, with the same process-tree cleanup as test commands. The current runner stays bounded and non-interactive.

## Muse capabilities management (D5)

Shipped today: native skill discovery, selection and requested/observed attribution (R9, still incompletely validated). Proposed:

- Turn skills on or off for the user, a project or a plugin through Muse's native activation controls.
- Browse, install and update plugins and marketplaces, and show which hooks and MCP servers they add.
- Show and change Muse settings that affect sessions, with the same revision and conflict handling as the rest of Settings.

## Windows publisher signing

- Add Authenticode publisher signing for the Windows app and installer, with secure key/service ownership and native validation. Current Windows installers are not publisher-signed; their updater artifacts are signed. Until signing ships, Smart App Control and managed policies that refuse unsigned apps can block installation.

## Other candidates

- A Rust-native Muse protocol adapter, only after it passes the parity gates in the [SDK assessment](docs/rust-sdk-assessment.md). The official SDK stays the production path until then.
- A dependency-aware task scheduler and automatic evidence acceptance, once their meaning and trust boundaries are agreed.
- Optional passphrase encryption for backups and exports (security finding F5).
