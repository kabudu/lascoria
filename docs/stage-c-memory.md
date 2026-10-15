# Stage C memory reduction and session settings

## Design and recovery boundary

The default Rust supervisor now owns one Node SDK broker with at most ten session contexts in one V8 heap. Every context still owns its own official SDK connection, authoritative fold and independent native Muse process. Only SDK process overhead is shared; tools, permissions, durable logs and provider authentication remain Muse responsibilities. This replaces the measured ten-process control-plane baseline without replacing the official SDK or parsing CLI transcripts.

The private protocol tags every frame with session ID and worker generation. Rust routes state and acknowledgements to the matching slot and keeps its existing database generation checks. Session contexts have independent admission guards, event/history budgets and 25 ms snapshot coalescing. The broker keeps the existing 64 KiB request, 4 MiB response and 8 MiB pending stdout budgets; oversized wrapped requests are refused before dispatch. There is no unbounded command queue. Commands remain journaled before dispatch, with no automatic replay of uncertain side effects.

A native Muse failure closes and recovers its own context. A broker failure is a shared failure: all registered contexts become unavailable with retained interruption facts, their pending responses fail, native hosts lose their stdio owner, and the supervisor performs its bounded durable recovery for each affected session. One broker is recreated, not one per failed slot. A timed-out context is closed and marked unavailable; failure to confirm its closure drains the broker rather than leaving an uncontrolled context running. Broken/malformed broker output also closes the broker even when recovery budgets are exhausted. The status/diagnostics read path remains independent of the session command lanes.

This trades the old per-process SDK fault boundary for lower resident memory. A V8/process failure can interrupt all ten contexts. A per-session Muse crash remains isolated; the broker is not a sandbox between sessions belonging to the same user. Event/byte/history caps and recovery attempt limits are unchanged. A maximal active-history workload is not asserted to meet the idle memory budget.

`SCH_DEDICATED_WORKERS=1` retains the previous process-per-session transport for comparison and diagnostics. `SCH_WORKER` custom fixture overrides also retain that transport. Neither mode changes durable Muse history or the public command journal. The same extracted session implementation backs both transports. Node RSS in per-session diagnostics is process-scoped: deduplicate `processId` when multiple sessions share it. Snapshot construction counters remain per-context.

## Idle snapshot allocation

The authenticated `status` read accepts an optional `since` version. A matching version returns only `unchanged`, `version` and supervisor PID. The GUI retains its existing snapshot instead of deserializing and rendering the same full state every second. Full reads remain available for benchmarks and compatibility. A random database-open epoch plus SQLite connection total-change count invalidates the version for every journal/state/presentation write and every supervisor restart. Rolled-back writes may cause harmless extra full reads. The GUI rejects older replies within an epoch and uses request ordering across epochs. This adds no snapshot cache or hashing of large state.

## Change model or effort mid-session

In a selected root task's inspector, open **Session model & effort**. Choose **Session model** and **Apply model**, or adjust the labelled **Reasoning effort** slider and **Apply effort**. The slider uses only advertised tiers, preserves the current supported setting and otherwise selects the model's advertised default. Older catalogs without a default use medium when supported, then their middle tier. Changing the model previews that model's default; apply the model before saving its effort. An empty catalog explains that settings are unavailable instead of displaying an empty picker. The dialog is bound to that session ID; inspecting a different session does not retarget an in-flight setting command. Child execution controls remain unavailable from read-only child inspection. An older supervisor without `sessionSettings` does not enable the button.

Models and effort tiers come from the current session's Muse catalog. The client does not invent unsupported tiers, silently fall back to another model, or treat an admission acknowledgement as completion of the running inference.

- Model changes use native `session/setModel`. Selection is admitted now and takes effect at the next model-call boundary, potentially within the current turn. Existing streamed text stays in its original history.
- Effort changes use native `session/setReasoningEffort`. The standing default is durable on acknowledgement and applies to subsequent turns; a running turn retains the effort it already resolved.
- Observed settings come from authoritative SDK session-state families, with session/start or resume as the model-route fallback. Cold replay restores setting changes. A setting does not rewrite previous evidence, transcript, permissions or approvals.
- Rejection and uncertain outcomes are visible. A setting with uncertain outcome must be inspected using the command journal/current state before another command is issued; it is not automatically resubmitted.

The public API adds `models` (read), `setModel` (`sessionId`, `modelId`) and `setEffort` (`sessionId`, `reasoningEffort`). Both mutations require a stable request ID and current session state, just like other execution controls. Reusing an ID with another setting is refused. Provider/profile routing comes from Muse's catalog. The model card describes the standing observed selection, not necessarily a model stream already in progress.

## Repeat the measurements

`npm run benchmark:runtime` still observes ten real echo sessions for five minutes and emits a JSON report. It now verifies source session IDs and expected SDK process count as well as session health. `SCH_BENCH_ENFORCE=1` requires all reported gates to pass. `SCH_DEDICATED_WORKERS=1` allows comparison against ten dedicated workers using the same session implementation. Use separate `SCH_BENCH_OUTPUT` paths to retain each report.

For the native GUI-inclusive observation, build an optimized, unsigned local app with `npx tauri build --bundles app`, close existing WebKit apps, and set `SCH_BENCH_GUI_BIN` to the app bundle's `Contents/MacOS/spatial-constellation-desktop` executable when running the runtime benchmark. No app is published or installed by that command.

On macOS, WebKit helpers have launchd parents, so descendant-only accounting would omit substantial GUI memory. This benchmark refuses pre-existing WebKit processes and conservatively charges every WebKit process appearing after GUI launch to the GUI cohort. Do not launch another WebKit application during observation. The report includes GUI, SDK/control, combined and full-tree memory/CPU separately, and records every sampled process identity. A changing cohort invalidates the stable-process gate. This is an explicit controlled-cohort assumption, not a general-purpose responsible-process attribution API.

The benchmark opens a temporary native workspace against its own supervisor and closes it at the end. It uses ten sessions with one completed turn each. The fifty-node/100,000-item projection benchmark remains a separate synthetic workload, and no 100,000-item native runtime proof is implied. Idle CPU is based on cumulative process time over the measured interval, including the GUI cohort when requested. Memory figures are sampled mean RSS; the 300 MB limit is decimal bytes. Short smoke runs explicitly fail the five-minute gate and must not be reported as full budget validation.

## Validation scope

The shared-broker integration test uses the real Rust socket, SDK, native Muse and scripted loopback provider. It changes model and effort while a turn is active, checks a subsequent provider request carries the chosen model/effort, verifies ID replay/conflict semantics, and executes a real permission-gated file write once. It then kills one Muse host, proving the other session's generation is unchanged, and kills the broker, proving both sessions recover without repeating the file write or mixing their state. Model and effort survive both recovery boundaries.

A second session is given a real turn before the crash test. The installed Muse host can fail to retain a never-used session after an abrupt owner loss; recovery of such a session is refused visibly instead of fabricating a session or replaying an initial task. The native new-session form already dispatches its required initial task immediately.

The React/native Rust bridge workflow also exercises the session-settings dialog and observes real SDK setting changes through the scripted provider. Long-running browser credential renewal and the remaining Stage C developer-usefulness/history-scale gates remain separate work.

## Measured results, 14 October 2026

Apple M4, macOS Darwin 27.0.0 arm64, Node 24.17.0, official SDK 1.4.8 and Muse 1.4.8-R6256.1. Measurements use the debug Rust supervisor and an optimized unsigned native GUI build from this changeset. Values below are decimal MB and CPU percentages of one core.

| Observation | Control RSS | GUI cohort RSS | Combined RSS | Combined idle CPU | Snapshot p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier dedicated baseline, GUI excluded | 489.8 MB | excluded | excluded | excluded | 8.34 ms |
| Shared broker before conditional status | 62.7 MB | 248.4 MB | 311.1 MB | 2.55% | 7.07 ms |
| Shared broker with conditional status | 53.2 MB | 154.5 MB | 207.7 MB | 0.68% | 8.33 ms |

The final enforced observation contains 300 samples over 312.4 seconds, ten healthy isolated sessions, one SDK process and 300 successful full snapshot reads at 100.10 reads/sec. All report gates passed, including stable process identities, the five-minute minimum, combined memory below 300 MB and combined idle CPU below 1%. The control-only CPU was 0.27%. The failing intermediate run is retained locally alongside the passing report in `.dev/benchmarks/stage-c/`.

The budget explicitly counts harness control processes plus native GUI and WebKit, excluding Muse hosts. The final full process tree, including ten independent Muse hosts, averaged 1,613.5 MB RSS and 5.60% CPU. Sharing SDK overhead does not eliminate native Muse host memory. The earlier 489.8 MB control figure excluded the GUI and must not be compared as though it included the whole application.

Native validation used the release app and a real Meta browser login. In session `01a13c4e-acb9-71c3-9b2a-b6384f5e1fac`, the settings dialog changed the observed model to Spark 1.2 and back to Wonder 1.0, saved low effort, and retained both through explicit resume. A subsequent turn submitted from the native composer completed with a real Wonder response about journal reconciliation after transport timeouts. The native map, transcript and completion attention entry reflected the settled result; re-opening settings displayed Wonder and low effort. The initial authRequired turn remains in history. Fresh browser login plus explicit resume resolved it for this proof; unattended credential renewal is not proven. Screenshots are retained locally with the benchmark reports. The live app remains open for inspection.

Review fixed a late-state shutdown race by checking broker liveness under the database lock used for interruption persistence. The dedicated fallback now flushes its death frame and exits, allowing its existing EOF recovery to run. Focused shared-broker/status tests and the dedicated native lifecycle test passed after these changes. The saturation preparation exceeded its 180-second deadline in two attempts; a diagnostic rerun completed in 142.1 seconds with the same deadline and full 1,536-tool workload. It observed a real gap, live repair on generation 1, exact final text, cold convergence and 26 model requests. Timeout diagnostics now retain workload progress instead of reporting only an opaque deadline failure; this is not a preparation-latency performance guarantee.

Final native restart validation found and fixed a stale disconnect banner after automatic reconnection. Successful status polling now clears only connection errors, preserving unrelated errors. The bridge workflow injects a temporary status failure and verifies automatic recovery removes its message. In the rebuilt native app, stopping and restarting the trial supervisor visibly disabled controls, then re-enabled them and removed the disconnect banner while restoring the completed transcript, Wonder and low effort.

Final automated gate: 23 Node tests and 5 Rust tests passed in the complete suite; the saturation proof repeated successfully in 134.9 seconds. Both Playwright tests passed, including synthetic scale and the real Rust/Muse workflow with model/effort and disconnect recovery. Formatting, TypeScript, both Rust Clippy checks, production UI assets and the unsigned native release build passed. This closes the measured idle memory/CPU failure for the stated ten-session workload; it does not close the remaining Stage C history-scale or developer-usefulness requirements.

## Styling and slider review

The settings dialog uses a discrete, labelled range control with native keyboard support and an accessible tier value. Model-specific effort previews survive model admission and require a separate explicit effort command; selecting a preview never mutates execution. A current route absent from the catalog does not produce an empty select. Empty catalogs and catalog failures have distinct visible states. The inspector controls share its content inset and help text wraps within the panel.

Review coverage includes an existing low standing effort followed by a model change, preserving the advertised default preview, keyboard changes and native acknowledgement, an empty catalog, catalog failure without a stuck loading message, a 390-pixel viewport overflow check and an axe scan of the settings dialog. Native inspection confirmed the layout and slider values against the existing real Muse session. Invalid nested command-error markup was also corrected.

## Workspace hierarchy follow-up

Canvas controls now sit directly below the application header and start collapsed. The disclosure persists as `canvasControlsCollapsed` in presentation preferences; expanding it restores search, view mode, zoom, fit and filters without changing execution. Workspace utilities are grouped in a menu. Routine command acknowledgements are short bottom notifications that expire after five seconds; rejected and uncertain states do not auto-dismiss. Full request IDs remain in the command journal.

Attention shows active decisions, failures and review entries before a collapsed runtime-interruption history. The history remains counted and inspectable, and this presentation change does not acknowledge it. Routine reminder items can be hidden from the transcript with an explicit background-activity toggle; failed/rejected reminder items stay visible. Message IDs and timestamps are disclosed with provenance. Task labels, notes and user-asserted relationships are grouped inside the inspector. Changes use presentation state only and do not accept evidence or change native execution state.

The follow-up passed both UI tests, including full light-mode axe checks and the real Rust/Muse scripted-provider workflow. Dock collapse and restoration across reload are covered. Zoom tests use measured canvas bounds rather than a fixed header height. Native inspection exercised expanded/compact canvas controls, the utilities menu and the relocated task-label controls against the retained Wonder session; its display labels were shortened locally for the reading view. TypeScript, Rust Clippy, production assets and the unsigned native build passed. This UI pass does not assert a new live-provider model-quality or runtime-memory benchmark.

### Review and native validation, 15 October 2026

Review corrected the attention grouping so only explicitly historical interruptions collapse; a currently unavailable session remains visible above history. Notification messages share a non-overlapping stack with a valid accessible region, keeping recovery controls reachable during connection failures. The workspace menu now dismisses on Escape, outside pointer interaction and focus leaving its contents; Escape restores summary focus. A deliberately inspected background task retains its own transcript item even when routine background activity is hidden.

All 12 presentation tests and both UI tests passed. Coverage includes current-outage visibility versus historical disclosure, simultaneous connection/recovery message bounds, keyboard/outside menu dismissal, persisted dock collapse, the real Rust/Muse workflow and light-mode axe checks. Formatting, TypeScript, both configured Rust Clippy checks and the optimized unsigned native app build passed. Native interaction against the retained Wonder session exercised dock expansion/collapse, menu Escape focus, background activity toggling and history disclosure without acknowledging interruptions. The final app remains open; a local screenshot is retained as `.dev/benchmarks/stage-c/workspace-reviewed.png`. No fresh provider inference or runtime memory budget result is claimed by this presentation review.
