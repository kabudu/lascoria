# Lascoria release-readiness backlog

Updated 8 November 2026, after v0.3.0. This is the consolidated product/release backlog; evidence lives in the [running checklist](implementation-progress.md) and the stage documents. The repository has been public since 21 October, hosted three-OS CI runs on every pull request and master push, and versioned binaries have been public since v0.1.2. Publishing a release does not close a gate: an unchecked item stays open until its own acceptance evidence exists, and a checked subtask does not close its parent.

## Status summary (6 November)

Three states are used for public work, and unreleased work is listed separately. **Shipped** means available in the public release and every acceptance item has evidence. **Implemented, incompletely validated** means the code is in the public release but the gate still has the exact remaining scope listed. **Planned** means a proposal in the [roadmap](../ROADMAP.md), not available and not scheduled.

### Shipped

| Area | Evidence |
| --- | --- |
| Public source and repository policy (R4 rename/opening, PL01 to PL04) | Renamed to `kabudu/lascoria`; public since 21 October; Actions enabled; master protection requires `native (macos-latest)`, `native (windows-latest)` and `native (ubuntu-latest)`. |
| Versioned binary distribution, v0.1.2 to v0.3.0 | Each release has one universal macOS installer/updater, Windows x64 and Linux x64/ARM64 packages, 13 public assets and matching stable/beta manifests, independently verified after publication. Latest: [v0.3.0](https://github.com/kabudu/lascoria/releases/tag/v0.3.0) from tag `v0.3.0` at `1680731`, [production run 42484377640](https://github.com/kabudu/lascoria/actions/runs/42484377640). See [v0.1.9 evidence](implementation-progress.md#v019-release-checklist-3-november). |
| Universal macOS distribution | Both architecture slices, Developer ID signatures, stapled notarization and Gatekeeper pass in the public installer and updater for every release since v0.1.2. |
| Curated release notes and fail-closed release metadata (PL13, PL14) | Versioned sources in `docs/releases/`, checked against the tag by release automation. Rendered previews are recorded in each release PR; the canonical page was inspected at desktop and mobile widths for v0.1.2. |

### Implemented, incompletely validated

Everything here is in the public builds. Unless a row says otherwise, macOS has the strongest native evidence; Windows and Linux evidence is narrower and noted. Package checks on published artifacts do not establish physical Windows or Linux acceptance.

| Gate | Remaining scope |
| --- | --- |
| R1 Muse onboarding | Windows and Linux onboarding runs; clean-account browser login followed by a live task; installation outside shell PATH and incompatible installations; offline, cancelled and partial setup; the error and accessibility matrix. |
| R2 Self-contained download | Fresh install, launch, uninstall and reinstall without developer tools on physical Windows and Linux; a published OS/architecture support statement; proof that application/state identity survives the rename and updates. Windows publisher signing is planned (roadmap). |
| R3 In-app updates | Windows and Linux signed replacement and restart; migration failure and recovery; incompatible supervisor; interrupted install, unavailable GitHub and rate-limit recovery against real releases; a recorded check that public installs carry no GitHub token. |
| R4 Public-release preparation | Application identifier and state-path compatibility evidence; clean-machine installation guidance validated per platform; build reproducibility. |
| R5 Data and lifecycle | Packaged lifecycle matrix (long commands, subagents, waiting questions/approvals, crash, sleep/wake, supervisor replacement); real provider expiry; cross-window draft conflicts; native data-lifecycle runs on all three OSes. |
| R6 Stage C evidence | Real retained-history and update-burst measurements on the current build; sustained packaged measurements; developer trials. |
| R7 Accessibility and failure states | Native VoiceOver and keyboard-only journeys; the rest of the failure-state matrix; native support-report save on all three OSes. |
| R8 Account usage and `/usage` | Live subscription `usage/changed`; no-observation, stale, API-key and signed-out states during active turns, tools and waiting states, on all three OSes. |
| R9 Skill picker | Muse-originated `skill/changed`; plugin skills; the full validation matrix on all three OSes. |
| R10 Decision assistance | Windows and Linux acceptance; a live OpenAI adapter trial; broader independent quality checks; a live Muse model choosing the tool unprompted. |
| R11 Resource efficiency | Signed-in host, active workloads and window states; Windows and Linux baselines; revalidation on the current SDK and packaged build; automated regression thresholds. |
| R12 Security review | Adversarial OS testing on all three platforms; installed signed acceptance of peer binding; independent review; findings closure with regression evidence. |
| R13 UX, DX and language review | Full journey review and findings register; native accessibility journeys. |
| R14 Attachments | Linux drops; remaining pick/paste and failure cases; real-provider media; R11/R12 checks for this boundary. |
| R15 Sessions and Projects | Linux folder intake; a live multi-repository task on all three OSes; permission, Git and recovery matrix; Project naming at creation. |
| R16 Session communication | Connect sessions flow; Linux desktop and live-provider proof; the complete target and lifecycle matrix. |
| R17 Account menu and Help | Native identity, Log out and Help runs on all three OSes; Help content reconciled with the current release. |
| R18 Session permissions (v0.1.9) | Windows and Linux interactive native and live-provider acceptance; positive sandbox execution where the host reports support unavailable. macOS live-subscription QA, controlled-provider lifecycle tests and three-OS hosted checks passed. |
| D1 guarded commit, D2 editor hand-off, D3 search/export, D4 notifications | D1/D2 native runs on all three OSes; D3 native export on macOS and Windows; D4 native delivery on macOS and Windows. |
| T1 to T5 token efficiency | Native checks for each policy; a broader T5 benchmark showing savings with preserved correctness. |
| D6 Selective file and hunk staging | Shipped in v0.2.0. Packaged macOS and Windows staging, refusal, commit and folder checks passed on 5 November; Linux passed in a container with the rendered workflows. Remaining: a packaged Linux (WebKitGTK) window and native dark-theme interaction in a packaged app; dark and light are covered by the rendered workflow. |

### v0.3.0 delivery milestone

| Item | State |
| --- | --- |
| D7 Review to delivery, D8 constellation hierarchy | Shipped in v0.3.0; publication and independent artifact verification passed. See the [release checklist](implementation-progress.md#v030-release-checklist-8-november). Requirement-by-requirement evidence and remaining scope: [milestone checklist](review-to-delivery.md#milestone-checklist). |

### Planned

Branches, merge/conflict help and hooks/signing (after D1); an embedded editor and interactive terminal (after D2); Muse skill, plugin, MCP and settings management (D5); Windows publisher signing; and the research candidates. See the [roadmap](../ROADMAP.md). None is authorised for implementation by this document.

The sections below keep the detailed acceptance contract and dated evidence. Dated notes describe the state on their date.

## Release blockers

### R1 - Detect and install Muse during onboarding

- [ ] Before account onboarding, distinguish missing Muse, incompatible Muse, launch failure and ready state. Resolve binaries reliably from a GUI launch without relying on an interactive shell's PATH; support choosing an existing installation.
- [ ] Explain that Muse is required and offer **Install Muse**, **Choose existing installation**, **Retry** and **Later**. Later permits offline inspection and returns to setup before new model work. Installation requires the user's explicit action.
- [ ] Use Meta's official installation/distribution mechanism and verify the resulting binary/version and MSP handshake against Lascoria's tested SDK/schema compatibility. Do not blindly install the newest Muse while the adapter only accepts a pinned version. If a compatible version cannot be installed through a supported vendor path, explain the incompatibility rather than bypassing the check.
- [ ] Show progress, bounded waits, cancellation and actionable network/disk/permission errors. Retry safely after partial installation. Do not expose arbitrary execution to React, overwrite an existing installation without consent, or replace a binary used by active tasks.
- [ ] Record whether Muse is user-managed or installed through Lascoria. Keep Muse upgrades separate from Lascoria upgrades and require compatibility validation before offering them; respect shared CLI credentials and other Muse clients.
- [ ] Validate on a clean account with no Muse, an existing supported installation outside shell PATH, an incompatible installation, offline/cancelled/partial setup, and installation followed by browser login and a live task.

Reference: [official Muse installation documentation](https://dev.meta.ai/docs/muse-code). Verify current vendor installation, integrity and redistribution terms when implementing; do not turn this backlog into an unverified shell-installer recipe.

### R2 - Make the download self-contained and define supported platforms

- [ ] Package the Rust supervisor, frontend assets and official SDK worker resources with installed-resource paths. Bundle or explicitly provision the required Node runtime; a normal user must not need Rust, npm, Node development setup or this source checkout. Muse setup is covered by R1.
- [ ] Decide and publish an OS/architecture matrix. First release requires macOS, Windows and Linux, per the user's 15 October decision. Windows IPC, secure storage and process-control implementations now exist alongside the Unix paths; Linux secure storage uses Secret Service. All three still need their complete packaged acceptance matrix. Assess each architecture separately. Tauri build targets alone are not platform support.
- [ ] Preserve stable application/state identities through branding and updates, or provide a tested migration. The repository rename must not reset accounts, sessions, worktrees, evidence or update identity.
- [ ] Produce application/installer artifacts with macOS Developer ID signing/notarization, signed updater artifacts on all targets, dependency/license notices and version/provenance metadata. The owner approved unsigned Windows publisher identity for the first release on 21 October; disclose unknown-publisher warnings and unsupported policies that block unsigned applications. Keep signing keys in release infrastructure, never in source or downloadable apps.
- [ ] Validate fresh install, launch, permissions, uninstall/retained-data behaviour and reinstall on every advertised platform/architecture without developer tools installed.

21 October signing substeps (do not close R2):

- [x] Configure the Apple signing/notarization names and production updater key/password secrets with the matching public variable, without committing private values.
- [x] macOS arm64 owned QA notarization: the signed app based on `7b8232d` was accepted, its ticket stapled/validated, and Gatekeeper accepted it. Its real local Echo follow-up and private transcript Save-panel check passed. This is scoped QA evidence, not a signed public release.
- [ ] Complete distribution and installed-platform acceptance for the supported target matrix under the approved signing policy. Windows Authenticode is deferred, not a first-release blocker; Windows installer and signed updater acceptance remain open.

### R3 - In-app updates from GitHub Releases

23 October follow-up: universal macOS filename validation, direct native application-menu checking, a focused action dialog, six-hour polling and persistent deferred-update controls were merged in PR #12 after final local CI and all three hosted native checks passed. Native macOS discovery and focused controlled tests are recorded in implementation progress; [v0.1.4](https://github.com/kabudu/lascoria/releases/tag/v0.1.4) is published and independently verified: all 13 assets/checksums, four updater signatures, both universal Mac containers, Windows installer version, both Linux package architectures and matching stable/beta manifests. The production workflow passed all package and native validation jobs. Older 0.1.2/0.1.3 Mac installs require a manual installer upgrade to receive the validator correction.

- [ ] Add **Check for updates** in Settings/About and bounded automatic startup/periodic checks with a user preference, no overlapping requests, timeouts and backoff. Show installed/latest version, last successful check, release notes, up-to-date, offline and failure states. Checks use ordinary networking, never model calls.
- [ ] Use the supported Tauri updater with signed platform/architecture artifacts and a release manifest hosted through GitHub Releases. Verify signatures before installation and reject wrong-target, tampered or incompatible artifacts. Keep stable and prerelease selection explicit; do not silently move stable users to prereleases.
- [ ] Download with progress/cancellation and offer explicit **Install and restart** or **Later**. Automatic checking does not imply forced installation or interruption of active work.
- [ ] Coordinate the UI, Rust supervisor, Node worker and Muse compatibility as one versioned contract. Current bundles replace the complete runtime, so all operating systems require explicit pause/stop before installation. Rust must independently exclude an active service or another installer, then recover retained state after replacement without replay. A future UI-only update may retain work only with a separately negotiated immutable runtime; that is not the current path. Never spawn two writers or let an obsolete supervisor spawn workers from replaced resources.
- [ ] Preserve account policy, inactive API keys, drafts once durable, worktrees, sessions and evidence. Validate migrations and a recoverable failed-update path. Do not promise binary downgrade when a newer database schema refuses it; backup/restore and rollback policy must agree.
- [ ] CI builds/tests each supported target, creates signed updater artifacts and publishes versioned GitHub releases/manifests only after gates pass. Anonymous public installs must not contain a GitHub personal access token. Status (4 November): the production workflow has built, validated and published v0.1.2 to v0.1.9 (latest [run 41588667199](https://github.com/kabudu/lascoria/actions/runs/41588667199)); this item stays open until the absence of any GitHub token in installed builds is recorded as evidence.
- [ ] Exercise real packaged N-to-N+1 install, idle and active-session update, question/approval waiting states, UI reopen, interrupted download/install, invalid signature, unavailable GitHub/rate limits, incompatible supervisor, migration failure and unsupported target. Verify no command/tool replay and correct restored progress.

Reference: [Tauri v2 updater](https://v2.tauri.app/plugin/updater/) supports signed update artifacts and static manifests on GitHub Releases. Integrated 18 October with a prepared release pipeline ([Cutting a release](RELEASE.md#cutting-a-release)); the acceptance items above still need the complete target/failure matrix; scoped macOS signed replacement/restart is recorded below. Existing live UI-close/reconnect and graceful-logout proofs in [accounts](accounts.md) are prerequisites, not an update-install proof.

21 October updater substeps (do not close R3):

- [x] Prepare a complete required-target inventory, post-signing runtime provenance checks, immutable draft/asset reconciliation, bounded retry handling and globally serialized monotonic stable/beta publication. Controlled API and protocol tests validate these paths; hosted Actions remains disabled.
- [x] Make full-runtime update ownership explicit on all OSes: pause/stop first and hold the native owner lock during install. Announced and received download bytes share a 256 MB limit and a five-minute deadline; cancellation and signed-version failures stay failures.
- [x] Scoped macOS arm64 native signed 0.1.1-to-0.1.2 QA installation/restart: both endpoints freshly notarized/stapled; post-install deep strict signature, ticket and Gatekeeper checks passed. A new service retained six session IDs, completed progress and an unsent draft. Real Muse SDK pending-question, permission and active-call states, driven by a controlled local provider, became saved stops with no stale question/approval, no approval-sensitive file and no automatic request replay. An explicit follow-up in the same session completed. The original user service was preserved.
- [x] Scoped native failure checks: reject tampered signature, announced 300 MiB download and wrong platform; cancel a slow download and retry. Installation failure exposed a repeated-stop bug, fixed with an app-lifetime stop marker, required draft/layout flush and a Settings-remount retry regression. Release manifests reject artifacts above the same 256 MiB client budget.
- [ ] Complete Windows/Linux signed replacement/restart, migration failure, incompatible-supervisor and remaining network/install recovery checks. The real production GitHub pipeline has since published and served v0.1.2 to v0.1.9. The macOS local-provider QA proof does not close the full R3 gate or establish paid live-provider acceptance.

### R4 - Repository rename and public-release preparation

Use [the tailored public-launch gates](public-launch.md), adopted from the bootstrap skill, alongside the detailed R1–R18 checks. Public opening and hosted CI activation completed on 21 October; each release still requires final-head local CI, the three hosted native checks and its own explicit publication authority.

- [x] Disable GitHub Actions at repository level while private, per the user's instruction (historical; the private phase ended on 21 October).
- [x] When public visibility is explicitly authorised and applied, re-enable GitHub Actions, run the prepared cross-platform workflow and inspect actual results before relying on CI or publishing. Done 21 October: the repository is public, `actions/permissions` reports `enabled: true`, and the three native checks run and are required on every pull request (for example [run 41586804560](https://github.com/kabudu/lascoria/actions/runs/41586804560) for the v0.1.9 release head).


- [x] Rename `kabudu/spatial-constellation-harness` to `kabudu/lascoria`, checking target availability immediately before the operation. Update and verify local origin, package metadata, README links, issue/repository URLs, CI, badges and future release/updater endpoints. Preserve Git history and verify fetch/push against the renamed repository.
- [ ] Keep existing application identifiers, persistent state paths, task branches and evidence fingerprints compatible unless a separate migration is implemented. Renaming the local checkout is optional and must not break installed/development resource paths.
- [x] Before making the repository public, complete tracked-file/history privacy and licensing/redistribution review, security reporting, support expectations and contributor guidance. Completed for the 21 October opening under PL03: Apache-2.0 [LICENSE](../LICENSE) and [NOTICE](../NOTICE), [SECURITY](../SECURITY.md), [SUPPORT](../SUPPORT.md) and [CONTRIBUTING](../CONTRIBUTING.md) are published, and the scoped history result is in [history cleanup](public-history-cleanup.md). Original preparation text follows. Keep local `.dev` credentials and live transcripts excluded. The owner selected [a public-history cleanup plan](public-history-cleanup.md): current minimisation does not erase the nine historical private-session trailers or old document identifiers. Preserve the existing stack until delivery is resolved and separately authorise rewrite/ref replacement; then validate the actual public candidate. A rename or prepared plan is not authority to make the repository public.
- [ ] Finish reproducible CI/build/release instructions, supported versions, changelog/tag policy, artifact checksums/provenance and clean-machine installation documentation. The release workflow requires reusable validation before building and uses immutable artifact reconciliation; it has published v0.1.2 to v0.1.9. Remaining: clean-machine installation guidance validated per platform and demonstrated build reproducibility. Publish only targets that passed R2/R3.
- [x] Prepare `.github/master-protection.json` for review: one approval, resolved conversations, linear history, strict three-OS native checks, and no force pushes/deletions. Applied on 21 October after the real check contexts were verified; on 22 October the active policy was set to zero required approving reviews, keeping strict three-OS checks, resolved conversations, administrator enforcement, linear history and disabled force pushes/deletions.

### R5 - Durable data, authentication and lifecycle acceptance

Implemented foundations: browser subscription priority over a saved API key, native credential storage, app-local logout, bounded graceful cancellation with retained evidence, detached UI background execution and same-session recovery. See [accounts](accounts.md).

- [ ] Validate browser authentication/expiry/revocation across real provider expiry intervals, sleep/wake and network loss; show reconnect without automatic paid fallback. Do not promise indefinite provider authorization.
- [ ] Make task drafts durable across window closure/update; preserve per-session targeting and provide a visible recovery path for interrupted work. Local SQLite-backed drafts and reload recovery are implemented; cross-window conflict recovery, full native close/update acceptance and the remaining lifecycle gates are still tracked.
- [ ] Define backup/export/restore, schema migration and safe local-data cleanup/retention. Current bounds include 100 retained sessions and 2,000 journal records; exhaustion needs an actionable product flow before sustained release use, without weakening no-replay guarantees.
- [ ] Run packaged lifecycle tests for long-running commands, subagents, outstanding questions/approvals, sign-out, window quit, supervisor replacement, crash, sleep/wake and restart. Distinguish confirmed cancellation, natural completion and uncertain outcomes; retain worktree edits and never silently rerun side effects.

### R6 - Finish Stage C performance and usability evidence

- [ ] Close the remaining real retained-history/update-burst gates and repeat reference measurements, including the GUI and full runtime tree with documented Muse/Node/build versions. Synthetic 100,000-item rendering is not real Muse/SQLite history-scale proof.
- [ ] Revalidate sustained memory/CPU/latency budgets with account observation and packaged binaries; add repeatable regression gates. Short smoke runs do not substitute for the required observation period.
- [ ] Conduct comparative developer trials on realistic concurrent coding tasks: time to notice attention, inspect evidence, make a correct decision and finish/review work, plus voluntary repeat use. Record adoption evidence separately from scripted tests.

Source: [Stage C](stage-c.md) and its [memory follow-up](stage-c-memory.md). Historical failed measurements remain historical; this checklist does not reopen already-fixed memory defects without new evidence.

### R7 - Accessibility, reliability and user-facing failure states

- [x] Preserve constellation scene geometry when floating panels expand or collapse, including zoom, pan and manually pinned nodes. Regression reproduced before the fix; native Sessions disclosure and the 50-node UI regression pass.

- [ ] Complete native VoiceOver and keyboard-only journeys, focus restoration, zoom/text scaling, supported window sizes and both themes. Existing automated WCAG checks are a foundation, not a full native accessibility audit.
- [ ] Test unavailable Muse/runtime, authentication, permissions, network failures, disk-full/locked Keychain, malformed/incompatible history and exhausted resource limits with clear recovery actions and no secret-bearing errors.
- [ ] Add privacy-safe diagnostic export/support information with explicit preview/redaction boundaries. Define log retention and ensure installed builds do not depend on ignored development artifacts.

### R8 - Subscription usage in Settings and non-interrupting `/usage`

25 October distribution: [v0.1.5](https://github.com/kabudu/lascoria/releases/tag/v0.1.5) ships the header usage shortcut and automatic idle service handover after final local CI, three-OS hosted checks and the full production workflow passed. All 13 public assets/checksums, four updater signatures, platform package metadata and matching stable/beta manifests were independently verified. Native handover and controlled subscription fixtures are recorded in implementation progress; the broader live subscription matrix below remains open.

- [ ] Add **Settings → Account & usage** with subscription tier, separate current-window and weekly used/remaining percentage bars, reset countdowns plus absolute local reset times, last-observed timestamp, refresh and clear unavailable/stale states. Include a compact optional workspace indicator; keep detailed information out of the main canvas by default.
- [ ] Read native `usage/read` and observe `usage/changed` through a bounded read-only path independent of model commands, session mutation queues and slow recovery. Opening/refreshing usage must not start, steer, cancel, interrupt or restart a turn/host, generate inference, create a transcript message or change the selected billing route. Do not invoke the interactive CLI's `/usage` screen.
- [ ] Intercept the exact local `/usage` command in the composer and command palette to open the same usage view, including while a model, tool or subagent is active. Preserve the existing task draft, selected session, pending approvals/questions and keyboard focus on dismissal. Partial matching must not consume ordinary text or a skill invocation accidentally.
- [ ] Treat subscription readings as account/host observations, not per-session allocations: never add identical quota windows from multiple hosts. Display the freshest valid observation for the current account, invalidate on account changes, and preserve its freshness timestamp. Unknown/absent usage is not 0% used or 100% available; over-quota readings remain visible even when remaining percentage is clamped to zero.
- [ ] Keep subscription allowance separate from task tokens, model context occupancy and API billing estimates. Exact remaining requests/tokens, renewal dates and payment balances are shown only if the provider supplies them. Background refresh cannot promise fresher data than Muse's last observation, and must not send a synthetic prompt to obtain a number.
- [ ] Validate native/live availability on subscription, no-observation, stale/offline, API-key and signed-out states; rapid open/close and multiple sessions; foreground streaming, tools, subagents and waiting approvals/questions. Assert no extra model calls or cancellation/restart events and unchanged active turn identity.

The installed SDK exposes tier, current-window duration/used percentage/reset and weekly used percentage/reset with `observedAtMs`. Muse documents that the served usage query reads observed windows without spending a prompt: [Muse changelog](https://dev.meta.ai/docs/muse-code/changelog). These fields support a clear allowance dashboard; they do not establish access to full account billing information. Account & usage now shows the freshest account-scoped reading (including `usage/changed`), with countdowns, local reset times and stale, reset-passed and API-key states (18 October); an optional toolbar figure is available; a direct header usage popover now adds cached current/weekly allowance and automatic idle recovery for older services (25 October); live subscription proof and the state matrix above are still open.

### R9 - Native Muse slash-command and skill picker

- [ ] Typing `/` at a command position in the composer opens an anchored, height-bounded, scrollable and searchable picker. Show supported Lascoria commands separately from Muse skills, with name, concise description, source badge (built-in/user/project/plugin) and argument hint when supplied. Support keyboard arrows, Enter/Tab selection, Escape dismissal, mouse selection and screen-reader announcements; keep the highlighted row in view.
- [ ] Discover user-invocable skills through per-session native `skill/list`, respecting the selected workspace, plugin state, activation and native name resolution. Show actual available built-in skills rather than a hardcoded marketing list; exclude non-user-invocable entries. Handle qualified plugin selectors, duplicate display names, reserved local commands and conflicts without silently invoking another skill.
- [x] Selecting a skill inserts the exact native selector into the draft, ready for optional arguments; it does not execute automatically, expand the skill body in React or submit a model turn. On explicit submission, use Muse's native typed invocation path and preserve normal permissions and provenance. Do not manufacture a separate Lascoria interpretation of the skill instructions.
- [ ] Opening, filtering or selecting while a turn runs must not interrupt it. Retain the selection in the next-turn draft; any immediate steering/queueing action requires an explicit supported interaction and validated native semantics. Loading/reloading the list uses bounded queries, not prompts; invalidate the session-scoped cache when native skill state changes or session/workspace changes.
- [ ] Show requested skill invocation separately from observed skill use. Attribute execution/loading only when Muse reports the corresponding tool/event evidence, retaining source/session provenance. Missing evidence is unknown, not proof that a skill did or did not run.
- [ ] Validate built-in, user, project and plugin skills, empty/unavailable catalogs, disabled/conflicting selectors, arguments, session switching, long lists, keyboard/accessibility, active-turn non-interruption and a real native skill invocation. Negotiate any experimental capability required by the pinned Muse version; SDK type declarations alone are not runtime proof.

References: [native skill discovery](https://meta-models.github.io/muse-code-sdk/next/generated/msp/methods/skill-list/), [skills in SDK sessions](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/concepts/plugins-in-sdk-sessions/). Discovery and typed invocation are supported by Muse. Lascoria now has an initial picker and usage view; the full acceptance matrix above remains open. Observed skill use (19 October): Muse 1.4.10 reports a skill load only as the experimental `skillRead` item, so session hosts negotiate `experimentalApi` for that item and decline every experimental notification (`account/changed`, `account/loginCompleted`, `admission/requested`, `admission/resolved`, `log/gap`, `log/record`, `mcpServer/oauthLoginCompleted`, `session/permissionProfileChanged`); the one experimental server request, `admission/request`, is refused like any unhandled request. The transcript shows `Requested skill /x` on the task and, apart from it, what Muse reported: loaded (with its source), loading, or unknown when no report arrived.

### R10 - Optional BYOK decision providers, with a quiet UI

User requirement added 15 October: support Jev (TypeSafe), Subquadratic/SubQ and OpenAI decision APIs with user-supplied keys. A clean, uncluttered workspace is a fundamental product constraint.

Manual snapshot-review foundations are now implemented with separate vault credentials, explicit workspace opt-in, disclosure preview and durable no-replay outcomes. Background triage, the Muse tool, aggregate metrics and overrides were added on 19 October, and macOS native acceptance of the settings, keychain, consent, tool listing and preview passed the same day without any paid request; Subsequent live Jev and SubQ trials passed simple predicate/choice/score, helper replay and automatic triage oracles; a native Jev negative control also passed. OpenAI returned HTTP 401 and remains unverified at the user’s direction. Windows and Linux acceptance, independent task-quality trials and a live Muse model choosing the tool remain open, so the items below stay unchecked. See [decision assistance](decision-assistance.md) and the running checklist for evidence.

Scope decided by the user on 18 October: all three interaction models ship in the first release (a: user-requested evaluation of selected evidence, b: opt-in bounded background triage, c: an explicit tool Muse can call), and the paid, data-disclosing integrations are included. Nothing is sent until the user adds a key for a provider and turns a model on; Settings management must have a great UX.

Verified first-party contracts (15 October 2026; recheck before implementation):

| Provider       | API and documented shape                                                                                                                                                             | Source                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Jev / TypeSafe | `POST https://api.typesafe.ai/v1/systemone`; `model`, shared `state`, named typed `questions`; named answers and usage. `noul`, `choice` and `score` are provider-native types.      | [TypeSafe API](https://docs.typesafe.ai/api)                                |
| SubQ           | `POST https://api.subq.ai/v1/systemone`; `subq-snap-preview`, shared state and 1–16 named `noul`/`choice`/`score` questions. Public preview, with probabilities and reported usage.  | [SubQ Decisions](https://docs.subq.ai/endpoints/decisions-api/)             |
| OpenAI         | Dedicated `POST /v1/decisions`, not Responses; public beta currently documents `gpt-6-luna`, shared `input` and named `predicate`/`choice`/`score` questions, with an answers array. | [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) |

- [ ] Design **Settings → Integrations → Decision assistance** for BYOK provider/model configuration, native-vault storage, explicit connection testing and per-workspace enablement. Keep Muse subscription and its API key separate from these independently billed services. Keys never enter React state after submission, command journals, argv, exported diagnostics or Muse prompts. Honour provider retention/data-use settings and expose the actual destination before enabling any integration.
- [ ] Interaction models (all three approved 18 October; each off until the user turns it on): (a) user-requested evaluation of selected evidence, (b) opt-in bounded background triage with scoped data, (c) an explicit tool usable by Muse, or a staged combination. Start with advisory results; model routing, autonomous gates and scheduler actions require separately defined policy/permission semantics. Do not silently replace Muse's execution model or masquerade as its native permission reviewer.
- [ ] Use a Rust-owned bounded decision service and provider-specific adapters, not an assumed universal chat or OpenAI-compatible schema. Preserve native answer types, probabilities, resolved model and request identity. Version rubrics and input/evidence fingerprints; reject stale answers after revisions change. Provider confidence is not guaranteed correctness or directly comparable calibration between providers.
- [ ] Keep the default canvas unchanged. No always-visible provider cards, extra floating panels or per-call toasts. Offer details through the existing inspector/usage/settings surfaces; expose a small task indicator only when relevant/actionable or explicitly enabled. The user can inspect the outcome, source/provider/model, input scope, timestamp, rubric version, uncertainty and whether a recommendation was applied. No fabricated chain-of-thought or explanation when the API did not return one.
- [ ] Provide optional metrics: calls, provider-reported token counts, cost amounts with their estimation/source details, latency distributions, errors/rate limits, cache reuse, policy outcomes and human overrides, per provider/task/workspace. Aggregate summaries live in Usage; detailed traces stay opt-in and privacy-safe. Do not imply external BYOK charges are covered by a Muse subscription or claim savings without a task-quality benchmark.
- [ ] Keep app recommendations and native Muse events separate. Any approved recommendation affecting a Muse session uses the existing authenticated, journaled command boundary, with fresh approval requirements and no replay. Never auto-approve permissions or mark evidence accepted based solely on a decision probability. Failures must leave Muse usable and allow disabling assistance without breaking a session.
- [ ] Enforce deadlines, concurrency/admission and spend warnings, cancellation, bounded payloads and result validation. Avoid duplicate paid retries and stale background decisions; an ambiguous timeout is not proof a call was unbilled. Never switch providers or disclose data to a fallback destination silently. Credential rotation/removal, offline, invalid-key, quota, beta/schema changes and malformed output need visible, recoverable states without UI clutter.
- [ ] Validate all three adapters with contract fixtures, adversarial/stale inputs and independent quality checks; then explicit BYOK live trials and native UX with active Muse turns, subagents, questions and approvals. Measure non-interference and payload disclosure as well as latency/tokens. Have the user assess the proposed interaction design before enabling automatic decisions.

### R11 - Whole-application resource efficiency review

Added 15 October at the user's request. Efficiency is a release requirement. Measure the experience users actually pay for on their machines, including every descendant process; report Lascoria overhead and Muse/tool costs separately without omitting the latter from the total.

- [ ] Establish repeatable release-build CPU/memory baselines for macOS, Windows and Linux on documented reference hardware. Count the GUI/WebKit or WebView2 renderers, Rust supervisor, Node account/SDK workers, native Muse hosts, tools and retained background processes. Record versions, process identities, sample interval, machine load and session/workload counts.
- [ ] Profile cold start, steady idle, active streaming/tools, waiting questions/approvals, collapsed panels, hidden/minimised/closed UI, long transcripts/diffs and 1/5/10 concurrent sessions. Include sleep/wake and network/recovery bursts. Check background polling/timers and duplicate workers, with no prompt-based keep-alives.
- [ ] Report CPU as percentage of one core and whole-machine share, plus sustained/peak memory, resident/private/committed definitions, allocation growth, startup latency, p95/p99 interaction latency and energy impact. Avoid double-counting shared renderer pages or comparing incompatible OS memory counters. Show whole-tree cost and per-session marginal cost.
- [ ] Retain the existing provisional Lascoria-overhead targets (under 300 MB combined UI/control RSS and under 1% of one core at idle for the documented ten-session workload), revalidate them on the current SDK and packaged build, and set explicit full-tree/active/background budgets from comparable measurements. Historical target success is not current acceptance, and excluding Muse cannot justify a claim that the whole application meets that budget.
- [ ] Run at least three comparable five-minute observations and a 30-minute soak with repeated session create/close, task/question/answer, transcript/diff navigation and reconnect cycles. Verify useful completed work, bounded memory/CPU, return toward baseline and no accumulating processes, listeners, histories or renderers. Investigate sustained growth with allocation/process evidence.
- [ ] Fix measured regressions, then rerun the original workloads with matching correctness. Add proportionate automated regression thresholds and publish the tested resource envelope and remaining limitations. Hosted checks run when the repository becomes public; local native measurements remain required.

18 October: the user accepted the measured macOS RSS overage (327–329 MB control + GUI RSS, 226 MB footprint, ten sessions idle, signed out) as a [scoped exception](resource-efficiency.md#scoped-exception-macos-resident-memory-18-october). It does not cover other platforms, the signed-in host or active workloads, and does not close this gate.

Historical reference only: [14 October Stage C memory results](stage-c-memory.md#measured-results-14-october-2026) recorded 207.7 MB UI/control RSS and 0.68% of one core idle for ten sessions, but 1,613.5 MB and 5.60% including ten native Muse hosts. That used SDK/Muse 1.4.8 and does not certify current builds (pinned to 1.4.14 since v0.1.9).

### R12 - Full security review before public release

Added 15 October at the user's request. This is a release gate requiring an evidence-based review and remediation, not a claim that the current implementation has passed a security audit. The threat model and findings register are in [security review](security-review.md).

- [ ] Document the threat model, assets, trust boundaries and supported deployment assumptions across React/WebView, Tauri commands, Rust supervisor, local IPC, Node SDK workers, Muse, tools, repositories, plugins/skills, provider APIs and release infrastructure. Treat repository files, model/tool output, transcripts and remote metadata as untrusted input; distinguish same-user code execution from other local users and remote attackers.
- [ ] Review authentication and authorization end to end: subscription/API-key precedence, logout/recovery barriers, account/session isolation, credential expiry/revocation, native-vault use, secret lifetimes and redaction. Verify no credentials leak into frontend persistence, argv, command journals, logs, crash reports, diagnostics, exports, Git history or artifacts; cover unavailable/locked vaults and explicit BYOK data disclosure.
- [ ] Audit every frontend-to-native and IPC boundary for least privilege, command/capability allowlists, caller/peer identity, token handling, endpoint spoofing, replay/idempotency, path and URL validation, size/time/concurrency bounds and unauthorized state changes. Review WebView CSP/navigation, HTML/Markdown/diff rendering, external links and browser handoff for injection or unintended execution.
- [ ] Review filesystem and process ownership: private permissions/DACLs, links/reparse points, canonical containment and race windows, Git/worktree operations, destructive actions, shell/argument handling, child environments, process-tree cleanup and crash recovery. Test malicious repositories, filenames, symlinks, hooks/configuration and tool output without weakening native approvals or replaying uncertain side effects.
- [ ] Audit Muse skills/plugins/MCP and optional decision integrations for prompt-injection and confused-deputy paths, unintended cross-workspace access, permission escalation, data exfiltration and automatic acceptance. Preserve native permission authority and revision-bound evidence; model output or provider confidence must never grant approval by itself.
- [ ] Review dependency and distribution supply chains: Rust/npm/SDK/runtime dependencies, reproducible lockfiles, known vulnerabilities, licenses/provenance, vendor downloads and redirects, integrity checks, installer activation, CI action pinning/permissions, signing/notarization, updater signatures, artifact ownership and rollback/migration safety. Include public-repository history/secret scanning and release-secret handling before open-sourcing.
- [ ] Exercise adversarial failure and abuse cases on macOS, Windows and Linux: malformed/fuzzed protocol frames, stale credentials/evidence, interrupted writes/install/update, cross-user IPC attempts, endpoint replacement, queue/resource exhaustion, hostile histories/diffs and crash/restart races. Use disposable environments and bounded tests; record exact revisions, environments, methods, findings and reproduction evidence.
- [ ] Maintain a severity-ranked findings register with owner, remediation, regression proof and residual risk. Fix exploitable authorization, credential disclosure, unsafe execution/update, data-loss and serious availability findings before release. Any unresolved risk requires explicit acceptance and documented scope; a passing scanner or test suite alone does not close this gate. Obtain a separate reviewer where practical, define vulnerability reporting/response guidance and rerun affected checks after fixes.

### R13 - Full UX, developer experience and language review

- [x] Clarify token-use hierarchy and provide direct session-archive access, with responsive light/dark previews, unknown-value handling, keyboard/confirmation semantics and native-bridge archive validation. The 26 October follow-up keeps Archive in the fixed panel header, makes the archived-session filter strict even for selected sessions in the list, and prevents workspace labels painting over floating headers while retaining canvas-control access.

- [x] Correct notification control alignment and replace master, event and session checkboxes with accessible switches. Verify keyboard operation, saved preferences, wrapped labels, disabled groups and both themes at desktop and narrow widths; see the 22 October notification entry in implementation progress.

Added 15 October at the user's request. Include the later feedback that dropdown controls are too short: review minimum height, padding, text/chevron alignment, focus and native popup behaviour across all platforms. Clear, easily digestible language and a clean, uncluttered interface are release requirements. Technical terms belong where they help developers make a decision; internal implementation details belong in expandable diagnostics.

- [ ] Review every first-run and daily-use journey: installation, sign-in/API keys, session creation, model/effort changes, canvas navigation, skills, usage, attention, transcript, changes, evidence, Git delivery, archive/continuation, settings, updates and recovery. Evaluate hierarchy, spacing, useful defaults, discoverability, progressive disclosure and consistency across macOS, Windows and Linux.
- [ ] Audit every visible label, tooltip, shortcut, status, confirmation, empty/loading/error state and notification. Use plain language, consistent product terms, specific actions and a clear next step. Explain jargon only where required; avoid exposing raw identifiers, protocol names or engineering prose in ordinary workflows. Keep precise native facts available in details without claiming more than Muse reports.
- [ ] Review durations, dates, numbers, units and quotas for readability and accuracy: for example, say “5-hour window” instead of “300 minute window”. Preserve mixed-unit precision and show local reset times, freshness and unknown values clearly. Distinguish subscription allowance, model tokens and API billing without forcing users to understand transport internals.
- [ ] Review developer experience end to end: clean setup/build/run instructions, command/shortcut discoverability, workspace/editor/Git handoffs, environment and permission guidance, actionable failures, safe retries, retained drafts and restored work. Verify documented examples against the actual app and CLI; distinguish supported behaviour from planned features.
- [ ] Validate keyboard and screen-reader journeys, focus restoration, text scaling, narrow windows, both themes, reduced motion, long/localised content and status visibility without open panels. Combine native interaction, automated accessibility checks and realistic developer trials; screenshots alone do not prove usability.
- [ ] Keep a prioritised findings register with affected journey, reproduction, user impact, proposed wording/interaction, fix and regression evidence. Fix confusing or unsafe primary flows before release, rerun the affected journeys after changes and record unresolved limitations explicitly. Apply this review to each increment and repeat the complete review before release.

### R14 - Native attachments with a compact composer workflow

Requested 15 October. See [attachment capabilities and proposed UX](attachments.md). Current repository text insertion is not general attachment support.

- [ ] Add a compact attachment control, drag/drop and clipboard image intake, with a bounded thumbnail/file strip, preview, remove, keyboard/screen-reader support and clear per-item states. Keep the canvas uncluttered; selecting only stages a draft and does not interrupt work or transmit content.
- [ ] Prove supported formats against the pinned Muse runtime/provider. Use native image input and session-owned video uploads where supported; preserve native permissions and provenance. Distinguish file references, text excerpts and actual attached bytes. Explain unsupported formats rather than sending only their names.
- [ ] Persist session-owned staged attachments and order with durable draft conflict/recovery semantics. Preserve unknown-send identity, support per-item retry/removal, and prevent cross-session leakage or duplicate model calls after close/crash/reconnect.
- [ ] Add a narrow private staging boundary with content/size/decode/count/storage limits, validated formats/paths and explicit cleanup. Preserve the general IPC size limit; keep large/private bytes out of command journals, logs and diagnostics. No automatic external conversion/upload on selection.
- [ ] Validate native pick/drop/paste, long names, duplicate/corrupt/oversized/unsupported files, mixed text/skills/images, model changes, active turns, questions/approvals, cancellation, offline/recovery and close/reopen across all three operating systems. Complete R11 resource and R12 privacy/security checks for this boundary.

19 October native evidence: macOS physical composer text/image drop, folder refusal and Project folder intake/file refusal passed with user assistance; Windows native picker, physical composer file drops/folder refusal, owned-UI attachment restoration and installed-resource image lifecycle passed. Windows Project folder drops/file refusal also passed with user assistance. Linux physical drops and the complete matrix remain open. See [native acceptance](native-acceptance.md).

### R15 - Simple sessions and reusable multi-folder projects

Requested 15 October. See [session/project experience and native context contract](projects.md). Reimagine setup around the spatial workspace while keeping the quick path simple.

- [ ] Offer Session for focused single-folder work and Project for a named, reusable set of folder references, goals and optional notes. Provide a polished spatial folder arrangement plus an equally capable keyboard/list flow; keep context summaries compact during task work.
- [ ] Add/edit/reorder/remove named folders, choose the default working folder and validate canonical existing roots, aliases, duplicates/nesting, symlinks, unavailable paths and platform-specific paths. Show what Muse will receive before applying; do not auto-read every file or infer permission grants.
- [ ] Integrate the actual native `workspaceRoots` contract for session start and supported next-turn replacement. Track project/configuration revision, requested versus confirmed context and command receipts. Running tasks retain their current roots; editing a project is not an immediate steer or implicit change to existing sessions.
- [ ] Persist/recover projects and per-session context through restart, conflict, folder moves and unknown outcomes. Keep sessions/workspaces isolated, preserve native trust/permission boundaries and support clear, reversible editing with safe retries.
- [ ] Define and implement Git/worktree/diff/evidence ownership across repositories before claiming isolated multi-folder coding. Prevent cross-root staging/discard mistakes and misleading attribution. Preserve the single-folder workflow. 19 October: implemented (per-folder snapshots and evidence; isolated Project sessions with one worktree and task branch per repository, per-folder preview/tests/commit, all-folder discard bound to each folder's content) with Rust, real-Muse and Rust-backed UI tests; native acceptance remains, so this stays unchecked.
- [ ] Validate a real live Muse task spanning multiple folders/repositories, folder changes between tasks, simultaneous sessions, approvals/questions, permissions/refusals, recovery and all three operating systems. Complete R11/R12/R13 performance, security and UX/DX gates for this boundary.

19 October Windows worktree acceptance found and fixed Muse canonical-root formatting at the SDK boundary. The installed-resource two-repository test now passes on Windows x64 with Muse 1.4.10 and a controlled provider; full recovery, native interaction and Linux acceptance remain open.

- [x] Initial native folder intake: Browse for Session/Project paths, editable-path fallback, cancellation/error/pending handling, local-only staging and unchanged explicit Save/Start validation. Rust, Rust-backed narrow/accessibility UI, native macOS select/cancel/save and Windows compile checks passed. Windows/Linux native chooser acceptance remains open within the full R15 platform gate.
- [x] Initial reusable Project start: saved named configurations, 1 to 8 canonical folder references, keyboard reorder/default, revision conflicts/exact retries, native SDK workspaceRoots at start, per-session revision/receipt and safe Git guards. Controlled native-runtime context/restart and Rust-backed narrow/accessibility UI tests passed. Initial macOS native browser-login/Wonder proof now covers two-repository edits/tests, a real question/answer and supervisor recovery. Next-task replacement and full platform/permission/Git gates remain open.
- [x] Standalone naming milestone: optional name at creation, folder default, discoverable Rename, per-session revision conflicts, stable lost-reply retries and cancellation. Names persist through worker writes/database reopen and propagate across workspace/attention/targets/settings/local messaging with native IDs retained. Rust, delayed-admission, two-window/narrow/accessibility UI and isolated macOS native creation/rename/reopen/long-name checks passed. Windows supervisor/native-bridge compile checks passed; full platform release acceptance remains above.
- [ ] Ask for a name when creating a Project and allow editing it later. Persist project names through reopen/recovery, propagate them to every project/session reference and disambiguate duplicates without changing native IDs or folder ownership. This depends on the reusable Project entity and full native context/platform validation.

### R16 - Inter-session interaction and communication, required for the first release

Explicit first-release requirement, requested 15 October. [Capability findings and proposed experience](session-communication.md) distinguish native parent/child messaging, independent interactive Muse peers and the Lascoria-managed relay. Current official native scope excludes Windows/headless; the user selected an explicit all-platform Lascoria relay for the first release.

- [x] Initial user-directed local inbox: explicit local pairs, bounded durable selected text, idle-only journaled delivery, duplicate/crash reconciliation and separate permissions. Verified with two live independent Muse Wonder sessions in the macOS native app, plus Rust/Node/UI checks. This subtask does not complete the platform or agent-coordination gates below.
- [x] Session-scoped Muse send/read tools with explicit pair opt-in, eight-message agent budget, one-message cursor pages, native permission boundary, isolation, revocation and idempotent retry. Real Muse controlled-provider tests and independent live Wonder sessions passed on macOS; target-matrix/lifecycle release gates remain open.
- [x] Windows named-pipe agent relay smoke and native live Wonder bidirectional coordination: explicit connection, proposal, independent review and reverse model receipt passed on the laptop. Full target-matrix/lifecycle acceptance remains open.
- [x] Save pair-specific message drafts across close/restart, surface competing copies and reconcile uncertain sends without duplicates or erasing newer drafts. Rust, real-Muse restart, Rust-backed UI conflict/retry tests and final Windows native restoration/share passed.
- [x] Persist explicit local viewed-message receipts and new counts in the conversation, separate from Muse delivery. Recipient isolation, atomic rejection, retry, later arrivals, restart and UI reload are tested; native macOS live Wonder delivery remains a separate action. Global/spatial unread navigation and cross-platform native acceptance are still open.
- [x] Linux ARM64 installed-resource relay smoke with vendor Muse and bundled Node/SDK: both agent directions, isolation, permissions, revocation, restart, drafts, viewed state and exact retry passed on Ubuntu 26.04. This is runtime integration evidence; Linux native desktop/live-provider and full target-matrix acceptance remain open.
- [ ] Finish and validate the initial Rust-owned local inbox/explicit delivery transport for independent Lascoria sessions on the required target matrix. Negotiate/prove native capabilities or implement the agreed explicit Lascoria relay; never bypass a native gate, impersonate a peer or present child messaging as independent-session support.
- [x] Discover new local messages across recipients through one quiet header entry and exact conversation navigation. Counts are part of the bounded status snapshot; opening does not mark viewed or invoke Muse. Rust, real-Muse controlled-provider/restart, narrow/accessibility UI and isolated macOS native interaction passed. Spatial links and full native platform acceptance remain below.
- [x] Initial opt-in floating Session links view: explicit current-session peers, dotted curved message connections, native working/waiting/unavailable status, new-message counts and exact conversation navigation. Move/collapse persists; narrow/accessibility UI and isolated macOS native restart checks passed. Full platform/project/lifecycle acceptance remains below.
- [ ] Add a clean Connect sessions / conversation flow with explicit source/recipient, project/folder scope, curved communication links distinct from dependencies, unread/progress indicators and a collapsible exchange view. Keep ordinary canvas work uncluttered and provide keyboard/screen-reader equivalents.
- [ ] Preserve permissions and attribution: peer content is untrusted data; sharing is scoped and visible; no automatic cross-project disclosure, tool approval, shared filesystem authority or evidence acceptance. Define user and agent-initiated interaction separately.
- [ ] Implement bounded durable delivery, unique message/request identity, queued/delivered/read distinctions, safe unknown-outcome recovery, cancellation/disconnection, pending-recipient handling, and loop/rate/concurrency/token budgets. Preserve active turns and questions/approvals unless an explicit supported action changes them.
- [ ] Prove bidirectional coordination between real independent live Muse sessions, with visible native/model receipt and useful resulting work. Exercise idle/active/waiting peers, approvals/rejections, crashes/restarts, duplicate/expired messages and all three operating systems; complete R11/R12/R13 gates. This remains a release blocker until its agreed scope is implemented and verified.

### R17 - Account menu and in-app Help

Requested 15 October from the supplied menu screenshots. Keep the menu compact and legible, with progressive disclosure rather than another permanent panel.

- [ ] Show the effective signed-in identity using Muse's optional experimental `account/read.label`, with a clear subscription / API key / signed-out fallback. Do not infer an account name from a key, OS identity or opaque provider identifier. The installed native schema (unchanged between 1.4.9 and 1.4.10) also declares optional display-only `avatarUrl`; remote image handling must respect CSP/privacy and have a local initials fallback.
- [ ] Show a friendly subscription plan only when a documented provider mapping or explicit display name is available. The pinned SDK `SubscriptionUsage.tier` is the verbatim provider tier ID, not a guaranteed user-facing name. Retain unknown IDs in diagnostics rather than the primary menu; verify upgraded contracts before promising a Pro-style label.
- [ ] Add a compact weekly remaining-usage figure beside Usage, with observation/freshness and unavailable/offline states. Read usage without interrupting a turn or sending a model request; do not confuse subscription allowance with API billing. Avoid independent background hosts or aggressive menu polling.
- [x] Initial offline Help library: searchable, keyboard-accessible guides and contextual setup/session/usage/local-message actions, with honest unsupported-feature language. Real Rust-backed UI checks cover offline search, empty results, navigation and accessibility; isolated macOS native search, empty results and contextual navigation also passed. Full platform acceptance remains below.
- [ ] Add Help opening a searchable in-app knowledgebase with concise guides for setup/Muse installation, browser subscription versus BYOK, sessions/projects/folder access, models/effort, usage, skills, attachments, local session communication, approvals, recovery/background work, updates and troubleshooting. Supported behaviour and limitations must match the release; useful offline basics, keyboard navigation and contextual links are required.
- [ ] Provide one **Log out** menu entry, replacing the competing Quit & stop entry, per the user’s clarification. Design one contextual exit dialog: pause running work with verified resumable checkpoints or explicitly keep authorised local work running, when supported. Explain credential revocation versus background execution accurately; never promise continued authenticated work after revoking the credential it requires. Window close/update behaviour follows an explicit saved background-work preference. Validate the complete flow under R13; do not retain both top-level actions or merely rename process termination to logout.
- [ ] Validate reported/missing identity, opaque tiers, subscription/API-key precedence, stale usage, logout with pending work and Help accessibility in native apps across all three operating systems. No account details are sent to a knowledgebase service.

## Developer-workflow scope for the first release

Scope decided by the user on 18 October; later work is in the [roadmap](../ROADMAP.md).

- [ ] **D1 - Git delivery: guarded commit only.** The first releases shipped a guarded commit of all Git-visible changes in the session's folder. Since v0.2.0 the app commits through selective staging (D6 below); the all-changes commit remains only as a protocol-compatible request without a revision. Commits never push, and the UI and Help say so. Branches, push, pull requests, merge/conflict help and hooks/signing are on the roadmap.
- [ ] **D2 - Editing: hand off to the user's editor.** Open a session's folder or a changed file in the user's own editor from the inspector, with validated paths and no shell. An embedded editor and an interactive terminal are on the roadmap; the present runner stays bounded and non-interactive.
- [ ] **D3 - Find and retain work:** global/session transcript search, export, archive browsing and a continuation path for archived work without accidental duplication or deletion.
21 October D3 increment: Search in now selects all sessions or one live/archived session; clear/scope changes invalidate late replies, temporary failures offer Retry search, and retained results select the matching task/message. Invalid or missing task targets are explained rather than misattributed. These workflow checks do not complete the native export/platform gate.

- [ ] **D4 - Attention:** desktop notifications with preferences, useful background-session status, persistent drafts and clear completion/stop/reconnect states.
- [ ] **D6 - Selective file and hunk staging** (authorised 4 November; shipped in v0.2.0, incompletely validated). In isolated task worktrees: view staged and unstaged changes, stage/unstage whole files or hunks, preview the exact commit content and commit only the staged index, leaving unselected edits in place. Rust owns mutations and receipts; actions are bound to a repository/index/working-tree revision and refused when stale. See [selective staging](staging.md).
  - [x] Revision-bound `workspace/changes`, atomic `workspace/stage` under Git's index lock and exact-index `workspace/commit` with a compare-and-swap branch update; definite refusals recorded as `rejected`.
  - [x] Workspace tab UI: Not staged / Staged lists, file and hunk checkboxes, Stage all, exact commit preview, loading/refusal states, keyboard operation, light/dark and narrow layouts.
  - [x] Rust real-repository tests and the rendered Rust-backed UI workflow (hunks in one file, multi-file selection, pre-staged plus unstaged, stage/unstage, commit leaving unselected edits, stale working-tree/index/commit refusal, special paths, Project folder isolation).
  - [x] Packaged macOS interaction (5 November, ST1-ST8 in [native acceptance](native-acceptance.md#selective-staging-d6-5-november)); the inspector overflow, in-progress wording and refusal wording findings were fixed. Native dark theme not exercised.
  - [x] Linux arm64 container: Rust staging tests and rendered workflows with Linux binaries. No packaged WebKitGTK window.
  - [x] Packaged Windows x64 interaction (5 November, Windows 10 build 19045.6466).
  - [x] Ship in a release: [v0.2.0](https://github.com/kabudu/lascoria/releases/tag/v0.2.0), 6 November.
  - [ ] Packaged Linux (WebKitGTK) window and native dark-theme interaction.
- [x] **D5 - Muse capabilities management: roadmap.** Skill discovery, invocation and attribution remain a release requirement under R9. Activation management and the plugin/MCP/settings workflow are on the roadmap, not the first release.

### R18 - Visible session permissions and capability checks

- [x] Put Model & effort and Permissions in the persistent main header, with session-specific profile changes and separately persisted defaults for future sessions.
- [x] Integrate native profile/catalogue reads and audited approval-mode/profile mutations through the Rust supervisor and official SDK, with human confirmation, stale-state rejection and conservative Read-only handling.
- [x] Implement a bounded same-boundary Muse capability task and require exact native shell execution evidence; never infer enforcement from model prose or use an unsandboxed fallback.
- [x] Pin the verified stable SDK/CLI pair to 1.4.14 / 1.4.14-R7309.1 and provide explicit checksum/fingerprint-verified test bootstrap.
- [x] Track final reviewed-head CI and remote review in [PR #25](https://github.com/kabudu/lascoria/pull/25), merged as `3ca8658` after final local CI and the three hosted native checks, and shipped in [v0.1.9](https://github.com/kabudu/lascoria/releases/tag/v0.1.9).
- [x] macOS arm64 native QA with a live subscription: Wonder and Spark turns, model/effort changes, cancelled/confirmed profile changes, a denied Read-only write, saved-default restart, exact native capability evidence and visible busy-node activity. This is an isolated ad hoc QA app, not signed distribution acceptance.
- [ ] Windows/Linux interactive native and live-provider acceptance for this increment. Hosted CI verifies fail-closed capability handling where sandbox support is unavailable; it does not establish positive sandbox execution or physical UI interaction on those platforms.
- [x] Make working nodes and helper agents visible with a bounded, indeterminate activity bar. Waiting, stale and completed states stay still; reduced motion and long-label layout are covered by rendered workflow tests.

See [permissions](permissions.md) for behaviour, boundaries and compatibility.

## Token efficiency, required for the first release

The user decided on 18 October that T1–T5 ship in the first release. They remain opt-in policies where they change behaviour, and none may silently drop instructions, history or permissions.

- [ ] **T1 - Measure first** (visibility implemented 18 October; validation open): per-task/session/model usage, cache/reasoning counters where reported, context pressure and correctly deduplicated child-agent totals. Keep token counts, estimated API cost and subscription usage windows distinct; missing data stays unknown.
- [ ] **T2 - Reuse evidence** (test-result reuse implemented 18 October; validation open): reuse repository analysis, test results and reviews only while content/configuration fingerprints remain valid. Preserve provenance and invalidate on relevant changes.
- [ ] **T3 - Bound work** (budgets, repeat and concurrency warnings implemented 18 October; validation open): explicit delegation/concurrency budgets, duplicate-work/loop detection and warnings before admitting more work. Any spend limit based on post-call counters is a soft limit with in-flight overshoot, not guaranteed billing enforcement.
- [ ] **T4 - Optional policies** (economical preset and native compaction implemented 18 October; validation open): economical model/effort presets with user-visible escalation, focused context handoffs and deliberate use of Muse-native compaction. Preserve user instructions, correctness and permission boundaries; do not silently truncate history or rewrite transcripts.
- [ ] **T5 - Benchmark savings** (harness implemented 18 October; initial six-task subscription comparison passed 19 October, broader gate open): compare tokens, correctness, retries and completion time on repeated identical tasks. Existing UI polling/paging and broker memory savings are not inference-token savings.

## Optional research

- [ ] Evaluate a Rust-native interactive MSP adapter using the staged conformance/performance gates in [the SDK assessment](rust-sdk-assessment.md). Keep the official SDK as production/reference until parity is proven. This is not a prerequisite for onboarding or app updates, and it does not solve provider billing or credential expiry.
- [ ] A dependency-aware task scheduler and automatic evidence acceptance need separately agreed semantics and trust boundaries; current graph assertions and human evidence do not implement them.

## Release history

The original dependency-ordered sequence is kept as history in [implementation progress](implementation-progress.md#original-completion-sequence-15-october). All three operating systems remain release requirements. New work is scheduled only by explicit authorisation, against the open gates above or a roadmap item. Each release below records distribution evidence only; it does not extend native platform acceptance or close unrelated gates.

### Universal macOS distribution

- [x] Implement one macOS release target and shared updater archive for Apple Silicon and Intel; bundle both slices of the desktop, supervisor and Node runtime.
- [x] Prove both slices in the signed universal candidate updater archive and mounted installer from `c31900e`, including notarization, Gatekeeper and production updater signatures. Actual public distribution remains a separate publication gate.

### First public binary release: v0.1.2 (22 October)

- [x] Publish the semantic version tag and curated [GitHub release](https://github.com/kabudu/lascoria/releases/tag/v0.1.2) with the complete 13-asset inventory.
- [x] Independently download all public assets and verify checksums, production updater signatures, five platform mappings and immutable source/tag/notes identity. Verify both architecture slices, Developer ID signatures, stapled notarization and Gatekeeper in the actual universal macOS installer and updater.
- [x] Verify the public stable and beta updater manifests match the signed release.
- [x] Deploy and verify the canonical website, public download links, consent, accessibility, HTTPS domains and apex redirects.

These publication checks do not change the scope of earlier native acceptance evidence or complete unrelated unchecked feature, performance or security work.

### v0.1.3 published update verification

- [x] Ship the reviewed toggle, inspector spacing, token visibility and direct archive fixes as [v0.1.3](https://github.com/kabudu/lascoria/releases/tag/v0.1.3), with matching semantic versions, curated notes, passing local/three-OS CI and the complete production build/publication workflow.
- [x] Verify all 13 actual public downloads and checksums, four updater signatures, universal macOS containers/signatures/tickets/Gatekeeper, Linux package architectures, release rendering, updater channels and website download routing. See the 22 October distribution record in implementation progress for scope; unrelated open platform/security/performance acceptance items remain unchanged.

### v0.1.6 distribution follow-up (26 October)

- [x] Ship the fixed Sessions-header archive action, strict archived-session visibility and panel layering as [v0.1.6](https://github.com/kabudu/lascoria/releases/tag/v0.1.6), after final local and three-OS hosted checks. The complete production workflow and independent public asset, checksum, updater-signature, universal Mac, Linux architecture, Windows version and channel verification passed. See the [running evidence](implementation-progress.md#v016-release-checklist-26-october).

26 October canvas follow-up: the visibility filter now also governs canvas and inspector selection. Hiding an archived selection opens unarchived work or clears both surfaces when none remains. The Sessions panel stays available for explicit read-only history access. Regression tests with task nodes, real Rust-backed archive/history workflows and isolated native macOS Echo QA pass; final-head CI is recorded in the PR.

### v0.1.7 distribution follow-up (26 October)

- [x] Ship consistent archived-session visibility across list, canvas and inspector as [v0.1.7](https://github.com/kabudu/lascoria/releases/tag/v0.1.7). Final local and three-OS checks and the complete production workflow passed. Independent public asset, checksum, updater-signature, package architecture/version and channel verification passed. Native behaviour and distribution scope are recorded in [implementation progress](implementation-progress.md#v017-release-checklist-26-october).

### Session continuity and viewport discovery follow-up (2 November)

- [x] Link successive same-session turns as conversation order, distinguish real ownership/manual relationships, reveal active and offscreen work, and prefer free current-viewport space for new cards without rearranging saved cards. Standalone/Project, reload, interaction, crowded/occluded/narrow and bounded-storage regression workflows pass; isolated native macOS Echo QA confirms the presentation. This is not a live-provider trial or Windows/Linux native interaction acceptance. See [implementation progress](implementation-progress.md#session-continuity-and-viewport-discovery-2-november) for scope and the PR for final-head CI.

### v0.1.8 distribution (2 November)

- [x] Ship session-order curves, current-work reveal and viewport-aware card placement as [v0.1.8](https://github.com/kabudu/lascoria/releases/tag/v0.1.8) after PR #23 and release PR #24. Final local and three-OS checks, all four package builds and production publication passed; all public downloads, updater signatures, universal Mac containers, Windows installer version, both Linux architectures and update channels were independently verified.

### v0.1.9 distribution (3 November)

- [x] Ship visible session permissions, direct model/effort controls, working-node activity and the Muse 1.4.14 / 1.4.14-R7309.1 pin as [v0.1.9](https://github.com/kabudu/lascoria/releases/tag/v0.1.9). Implementation PR #25 merged as `3ca8658`; release PR #26 merged as `0d7a993`, which annotated tag `v0.1.9` points to. [Production run 41588667199](https://github.com/kabudu/lascoria/actions/runs/41588667199) passed validation, four platform builds and publication. Independent verification passed for all 13 assets and checksums, four production-key updater signatures, five manifest platform entries, universal Mac slices/signatures/notarization/Gatekeeper, an isolated packaged-runtime Echo lifecycle, Windows PE/version and Linux x64/ARM64 AppImage/Deb/runtime metadata. All 11 binary/signature files match the original build artifacts; stable, version-specific and beta manifests match; website release routing passes. See [implementation progress](implementation-progress.md#v019-release-checklist-3-november). These package checks do not establish new physical Windows or Linux acceptance; R18 platform acceptance stays open.
