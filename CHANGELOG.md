# Changelog

## Unreleased

- History search can target one session, retry temporary failures, and open the matching task/message; cleared queries and changed scopes ignore late replies. Unicode lowercase matches are retained even for ASCII queries.

- Background Git refuses files selecting configured conversion filters instead of running their programs; failed task checkout cleans up its owned worktree and branch.

- Data & backups can retry a failed read in place; destructive confirmations support safe keyboard focus and cancellation, and lost replies no longer claim that data is unchanged.

- Skill-load attribution requires a matching native turn identity; missing IDs cannot associate unrelated transcript entries.

- On Linux the program is now called `lascoria`, so notifications and window lists show Lascoria's name and icon, and the app is listed under Development.

- The shortcut picker now shows skills installed while a session is open: a list older than 30 seconds is refreshed each time the picker opens.

- When connecting sessions, a Project session is listed by its Project name and folder count instead of only its first folder.

- When a task runs a skill, the transcript shows the skill you requested and, separately, whether Muse reported loading it and from where. If Muse sends no report, Lascoria says so rather than guessing.

- Muse sessions' message and decision tools now work only through the helper Muse started for that session. Another program running the same helper, or a debugged or library-injected copy of the app on Linux, is refused.

- Windows Project sessions send the native canonical folder paths required by Muse, including isolated worktrees and folder changes for subsequent tasks.

- Native attachment drops enforce a shared 100 MB/eight-file intake limit and stay bound to the session where they were dropped. Special files are refused and overlapping reads are bounded.

- Drop files from your file manager onto the composer to attach them, or drop folders onto Project setup to add them.

- The in-app updater no longer includes a zip extractor, removing three known `zip` vulnerabilities from the dependency graph; Lascoria's signed updates were never zip archives.

- Project setup shows a map of the Project's folders around its goal. Arrange the cards by dragging or with the arrow keys; it is only a picture and never changes the folder order or what Muse receives.

- Project sessions can be isolated: each folder gets its own worktree and task branch. In the Workspace tab, choose a folder to preview, test or commit its changes; Discard removes every folder's worktree and keeps the branches.

- Collapsed Attention panels avoid rendering hidden request rows while keeping their counts and notifications current.

- Expanded canvas tools flow below session controls on narrower windows, keeping New session reachable. Decision assistance reserves daily spending atomically, retains allowance counts after cleanup and refuses stale update or tool advice.

- Project sessions can save Diff snapshots again, one folder at a time: choose the folder beside Save snapshot. The snapshot names its folder and is checked against that repository only.

- Attach file in the composer now also takes one MP4 or QuickTime video per task (up to 100 MB) and UTF-8 text files such as code, notes or logs (up to 256 KB each). Each is checked by its content and sent only with the next task; PDFs, audio, archives and office documents are refused with the reason.

- Optional decision assistance can review a selected diff snapshot using your Jev, SubQ or OpenAI API key. Configure it per workspace, inspect exactly what will be sent, and explicitly request separately billed advice. Results cannot accept evidence or change Muse permissions; lost replies are retrieved without repeating a paid call. Optional background triage notes when a session likely needs you, and an optional tool lets Muse ask your decision model a question; both are off until you turn them on for a workspace. A usage summary and Seems right / Seems wrong marks help you judge the advice.

- Settings keep their heading, search and section list in view while a long section scrolls, and the section list is a single tab stop (arrow keys move within it).

- Settings radio controls stay beside their labels, and session actions wrap so Project folders remain accessible alongside editor handoff.

- Update cancellation and channel changes cannot restore an older download after it was discarded. Installing shares the verified package buffer to avoid a second full copy in memory.

- Token efficiency (Settings, Token efficiency): optional task budgets that warn or stop a task, warnings when Muse repeats the same tool call or many tasks run at once, an Economical reasoning-effort preset for new sessions, one-click Muse compaction when the context fills up, and reuse of an unchanged test result instead of running tests again.

- In-app updates (Settings, Updates): Lascoria checks for new versions, shows what changed, and downloads and installs signature-checked updates only when you choose. Running work is never interrupted by surprise.

- **Settings…** in the workspace menu brings every app setting into one dialog, grouped and searchable.

- **Open in editor** opens a session's folder, or a file from it, in your editor of choice (set in Settings, Editor).

- **Token use** in the task inspector shows how many tokens a session and the selected task used, how full the model's context is, subagent use and Muse's API price estimate. It is collapsed by default and separate from your subscription allowance.

- Projects can have an optional goal and a short note for each folder. Muse receives them with the first task of a Project session, so it knows how the folders fit together; your transcript still shows only what you typed.

- **Support report** (workspace menu) prepares a summary of versions, session states and data sizes to help diagnose problems. You read exactly what it contains before saving it; it never includes your tasks, conversations, file paths, names or keys, and is never sent anywhere.

- Security hardening: file context is checked against the file actually opened, so a folder swapped for a link mid-read cannot expose files outside the repository, and the background service's access token is compared in constant time.

- The `/` shortcut picker opens instantly while you type: it reads a session's skills once and refreshes only when Muse reports a change. Lascoria's own commands are listed separately from Muse skills, each skill shows where it comes from, and a skill hidden by a Lascoria command is explained.

- **Account & usage** (workspace menu, formerly Usage) shows your subscription allowance even with no session open, using the most recent report from any session. It shows when each window resets as a countdown and a local time, how old Muse's report is, and says when figures may be out of date or a window has reset since the last report, instead of showing old numbers as current.

- Safer image staging: the composer refuses images over 5 MB before reading them even when the limits have not loaded, the 64 MB staging total now counts every upload from the moment it starts (across sessions and concurrent uploads), and Retry after a lost reply resumes the same upload instead of leaving a duplicate.

- Keep Lascoria responsive with long histories: status, task progress and recovery no longer read the whole command history, so their cost stays flat as history grows (status 40 times faster with 20,000 records) and the background service uses less memory.

- Lower idle CPU: the window no longer re-renders the whole workspace every two seconds while checking your account; with ten idle sessions Lascoria's own processes use about 0.7% of one core instead of 1.2%.

- Optional desktop notifications (workspace menu, **Notifications**) for questions, permission requests, failed tasks, unexpected stops and finished tasks while Lascoria is in the background. Off by default; choose which kinds and which sessions. Notifications name the session, never your task text, and nothing already waiting is announced when you reopen Lascoria.

- Export a session's retained transcript as a Markdown file from **Export transcript…** beside the session heading.

- Add images to a task: choose, paste or drop PNG, JPEG, GIF or WebP images onto the composer. They wait privately for that session, survive reloads and are sent only with the next task you start.

- Apply an edited Project's folders to an existing session with its next task: the composer shows what changed and applies it only when you tick the box; running tasks and the default folder never change underneath you.

- Require Muse 1.4.10 and the official SDK 1.4.10 (same protocol schema as 1.4.9). Setup now finds a compatible Muse even when an older one was selected before, and one repository check keeps the pinned version consistent across the SDK, workers and installer.

- Bind supervisor control to the desktop app that started it, so repository scripts and tools that can read the control token cannot approve permissions or drive sessions; the session message helper is limited to its three tools and the diagnostic bridge exists only in debug builds.

- Search the messages Lascoria keeps for every session, including archived ones, and continue archived work in a linked new session without starting a model turn.

- Replace Quit & stop with one Log out entry that asks whether to keep work running, pause and quit, or sign out and quit, and can remember the choice for closing the window. Show Muse's account label and the weekly allowance left in the workspace menu.

- Add Data & backups: private verified backups, export and import, restores applied safely on the next start without changing sign-in or billing, removal of archived sessions with an automatic backup, and compaction of older command history that never replays a request.

- Choose Session and Project folders with a native Browse action, retaining editable paths, local-only staging and clear cancellation/failure behaviour.

- Keep Project folder details, Rename and expanded canvas tools accessible above floating panels; tuck tools away when opening Session links, and improve native dropdown sizing and Project submission feedback.

- Add reusable named Projects with ordered native Muse folder context, safe revision-bound starts, durable configuration and explicit Git limitations.

- Add optional session names at creation and a discoverable Rename action, with durable per-session conflicts, safe save retries and consistent names across the workspace and local messaging.

- Add an opt-in floating Session links view with curved local-message connections, current peer status, new-message counts and direct conversation navigation.

- Surface new local messages across sessions in one quiet workspace entry, with exact recipient/conversation navigation and no automatic read receipts or model calls.

- Keep saved-review reads available during session admission, preventing a transient error when a newly created session first appears.

- Include portable relay recovery checks in native QA packages and verify the installed-resource runtime on ARM64 Linux.

- Add searchable offline Help with contextual account, session, usage and local-message actions and clear current feature limits.

- Wait for pending session and local-message draft saves before explicit supervisor shutdown.

- Distinguish new local session messages from text explicitly marked viewed in Lascoria, with durable recipient-owned receipts and no automatic model calls.

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
