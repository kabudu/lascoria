# Stage C: benchmarks, instrumentation and live trials

This first Stage C increment adds repeatable measurements and explicit model selection. It does not complete Stage C's usefulness/adoption gate or claim the full runtime scale target is met.

## Run the benchmarks

Use Node 24+, Rust 1.97+, and Muse Code 1.4.8. The official SDK is pinned to 1.4.8; an incompatible schema or binary is refused. Historical Stage A evidence was recorded on 1.4.6. Compatibility checks now include the full lifecycle, native saturation and desktop integration tests on 1.4.8.

- `npm run benchmark:runtime`: builds the Rust supervisor, creates ten isolated real Muse echo sessions, sends 300 snapshot reads paced at 100/sec with at most four in flight, then samples the process tree for five minutes. JSON defaults to `.dev/benchmarks/stage-c/runtime.json`. It uses temporary repositories and isolated XDG roots, does not send prompts to a paid provider, and stops its supervisor and workers afterward.
- `SCH_BENCH_IDLE_SECONDS=5 npm run benchmark:runtime`: short smoke run; its five-minute gate is explicitly false. Idle seconds must be an integer in 1..600.
- `SCH_BENCH_OUTPUT=/absolute/path/report.json` changes the runtime report path. `SCH_BENCH_ENFORCE=1` makes any failed reported budget fail the command. Otherwise correctness/request errors and throughput below 90 reads/sec fail, while resource misses remain reported findings.
- `npm run benchmark:ui`: starts Vite and Chromium and drives the real React UI using a synthetic Tauri transport. The fixture has ten sessions, fifty nodes in the selected constellation, a 100,000-item retained array and 100-item transcript pages. It mutates the fixture every 10 ms; the UI consumes coalesced snapshots through its normal one-second polling. It exercises forty keyboard task selections and two history pages. Results are a Playwright `benchmark.json` attachment under `test-results/`.

The two commands measure different boundaries. Neither 100 snapshot reads/sec nor synthetic fixture mutations establish 100 native Muse view updates/sec. The UI fixture never loads 100,000 items into React and does not prove a real Muse/SQLite history at that size. Playwright clears its output directory on a subsequent run; preserve reports outside it when comparing builds.

Report the machine, OS, architecture, Node/Muse versions, build mode, other workloads, sample count and workload with every comparison. The current binaries are debug builds. Run at least three repetitions on an otherwise idle reference Mac before treating a difference as a regression. Resource sampling uses `ps` cumulative CPU time, which has platform resolution limits. CPU percentages refer to one core, not the whole machine. RSS is sampled once per second; the report gives mean control-plane RSS and the final full process tree, including separate Muse costs. It excludes the GUI and therefore supplies only a lower bound against the combined GUI/control-plane budget.

## Instrumentation and trust

The Diagnostics button opens a read-only JSON report. It includes bounded UI timings, authenticated supervisor diagnostics, and Node worker snapshot timings/RSS. No prompts, repository paths, session IDs, output content or credentials are included in that report. Reports stay local; there is no telemetry service.

UI timing families retain at most 256 recent samples each and at most 32 families, with lifetime counts. `navigationCommit` measures selection/session preference change through React layout commit, not paint or completion of asynchronous inspector reads. `warmAttachCommit` measures mounting against an available supervisor through current state and loaded presentation commit; an empty registry is actionable. IPC timings include transport and server queueing. They are not provider inference latencies. Counts and timings reset when the GUI restarts.

The `diagnostics` socket operation uses the same owning-user and token checks as other IPC reads. It bypasses the mutation actor so diagnostics remain readable during recovery. It returns uptime, lifetime authenticated request/failure/response-byte counters, and p95 timings from the last 256 request and actor-queue samples. Server request time begins after authentication and ends after response serialization, before socket delivery. A diagnostic read is included in subsequent readings. Rejected command receipts are application results, not transport failures; inspect the command journal for those outcomes. Queue timing measures admission to actor dispatch, not execution. State is bounded and process-local, with no database migration or unbounded per-session labels.

Workers report snapshot construction count, cumulative/max construction time and RSS. These counters reset on worker generation changes and exclude JSON serialization, Muse processes, and child tools. All existing command idempotency and stale-state gates remain in force.

## Model selection

The new-session dialog offers the advertised catalog default, `muse-wonder-1.0`, and `muse-spark-1.3`. The public `start` operation accepts an optional `modelId` (1..200 ASCII letters, digits or `-_.:/`). Omit it to use the unique advertised default. Invalid IDs are refused before creating a registry row; syntactically valid but unavailable routes remain Muse's responsibility and can fail visibly. Explicit choices do not silently fall back. Provider routing comes from Muse's catalog and credentials remain with Muse.

Status advertises additive `modelSelection` and `diagnostics` features. The GUI disables the new controls against an older supervisor and explains that a restart is needed, rather than sending an explicit model that an old server could ignore. Existing sessions are not stopped by that compatibility check.

The native session card shows the model reported by session/start or session/resume. Selection applies to a new session, not an already running turn. Durable resume restores Muse's authoritative model route. Browser login and provider billing are separate from selection; an authentication failure is retained as a failed turn and attention entry.

## First reference measurements, 14 October 2026

Reference: Darwin 27.0.0 arm64 on Apple M4, Node 24.17.0, Muse 1.4.8-R6256.1, debug Rust/Tauri builds. Other validation jobs ran during this initial observation, so these are diagnostic baseline observations rather than isolated performance claims.

| Boundary | Observation | Interpretation |
| --- | --- | --- |
| Ten-session real echo runtime | 100.1 snapshot reads/sec, p95 8.34 ms, zero read errors | Snapshot-read workload passed |
| Five-minute control process tree | 0.25% of one core, mean RSS 467 MiB | CPU target passed for these processes; 300 MB memory target failed even before GUI |
| Full runtime tree, including Muse | 5.28% of one core, mean RSS 1.76 GiB | Reported separately; not charged to control-plane target |
| Synthetic UI projection | navigation commit p95 11.1 ms; attach commit 205 ms; history pages capped at 100 | Browser projection only, not native paint or real 100,000-item history |

The memory result points to the cost of one Node SDK process per session, about 44 MiB each at the end of observation. Meeting the combined 300 MB target requires a measured worker-sharing or native SDK design, rather than relabelling Muse/worker costs. No such architecture change is claimed here.

## Remaining Stage C gates

Real 100,000-item retained history, native update-burst/backpressure profiling, combined GUI/supervisor resource profiling, independent session command scheduling, repeated reference runs and comparative developer trials remain outstanding. Existing diagnostic history limits remain 10,000 events/32 MiB and inspection paging remains bounded. The actual validation of usefulness requires developers already familiar with parallel agents and repeated voluntary use; a scripted benchmark cannot substitute for it.

For each comparison trial, record the same task and starting checkout, number of concurrent agents, model/version, time to notice a question/failure, time to locate supporting evidence, incorrect or stale decisions, completion/review time and whether the developer elects to use the harness again. Keep prompts and credentials out of shared benchmark exports. Change layout or hierarchy based on observed errors before further theme work.

## Native trial validation

The rebuilt macOS app was exercised against a separate live Meta supervisor on 14 October. Selecting Wonder in the native new-session form produced an authoritative `muse-wonder-1.0` route and matching session card. A read-only tool invocation reached a real permission request, which was allowed once in the native app; its output was retained. Browser credentials were subsequently unavailable on the next model request, so that turn correctly failed and remained in attention. A direct API-key probe separately returned HTTP 402 billing verification failure; no credential was printed or added to source control.

After another browser login and public supervisor resume, a new turn entered in the native app completed. Wonder correctly explained that checking the concurrency count before an await allows two calls through, and that reserving the slot before the first await fixes the race. The real transcript, idle/completed task, authoritative model route and Diagnostics dialog were inspected in the native WebView. Diagnostic capture showed a 38 ms initial attach commit on that empty-registry launch, with bounded 256-sample IPC windows after more than 500 polls. This is a native live-model smoke test, not proof of durable credential renewal or a usefulness trial. The earlier failures remain retained.

Review also found that the loopback fixture inherited Muse's host-dependent automatic-review default. It now declares the built-in `:ask-me` profile in a versioned permission configuration, keeping approval/restart tests independent of reviewer availability. See [Muse's permission-default change](https://dev.meta.ai/docs/muse-code/changelog). Tests remain sandboxed; production permission policy is not overridden by the harness.

Final automated validation passed 21 Node tests and 5 Rust tests, plus both Playwright tests (synthetic benchmark and real Rust/Muse loopback workflow). The native saturation proof executed 1,536 tools, observed a real gap, recovered on generation 1, retained exact final text and made 26 model requests. Formatting, TypeScript, both Rust Clippy checks, production asset build and the unsigned native development bundle build passed. The default Node integration runner now serializes its resource-heavy test files to avoid competing saturation/lifecycle workloads. A short rerun of the final runtime benchmark confirmed stable process identity and correctness checks; its shortened five-minute gate was correctly false.

A final native close/reopen and isolated supervisor restart restored the selected completed turn, its transcript, the Wonder route and current/connected state. The final app's Diagnostics control was enabled by the new feature advertisement. The user's earlier supervisor and pending question were left running separately; trial credentials and state remain local under ignored directories.
