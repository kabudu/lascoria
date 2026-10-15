# Lascoria release-readiness backlog

Updated 15 October 2026. Implementation is active; see the [running checklist](implementation-progress.md). This is the consolidated product/release backlog, not a claim that Lascoria is ready to distribute. Historical validation records remain in the stage documents. An unchecked item is planned or outstanding; checked implementation elsewhere does not close a release gate without its acceptance evidence.

The user requested missing-Muse onboarding, in-app update checks backed by platform GitHub Releases, and renaming the repository to `lascoria`. Implementation is tracked below and in the running checklist. Repository rename is complete; public visibility, software installation and publishing remain separate actions.

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
- [ ] Produce signed application/installer artifacts, macOS notarization where applicable, updater signatures, dependency/license notices and version/provenance metadata. Keep signing keys in release infrastructure, never in source or downloadable apps.
- [ ] Validate fresh install, launch, permissions, uninstall/retained-data behaviour and reinstall on every advertised platform/architecture without developer tools installed.

### R3 - In-app updates from GitHub Releases

- [ ] Add **Check for updates** in Settings/About and bounded automatic startup/periodic checks with a user preference, no overlapping requests, timeouts and backoff. Show installed/latest version, last successful check, release notes, up-to-date, offline and failure states. Checks use ordinary networking, never model calls.
- [ ] Use the supported Tauri updater with signed platform/architecture artifacts and a release manifest hosted through GitHub Releases. Verify signatures before installation and reject wrong-target, tampered or incompatible artifacts. Keep stable and prerelease selection explicit; do not silently move stable users to prereleases.
- [ ] Download with progress/cancellation and offer explicit **Install and restart** or **Later**. Automatic checking does not imply forced installation or interruption of active work.
- [ ] Coordinate the UI, Rust supervisor, Node worker and Muse compatibility as one versioned contract. A compatible UI-only replacement may retain the background supervisor; an incompatible/runtime update must wait until idle or obtain consent to gracefully stop active turns, persist state, stop the old supervisor and recover after replacement. Never spawn two writers or keep an obsolete worker alive against replaced resources.
- [ ] Preserve account policy, inactive API keys, drafts once durable, worktrees, sessions and evidence. Validate migrations and a recoverable failed-update path. Do not promise binary downgrade when a newer database schema refuses it; backup/restore and rollback policy must agree.
- [ ] CI builds/tests each supported target, creates signed updater artifacts and publishes versioned GitHub releases/manifests only after gates pass. Anonymous public installs must not contain a GitHub personal access token; public availability is a separate release step while this repository remains private.
- [ ] Exercise real packaged N-to-N+1 install, idle and active-session update, question/approval waiting states, UI reopen, interrupted download/install, invalid signature, unavailable GitHub/rate limits, incompatible supervisor, migration failure and unsupported target. Verify no command/tool replay and correct restored progress.

Reference: [Tauri v2 updater](https://v2.tauri.app/plugin/updater/) supports signed update artifacts and static manifests on GitHub Releases. Lascoria has not integrated it yet. Existing live UI-close/reconnect and graceful-logout proofs in [accounts](accounts.md) are prerequisites, not an update-install proof.

### R4 - Repository rename and public-release preparation

- [x] Rename `kabudu/spatial-constellation-harness` to `kabudu/lascoria`, checking target availability immediately before the operation. Update and verify local origin, package metadata, README links, issue/repository URLs, CI, badges and future release/updater endpoints. Preserve Git history and verify fetch/push against the renamed repository.
- [ ] Keep existing application identifiers, persistent state paths, task branches and evidence fingerprints compatible unless a separate migration is implemented. Renaming the local checkout is optional and must not break installed/development resource paths.
- [ ] Before making the repository public, review tracked files and history for credentials/private data, licensing/redistribution rights, security reporting, support expectations and contributor guidance. Keep local `.dev` credentials and live transcripts excluded. A rename is not authorization to make the repository public.
- [ ] Add reproducible CI/build/release instructions, supported versions, changelog/tag policy, artifact checksums/provenance and clean-machine installation documentation. Publish only the targets that passed R2/R3.

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

- [ ] Complete native VoiceOver and keyboard-only journeys, focus restoration, zoom/text scaling, supported window sizes and both themes. Existing automated WCAG checks are a foundation, not a full native accessibility audit.
- [ ] Test unavailable Muse/runtime, authentication, permissions, network failures, disk-full/locked Keychain, malformed/incompatible history and exhausted resource limits with clear recovery actions and no secret-bearing errors.
- [ ] Add privacy-safe diagnostic export/support information with explicit preview/redaction boundaries. Define log retention and ensure installed builds do not depend on ignored development artifacts.

### R8 - Subscription usage in Settings and non-interrupting `/usage`

- [ ] Add **Settings → Account & usage** with subscription tier, separate current-window and weekly used/remaining percentage bars, reset countdowns plus absolute local reset times, last-observed timestamp, refresh and clear unavailable/stale states. Include a compact optional workspace indicator; keep detailed information out of the main canvas by default.
- [ ] Read native `usage/read` and observe `usage/changed` through a bounded read-only path independent of model commands, session mutation queues and slow recovery. Opening/refreshing usage must not start, steer, cancel, interrupt or restart a turn/host, generate inference, create a transcript message or change the selected billing route. Do not invoke the interactive CLI's `/usage` screen.
- [ ] Intercept the exact local `/usage` command in the composer and command palette to open the same usage view, including while a model, tool or subagent is active. Preserve the existing task draft, selected session, pending approvals/questions and keyboard focus on dismissal. Partial matching must not consume ordinary text or a skill invocation accidentally.
- [ ] Treat subscription readings as account/host observations, not per-session allocations: never add identical quota windows from multiple hosts. Display the freshest valid observation for the current account, invalidate on account changes, and preserve its freshness timestamp. Unknown/absent usage is not 0% used or 100% available; over-quota readings remain visible even when remaining percentage is clamped to zero.
- [ ] Keep subscription allowance separate from task tokens, model context occupancy and API billing estimates. Exact remaining requests/tokens, renewal dates and payment balances are shown only if the provider supplies them. Background refresh cannot promise fresher data than Muse's last observation, and must not send a synthetic prompt to obtain a number.
- [ ] Validate native/live availability on subscription, no-observation, stale/offline, API-key and signed-out states; rapid open/close and multiple sessions; foreground streaming, tools, subagents and waiting approvals/questions. Assert no extra model calls or cancellation/restart events and unchanged active turn identity.

The installed SDK exposes tier, current-window duration/used percentage/reset and weekly used percentage/reset with `observedAtMs`. Muse documents that the served usage query reads observed windows without spending a prompt: [Muse changelog](https://dev.meta.ai/docs/muse-code/changelog). These fields support a clear allowance dashboard; they do not establish access to full account billing information. The UI is not implemented yet.

### R9 - Native Muse slash-command and skill picker

- [ ] Typing `/` at a command position in the composer opens an anchored, height-bounded, scrollable and searchable picker. Show supported Lascoria commands separately from Muse skills, with name, concise description, source badge (built-in/user/project/plugin) and argument hint when supplied. Support keyboard arrows, Enter/Tab selection, Escape dismissal, mouse selection and screen-reader announcements; keep the highlighted row in view.
- [ ] Discover user-invocable skills through per-session native `skill/list`, respecting the selected workspace, plugin state, activation and native name resolution. Show actual available built-in skills rather than a hardcoded marketing list; exclude non-user-invocable entries. Handle qualified plugin selectors, duplicate display names, reserved local commands and conflicts without silently invoking another skill.
- [ ] Selecting a skill inserts the exact native selector into the draft, ready for optional arguments; it does not execute automatically, expand the skill body in React or submit a model turn. On explicit submission, use Muse's native typed invocation path and preserve normal permissions and provenance. Do not manufacture a separate Lascoria interpretation of the skill instructions.
- [ ] Opening, filtering or selecting while a turn runs must not interrupt it. Retain the selection in the next-turn draft; any immediate steering/queueing action requires an explicit supported interaction and validated native semantics. Loading/reloading the list uses bounded queries, not prompts; invalidate the session-scoped cache when native skill state changes or session/workspace changes.
- [ ] Show requested skill invocation separately from observed skill use. Attribute execution/loading only when Muse reports the corresponding tool/event evidence, retaining source/session provenance. Missing evidence is unknown, not proof that a skill did or did not run.
- [ ] Validate built-in, user, project and plugin skills, empty/unavailable catalogs, disabled/conflicting selectors, arguments, session switching, long lists, keyboard/accessibility, active-turn non-interruption and a real native skill invocation. Negotiate any experimental capability required by the pinned Muse version; SDK type declarations alone are not runtime proof.

References: [native skill discovery](https://meta-models.github.io/muse-code-sdk/next/generated/msp/methods/skill-list/), [skills in SDK sessions](https://meta-models.github.io/muse-code-sdk/next/guides/plugins/concepts/plugins-in-sdk-sessions/). Discovery and typed invocation are supported by Muse; Lascoria's picker and explicit usage UI are not implemented yet.

### R10 - Optional BYOK decision providers, with a quiet UI

User requirement added 15 October: support Jev (TypeSafe), Subquadratic/SubQ and OpenAI decision APIs with user-supplied keys. Research/design first; do not interpret this item as permission to transmit repository material or activate paid calls by default. A clean, uncluttered workspace is a fundamental product constraint.

Verified first-party contracts (15 October 2026; recheck before implementation):

| Provider | API and documented shape | Source |
| --- | --- | --- |
| Jev / TypeSafe | `POST https://api.typesafe.ai/v1/systemone`; `model`, shared `state`, named typed `questions`; named answers and usage. `noul`, `choice` and `score` are provider-native types. | [TypeSafe API](https://docs.typesafe.ai/api) |
| SubQ | `POST https://api.subq.ai/v1/systemone`; `subq-snap-preview`, shared state and 1–16 named `noul`/`choice`/`score` questions. Public preview, with probabilities and reported usage. | [SubQ Decisions](https://docs.subq.ai/endpoints/decisions-api/) |
| OpenAI | Dedicated `POST /v1/decisions`, not Responses; public beta currently documents `gpt-6-luna`, shared `input` and named `predicate`/`choice`/`score` questions, with an answers array. | [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) |

- [ ] Design **Settings → Integrations → Decision assistance** for BYOK provider/model configuration, native-vault storage, explicit connection testing and per-workspace enablement. Keep Muse subscription and its API key separate from these independently billed services. Keys never enter React state after submission, command journals, argv, exported diagnostics or Muse prompts. Honour provider retention/data-use settings and expose the actual destination before enabling any integration.
- [ ] Agree the initial interaction model before enabling automatic policy: (a) user-requested evaluation of selected evidence, (b) opt-in bounded background triage with scoped data, (c) an explicit tool usable by Muse, or a staged combination. Start with advisory results; model routing, autonomous gates and scheduler actions require separately defined policy/permission semantics. Do not silently replace Muse's execution model or masquerade as its native permission reviewer.
- [ ] Use a Rust-owned bounded decision service and provider-specific adapters, not an assumed universal chat or OpenAI-compatible schema. Preserve native answer types, probabilities, resolved model and request identity. Version rubrics and input/evidence fingerprints; reject stale answers after revisions change. Provider confidence is not guaranteed correctness or directly comparable calibration between providers.
- [ ] Keep the default canvas unchanged. No always-visible provider cards, extra floating panels or per-call toasts. Offer details through the existing inspector/usage/settings surfaces; expose a small task indicator only when relevant/actionable or explicitly enabled. The user can inspect the outcome, source/provider/model, input scope, timestamp, rubric version, uncertainty and whether a recommendation was applied. No fabricated chain-of-thought or explanation when the API did not return one.
- [ ] Provide optional metrics: calls, reported tokens, estimated/known cost provenance, latency distributions, errors/rate limits, cache reuse, policy outcomes and human overrides, per provider/task/workspace. Aggregate summaries live in Usage; detailed traces stay opt-in and privacy-safe. Do not imply external BYOK charges are covered by a Muse subscription or claim savings without a task-quality benchmark.
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

Historical reference only: [14 October Stage C memory results](stage-c-memory.md#measured-results-14-october-2026) recorded 207.7 MB UI/control RSS and 0.68% of one core idle for ten sessions, but 1,613.5 MB and 5.60% including ten native Muse hosts. That used SDK/Muse 1.4.8 and does not certify current 1.4.9 builds.

### R12 - Full security review before public release

Added 15 October at the user's request. This is a release gate requiring an evidence-based review and remediation, not a claim that the current implementation has passed a security audit.

- [ ] Document the threat model, assets, trust boundaries and supported deployment assumptions across React/WebView, Tauri commands, Rust supervisor, local IPC, Node SDK workers, Muse, tools, repositories, plugins/skills, provider APIs and release infrastructure. Treat repository files, model/tool output, transcripts and remote metadata as untrusted input; distinguish same-user code execution from other local users and remote attackers.
- [ ] Review authentication and authorization end to end: subscription/API-key precedence, logout/recovery barriers, account/session isolation, credential expiry/revocation, native-vault use, secret lifetimes and redaction. Verify no credentials leak into frontend persistence, argv, command journals, logs, crash reports, diagnostics, exports, Git history or artifacts; cover unavailable/locked vaults and explicit BYOK data disclosure.
- [ ] Audit every frontend-to-native and IPC boundary for least privilege, command/capability allowlists, caller/peer identity, token handling, endpoint spoofing, replay/idempotency, path and URL validation, size/time/concurrency bounds and unauthorized state changes. Review WebView CSP/navigation, HTML/Markdown/diff rendering, external links and browser handoff for injection or unintended execution.
- [ ] Review filesystem and process ownership: private permissions/DACLs, links/reparse points, canonical containment and race windows, Git/worktree operations, destructive actions, shell/argument handling, child environments, process-tree cleanup and crash recovery. Test malicious repositories, filenames, symlinks, hooks/configuration and tool output without weakening native approvals or replaying uncertain side effects.
- [ ] Audit Muse skills/plugins/MCP and optional decision integrations for prompt-injection and confused-deputy paths, unintended cross-workspace access, permission escalation, data exfiltration and automatic acceptance. Preserve native permission authority and revision-bound evidence; model output or provider confidence must never grant approval by itself.
- [ ] Review dependency and distribution supply chains: Rust/npm/SDK/runtime dependencies, reproducible lockfiles, known vulnerabilities, licenses/provenance, vendor downloads and redirects, integrity checks, installer activation, CI action pinning/permissions, signing/notarization, updater signatures, artifact ownership and rollback/migration safety. Include public-repository history/secret scanning and release-secret handling before open-sourcing.
- [ ] Exercise adversarial failure and abuse cases on macOS, Windows and Linux: malformed/fuzzed protocol frames, stale credentials/evidence, interrupted writes/install/update, cross-user IPC attempts, endpoint replacement, queue/resource exhaustion, hostile histories/diffs and crash/restart races. Use disposable environments and bounded tests; record exact revisions, environments, methods, findings and reproduction evidence.
- [ ] Maintain a severity-ranked findings register with owner, remediation, regression proof and residual risk. Fix exploitable authorization, credential disclosure, unsafe execution/update, data-loss and serious availability findings before release. Any unresolved risk requires explicit acceptance and documented scope; a passing scanner or test suite alone does not close this gate. Obtain a separate reviewer where practical, define vulnerability reporting/response guidance and rerun affected checks after fixes.

## Developer-workflow priorities to scope before calling it a daily-driver release

These are known gaps from [daily coding workflow](daily-coding-workflow.md), not promises that every feature must ship in the first public preview. Decide an explicit preview scope and label unsupported actions rather than hide them.

- [ ] **D1 - Git delivery:** selected-file/hunk staging, branch visibility, push, PR creation, merge/conflict handling and applicable repository hooks/signing. Current guarded commit stages all Git-visible changes and does not push; the UI must make those limits clear.
- [ ] **D2 - Editing and terminal:** open in the user's editor, file/diff navigation and a defined interactive-terminal story. An embedded editor/PTY is an option; the present runner is bounded and non-interactive.
- [ ] **D3 - Find and retain work:** global/session transcript search, export, archive browsing and a continuation path for archived work without accidental duplication or deletion.
- [ ] **D4 - Attention:** desktop notifications with preferences, useful background-session status, persistent drafts and clear completion/stop/reconnect states.
- [ ] **D5 - Muse capabilities:** skill discovery/invocation/attribution is a release requirement under R9. Separately define the exposed activation-management, plugin/MCP/settings workflow and supported scope.

## Token-efficiency follow-up

Requested for consideration in the preceding discussion; these policies are not implemented merely because Muse exposes usage events.

- [ ] **T1 - Measure first:** per-task/session/model usage, cache/reasoning counters where reported, context pressure and correctly deduplicated child-agent totals. Keep token counts, estimated API cost and subscription usage windows distinct; missing data stays unknown.
- [ ] **T2 - Reuse evidence:** reuse repository analysis, test results and reviews only while content/configuration fingerprints remain valid. Preserve provenance and invalidate on relevant changes.
- [ ] **T3 - Bound work:** explicit delegation/concurrency budgets, duplicate-work/loop detection and warnings before admitting more work. Any spend limit based on post-call counters is a soft limit with in-flight overshoot, not guaranteed billing enforcement.
- [ ] **T4 - Optional policies:** economical model/effort presets with user-visible escalation, focused context handoffs and deliberate use of Muse-native compaction. Preserve user instructions, correctness and permission boundaries; do not silently truncate history or rewrite transcripts.
- [ ] **T5 - Benchmark savings:** compare tokens, correctness, retries and completion time on repeated identical tasks. Existing UI polling/paging and broker memory savings are not inference-token savings.

## Optional research

- [ ] Evaluate a Rust-native interactive MSP adapter using the staged conformance/performance gates in [the SDK assessment](rust-sdk-assessment.md). Keep the official SDK as production/reference until parity is proven. This is not a prerequisite for onboarding or app updates, and it does not solve provider billing or credential expiry.
- [ ] A dependency-aware task scheduler and automatic evidence acceptance need separately agreed semantics and trust boundaries; current graph assertions and human evidence do not implement them.

## Suggested implementation order

1. R1/R2 together: installed-runtime packaging and Muse onboarding on the first supported platform.
2. R5 durable drafts/data lifecycle, while retaining existing account/recovery behaviour.
3. R4 rename/link/CI preparation while keeping public visibility as a separate deliberate action.
4. R3 signed GitHub release/update pipeline and real upgrade tests, with the active-work contract enforced.
5. R8/R9 usage and slash-skill UX; T1 token instrumentation can share the observation plumbing while preserving quota/token distinctions. R6/R7 remaining performance, usability, accessibility and failure gates; agree which D-items block the intended preview before optimisation policies.
6. Public preview only after the chosen target matrix and acceptance gates pass. Add other platforms only with their own installed/native/live validation.
