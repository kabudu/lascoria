# Lascoria release-readiness backlog

Updated 15 October 2026. This is the consolidated product/release backlog, not a claim that Lascoria is ready to distribute. Historical validation records remain in the stage documents. An unchecked item is planned or outstanding; checked implementation elsewhere does not close a release gate without its acceptance evidence.

The user requested missing-Muse onboarding, in-app update checks backed by platform GitHub Releases, and renaming the repository to `lascoria`. This change records those requests; it does not install software, rename/publish the repository, publish releases or enable an updater.

## Release blockers

### R1 — Detect and install Muse during onboarding

- [ ] Before account onboarding, distinguish missing Muse, incompatible Muse, launch failure and ready state. Resolve binaries reliably from a GUI launch without relying on an interactive shell's PATH; support choosing an existing installation.
- [ ] Explain that Muse is required and offer **Install Muse**, **Choose existing installation**, **Retry** and **Later**. Later permits offline inspection and returns to setup before new model work. Installation requires the user's explicit action.
- [ ] Use Meta's official installation/distribution mechanism and verify the resulting binary/version and MSP handshake against Lascoria's tested SDK/schema compatibility. Do not blindly install the newest Muse while the adapter only accepts a pinned version. If a compatible version cannot be installed through a supported vendor path, explain the incompatibility rather than bypassing the check.
- [ ] Show progress, bounded waits, cancellation and actionable network/disk/permission errors. Retry safely after partial installation. Do not expose arbitrary execution to React, overwrite an existing installation without consent, or replace a binary used by active tasks.
- [ ] Record whether Muse is user-managed or installed through Lascoria. Keep Muse upgrades separate from Lascoria upgrades and require compatibility validation before offering them; respect shared CLI credentials and other Muse clients.
- [ ] Validate on a clean account with no Muse, an existing supported installation outside shell PATH, an incompatible installation, offline/cancelled/partial setup, and installation followed by browser login and a live task.

Reference: [official Muse installation documentation](https://dev.meta.ai/docs/muse-code). Verify current vendor installation, integrity and redistribution terms when implementing; do not turn this backlog into an unverified shell-installer recipe.

### R2 — Make the download self-contained and define supported platforms

- [ ] Package the Rust supervisor, frontend assets and official SDK worker resources with installed-resource paths. Bundle or explicitly provision the required Node runtime; a normal user must not need Rust, npm, Node development setup or this source checkout. Muse setup is covered by R1.
- [ ] Decide and publish an OS/architecture matrix. Current implementation is macOS-specific (Unix IPC, process control and Keychain). Assess Apple Silicon and Intel macOS separately; Windows/Linux builds require actual IPC, credential-storage and process-lifecycle ports and validation before being advertised. Tauri build targets alone are not platform support.
- [ ] Preserve stable application/state identities through branding and updates, or provide a tested migration. The repository rename must not reset accounts, sessions, worktrees, evidence or update identity.
- [ ] Produce signed application/installer artifacts, macOS notarization where applicable, updater signatures, dependency/license notices and version/provenance metadata. Keep signing keys in release infrastructure, never in source or downloadable apps.
- [ ] Validate fresh install, launch, permissions, uninstall/retained-data behaviour and reinstall on every advertised platform/architecture without developer tools installed.

### R3 — In-app updates from GitHub Releases

- [ ] Add **Check for updates** in Settings/About and bounded automatic startup/periodic checks with a user preference, no overlapping requests, timeouts and backoff. Show installed/latest version, last successful check, release notes, up-to-date, offline and failure states. Checks use ordinary networking, never model calls.
- [ ] Use the supported Tauri updater with signed platform/architecture artifacts and a release manifest hosted through GitHub Releases. Verify signatures before installation and reject wrong-target, tampered or incompatible artifacts. Keep stable and prerelease selection explicit; do not silently move stable users to prereleases.
- [ ] Download with progress/cancellation and offer explicit **Install and restart** or **Later**. Automatic checking does not imply forced installation or interruption of active work.
- [ ] Coordinate the UI, Rust supervisor, Node worker and Muse compatibility as one versioned contract. A compatible UI-only replacement may retain the background supervisor; an incompatible/runtime update must wait until idle or obtain consent to gracefully stop active turns, persist state, stop the old supervisor and recover after replacement. Never spawn two writers or keep an obsolete worker alive against replaced resources.
- [ ] Preserve account policy, inactive API keys, drafts once durable, worktrees, sessions and evidence. Validate migrations and a recoverable failed-update path. Do not promise binary downgrade when a newer database schema refuses it; backup/restore and rollback policy must agree.
- [ ] CI builds/tests each supported target, creates signed updater artifacts and publishes versioned GitHub releases/manifests only after gates pass. Anonymous public installs must not contain a GitHub personal access token; public availability is a separate release step while this repository remains private.
- [ ] Exercise real packaged N-to-N+1 install, idle and active-session update, question/approval waiting states, UI reopen, interrupted download/install, invalid signature, unavailable GitHub/rate limits, incompatible supervisor, migration failure and unsupported target. Verify no command/tool replay and correct restored progress.

Reference: [Tauri v2 updater](https://v2.tauri.app/plugin/updater/) supports signed update artifacts and static manifests on GitHub Releases. Lascoria has not integrated it yet. Existing live UI-close/reconnect and graceful-logout proofs in [accounts](accounts.md) are prerequisites, not an update-install proof.

### R4 — Repository rename and public-release preparation

- [ ] Rename `kabudu/spatial-constellation-harness` to `kabudu/lascoria`, checking target availability immediately before the operation. Update and verify local origin, package metadata, README links, issue/repository URLs, CI, badges and future release/updater endpoints. Preserve Git history and verify fetch/push against the renamed repository.
- [ ] Keep existing application identifiers, persistent state paths, task branches and evidence fingerprints compatible unless a separate migration is implemented. Renaming the local checkout is optional and must not break installed/development resource paths.
- [ ] Before making the repository public, review tracked files and history for credentials/private data, licensing/redistribution rights, security reporting, support expectations and contributor guidance. Keep local `.dev` credentials and live transcripts excluded. A rename is not authorization to make the repository public.
- [ ] Add reproducible CI/build/release instructions, supported versions, changelog/tag policy, artifact checksums/provenance and clean-machine installation documentation. Publish only the targets that passed R2/R3.

### R5 — Durable data, authentication and lifecycle acceptance

Implemented foundations: browser subscription priority over a saved API key, Keychain storage, app-local logout, bounded graceful cancellation with retained evidence, detached UI background execution and same-session recovery. See [accounts](accounts.md).

- [ ] Validate browser authentication/expiry/revocation across real provider expiry intervals, sleep/wake and network loss; show reconnect without automatic paid fallback. Do not promise indefinite provider authorization.
- [ ] Make task drafts durable across window closure/update; preserve per-session targeting and provide a visible recovery path for interrupted work. Current drafts are in-window only.
- [ ] Define backup/export/restore, schema migration and safe local-data cleanup/retention. Current bounds include 100 retained sessions and 2,000 journal records; exhaustion needs an actionable product flow before sustained release use, without weakening no-replay guarantees.
- [ ] Run packaged lifecycle tests for long-running commands, subagents, outstanding questions/approvals, sign-out, window quit, supervisor replacement, crash, sleep/wake and restart. Distinguish confirmed cancellation, natural completion and uncertain outcomes; retain worktree edits and never silently rerun side effects.

### R6 — Finish Stage C performance and usability evidence

- [ ] Close the remaining real retained-history/update-burst gates and repeat reference measurements, including the GUI and full runtime tree with documented Muse/Node/build versions. Synthetic 100,000-item rendering is not real Muse/SQLite history-scale proof.
- [ ] Revalidate sustained memory/CPU/latency budgets with account observation and packaged binaries; add repeatable regression gates. Short smoke runs do not substitute for the required observation period.
- [ ] Conduct comparative developer trials on realistic concurrent coding tasks: time to notice attention, inspect evidence, make a correct decision and finish/review work, plus voluntary repeat use. Record adoption evidence separately from scripted tests.

Source: [Stage C](stage-c.md) and its [memory follow-up](stage-c-memory.md). Historical failed measurements remain historical; this checklist does not reopen already-fixed memory defects without new evidence.

### R7 — Accessibility, reliability and user-facing failure states

- [ ] Complete native VoiceOver and keyboard-only journeys, focus restoration, zoom/text scaling, supported window sizes and both themes. Existing automated WCAG checks are a foundation, not a full native accessibility audit.
- [ ] Test unavailable Muse/runtime, authentication, permissions, network failures, disk-full/locked Keychain, malformed/incompatible history and exhausted resource limits with clear recovery actions and no secret-bearing errors.
- [ ] Add privacy-safe diagnostic export/support information with explicit preview/redaction boundaries. Define log retention and ensure installed builds do not depend on ignored development artifacts.

## Developer-workflow priorities to scope before calling it a daily-driver release

These are known gaps from [daily coding workflow](daily-coding-workflow.md), not promises that every feature must ship in the first public preview. Decide an explicit preview scope and label unsupported actions rather than hide them.

- [ ] **D1 — Git delivery:** selected-file/hunk staging, branch visibility, push, PR creation, merge/conflict handling and applicable repository hooks/signing. Current guarded commit stages all Git-visible changes and does not push; the UI must make those limits clear.
- [ ] **D2 — Editing and terminal:** open in the user's editor, file/diff navigation and a defined interactive-terminal story. An embedded editor/PTY is an option; the present runner is bounded and non-interactive.
- [ ] **D3 — Find and retain work:** global/session transcript search, export, archive browsing and a continuation path for archived work without accidental duplication or deletion.
- [ ] **D4 — Attention:** desktop notifications with preferences, useful background-session status, persistent drafts and clear completion/stop/reconnect states.
- [ ] **D5 — Muse capabilities:** verify skill discovery/activation and clear native skill-use attribution when Muse reports it. Do not infer a skill ran merely because a prompt mentions it. Define the exposed plugin/MCP/settings workflow and supported scope.

## Token-efficiency follow-up

Requested for consideration in the preceding discussion; these policies are not implemented merely because Muse exposes usage events.

- [ ] **T1 — Measure first:** per-task/session/model usage, cache/reasoning counters where reported, context pressure and correctly deduplicated child-agent totals. Keep token counts, estimated API cost and subscription usage windows distinct; missing data stays unknown.
- [ ] **T2 — Reuse evidence:** reuse repository analysis, test results and reviews only while content/configuration fingerprints remain valid. Preserve provenance and invalidate on relevant changes.
- [ ] **T3 — Bound work:** explicit delegation/concurrency budgets, duplicate-work/loop detection and warnings before admitting more work. Any spend limit based on post-call counters is a soft limit with in-flight overshoot, not guaranteed billing enforcement.
- [ ] **T4 — Optional policies:** economical model/effort presets with user-visible escalation, focused context handoffs and deliberate use of Muse-native compaction. Preserve user instructions, correctness and permission boundaries; do not silently truncate history or rewrite transcripts.
- [ ] **T5 — Benchmark savings:** compare tokens, correctness, retries and completion time on repeated identical tasks. Existing UI polling/paging and broker memory savings are not inference-token savings.

## Optional research

- [ ] Evaluate a Rust-native interactive MSP adapter using the staged conformance/performance gates in [the SDK assessment](rust-sdk-assessment.md). Keep the official SDK as production/reference until parity is proven. This is not a prerequisite for onboarding or app updates, and it does not solve provider billing or credential expiry.
- [ ] A dependency-aware task scheduler and automatic evidence acceptance need separately agreed semantics and trust boundaries; current graph assertions and human evidence do not implement them.

## Suggested implementation order

1. R1/R2 together: installed-runtime packaging and Muse onboarding on the first supported platform.
2. R5 durable drafts/data lifecycle, while retaining existing account/recovery behaviour.
3. R4 rename/link/CI preparation while keeping public visibility as a separate deliberate action.
4. R3 signed GitHub release/update pipeline and real upgrade tests, with the active-work contract enforced.
5. R6/R7 remaining performance, usability, accessibility and failure gates; agree which D-items block the intended preview. T1 instrumentation can proceed before optimisation policies.
6. Public preview only after the chosen target matrix and acceptance gates pass. Add other platforms only with their own installed/native/live validation.
