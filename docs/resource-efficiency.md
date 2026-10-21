# Resource efficiency (R11)

Status: first current-build baselines, macOS only, 17–18 October 2026. Windows and Linux baselines, hidden/minimised/closed-window, active-streaming, sleep/wake and live-provider workloads are still open, so the R11 gate in [release readiness](release-readiness.md) stays open.

## Method

- Machine: Apple M4, 10 logical CPUs, 24 GiB, macOS (Darwin 27.0.0) arm64; Node 24.17.0; Muse and the official SDK 1.4.10 (Muse build 1.4.10-R6427.1).
- Build: release supervisor and runtime from the validation app (`scripts/package-macos-qa.js`), revision `4b34f27` plus the measured working-tree changes below; ad hoc signed; GUI built with the embedded frontend.
- Workload: `testing/stage-c-benchmark.js` with `SCH_BENCH_RUNTIME` (packaged runtime) and `SCH_BENCH_SESSIONS` (1, 5 or 10). Each session is started in a disposable Git folder and completes one real Muse echo task; 300 status reads at 100 per second; then a 300-second idle observation sampled every second. `SCH_BENCH_GUI_BIN` adds the native window.
- Counters: `ps` RSS and cumulative CPU time (CPU is the change over the idle window, as a percentage of one core). From the footprint runs on, macOS physical footprint (`footprint`, the Activity Monitor "Memory" figure) is also taken once, after the CPU window, so the tool cannot disturb the CPU measurement. RSS counts shared framework and binary pages once per process; footprint counts private dirty plus compressed memory. Ten Muse hosts share one 370 MB binary, so RSS overstates their combined cost several times.
- Attribution: "control" is the supervisor and its direct children (SDK broker). "GUI" is the desktop process plus the WebKit helpers that appear after it launches; WebKit helpers that already existed (here, the user's own Lascoria window) are excluded, and a helper appearing later fails the stable-process gate. Relay helpers are the per-session session-message helpers Muse starts. "Full tree" is everything below the supervisor plus the GUI.
- Conditions: the user's own Lascoria window and supervisor stayed running. Load average before runs ranged from 2.3 to 8.0. Every run passed its correctness gates: expected sessions healthy, stable process identities, no request errors, status p95 under 100 ms.

## Results

### Runtime without the window (three 10-session runs, one each at 1 and 5)

| Sessions | Control RSS | Control CPU | Full tree RSS | Full tree CPU | Muse hosts |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 75.0 MB | 0.03% | 274 MB | 0.57% | 1 |
| 5 | 76.6 MB | 0.05% | 1,081 MB | 2.67% | 5 |
| 10 | 78.2–79.3 MB | 0.10–0.11% | 2,083–2,090 MB | 6.2–7.5% | 10 |

Each relay helper is 6.8 MB RSS with no measurable CPU. Session start p50 was 405–757 ms and status p95 1.9–5.8 ms.

### With the window, before and after the idle re-render fix (10 sessions)

| Build | Runs | GUI RSS | Control + GUI RSS | Control + GUI CPU | GUI CPU |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before | 2 | 260.4–260.8 MB | 338.7–339.2 MB | 1.10–1.20% | 0.95–1.05% |
| After | 6 | 248.3–250.1 MB | 327.0–329.1 MB | 0.68–0.71% | 0.53–0.56% |

A third "before" run (338.7 MB would be expected) recorded 273 MB with every process lower, including Muse; system-wide memory pressure reduced resident pages during that window, so it is excluded from comparison and kept in the raw data.

Fix: the window polls the account state every two seconds and replaced its account object on every poll, even when nothing had changed, which re-rendered the whole workspace. It now keeps the previous object when the reply is identical (`ui/App.tsx`, `refreshAccount`). Idle GUI CPU fell by about 46% across six runs with a spread of 0.03 points; the WebKit page process also used about 15 MB less RSS.

### Physical footprint after the fix

| Sessions | Control | GUI | All Lascoria processes | Muse hosts | Full tree |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 25.7 MB | 182.2 MB | 209.9 MB | 54.5 MB | 264.5 MB |
| 5 | 26.8 MB | 189.6 MB | 226.7 MB | 275.8 MB | 502.5 MB |
| 10 (2 runs) | 28.0–28.3 MB | 197.9–198.0 MB | 246.6–246.8 MB | 553.6–556.8 MB | 800.5–803.4 MB |

"All Lascoria processes" adds the relay helpers to control and GUI. Each further session costs about 56 MB of Muse footprint and about 0.67% of one core of idle CPU, almost all of it in the Muse host; Lascoria's own cost grows by about 4 MB per session.

### 30-minute soak

`SCH_SOAK_MINUTES=30 node testing/soak.js` with the packaged runtime, no window: three background sessions stayed open while each cycle started a session, ran two tasks, read status, searched, exported the transcript, archived the session and removed it through Data & backups cleanup (which makes a backup); every fifth cycle restarted the supervisor. Result: 903 cycles, 180 restarts, 1,809 completed tasks, no errors. Muse hosts returned to the background count (mean 3.9 in the first fifth, 3.8 in the last), no processes accumulated (maximum 11), three sessions retained. Full-tree RSS 796 MB in the first fifth and 857 MB in the last; control RSS 79.6 MB and 89.6 MB (+12.6%). Status p50 5.7 ms, p95 11.7 ms, maximum 15.4 ms. CPU averaged 37% of one core because the cycle runs back to back; this is a stress and leak check, not an idle figure.

### Command journal size (R11-3)

`testing/status-scale.js` seeds a fresh journal with 100, 5,000 or 20,000 command records (one in ten full, the rest compacted, as cleanup leaves them) and measures 300 sequential status reads and supervisor RSS. Release supervisor on the same Mac, three runs each:

| Records | Status p50 before | Status p50 after | Supervisor RSS before | Supervisor RSS after |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 0.26–0.29 ms | 0.26–0.27 ms | 9.6 MB | 9.5–9.7 MB |
| 5,000 | 2.37–2.41 ms | 0.26 ms | 15.5–15.6 MB | 10.7–10.9 MB |
| 20,000 | 9.80–9.95 ms | 0.25–0.27 ms | 31.6–32.3 MB | 12.1 MB |

Cause: status, every task progress update, every Muse process interruption and supervisor startup each parsed the whole journal to find a handful of records, under the journal lock. Status now reads only the newest 100 records, and the other three paths ask SQLite for the matching records (same session, command or status), so their cost no longer grows with retained history. A Rust test fills the journal to its 20,000-row limit and checks the newest-first page; another checks that only the matching session's records change.

The 30-minute soak was repeated with this build (single run each): 911 cycles, 182 restarts, 1,825 tasks, no errors; status p50 2.4 ms and p95 5.1 ms (5.7 and 11.7 ms before); control RSS 77.7 MB in the first fifth and 84.3 MB in the last (+8.5%, against +12.6% before). Full-tree RSS is dominated by Muse hosts, whose count at a sample instant varies with the cycle phase, so it is not compared.

## Resident-memory optimisation attempt (18 October)

The user asked for the RSS target (not footprint) to be met without losing functionality or good UX. Method: one change at a time, two or more runs each, ten idle sessions, 60-second windows. Window experiments used the debug desktop binary loading a production frontend build from a local preview server, so a frontend variant needed no app rebuild; its absolute desktop RSS is higher than the release app's, so only differences are compared. Run-to-run spread was about ±1.5 MB.

**Floors on this Mac today (RSS).** A blank page in the same Tauri shell: 160–165 MB (desktop 96–100, WebKit GPU 24, page 26, networking 13). The packaged Node with the official SDK imported: 52.5 MB (bare Node 44.8 MB). Supervisor about 10–13 MB. So about 225 MB is spent before any interface content or session. The 14 October interface, built today and measured the same way, uses 269–270 MB for the window against 281–283 MB for the current one: about 12 MB of growth comes from the features added since, and the rest of the gap to the 14 October figure (154.5 MB for the whole window, below today's blank shell) comes from the platform.

**Where the window's memory goes.** Hiding the whole interface while still running its JavaScript (diagnostic only) saves 36 MB (page 19, GPU 16), so painting and compositing cost about 36 MB and JavaScript plus DOM about 40 MB above the blank page.

| Window change (diagnostic) | Change in window RSS |
| --- | ---: |
| No dot-grid canvas background | 0 (footprint −20 MB) |
| No box shadows | 0 |
| No canvas zoom transform | 0 |
| Panels without rounded clipping | 0 |
| Panels not fixed-position | −2 MB |
| Panel contents not scrollable | −4 MB |
| `content-visibility: auto` on long lists | −3 MB |
| Dialogs loaded on first use | −3 MB |
| Floating panels hidden | −10 MB |

| SDK broker V8 option | Broker RSS (66.2 MB) | Broker CPU in the native saturation test |
| --- | ---: | ---: |
| `--max-semi-space-size=1` | −1.3 MB | not measured |
| `--optimize-for-size` | −2.0 MB | not measured |
| `--no-opt` | −3.0 MB | not measured |
| `--no-opt --no-maglev` | −6.4 MB | +35–50% (3.0–3.1 s to 4.0–4.5 s) |
| `--jitless` | −8.0 MB | not measured |
| `--lite-mode` | −10.9 MB | +65–85% (2.7–3.1 s to 5.0–5.1 s) |
| `--v8-pool-size=1`, `--single-threaded`, `--max-lazy`, `--max-old-space-size=64` | 0 | |

None of these was adopted. The interface changes that save anything either change what people see or how panels behave (hidden or non-scrolling panels), or save 3 MB or less with a cost: loading dialogs on first use broke offline Help in the existing test and added a failure path, and `content-visibility` makes scrollbars estimate unrendered rows. The V8 options trade a few MB at idle for markedly more CPU while tasks stream, which works against the CPU and energy half of this same requirement. Even taking every option above would leave the window plus control processes near 309 MB.

**Final measurement** of the build with this round's changes (release app, ten sessions, three five-minute runs): control + GUI RSS 336.3, 326.8 and 327.7 MB (the first under a load average of 6.2), so the RSS target is still **not met**; physical footprint 245.6–247.6 MB for all Lascoria processes including relay helpers. Control + GUI idle CPU 0.20% in all three runs (control 0.14%, GUI 0.06%), lower than the 0.68–0.71% recorded before the command-journal fix; the drop in GUI CPU was observed, not isolated to a cause.

## Against the targets

The provisional target is under 300 MB combined UI/control memory and under 1% of one core at idle with ten sessions.

- CPU: met after the fix (0.68–0.71%; 1.10–1.20% before).
- Memory measured as RSS, as the target was originally set: **not met**, 327–329 MB (326.8–336.3 MB in the 18 October final runs; see the optimisation attempt above).
- Memory measured as physical footprint for the same processes (control plus GUI): 226 MB, within the target. Choosing the metric is a product decision; until it is made the RSS result stands as an open finding.
- The 14 October figures (207.7 MB RSS, 0.68%) used Muse 1.4.8, a debug supervisor and fewer features, so they are context, not a like-for-like regression baseline. The whole application with ten idle sessions is about 800 MB footprint (2.3 GB RSS) and 6–7% of one core, dominated by Muse.

## Findings and follow-ups

| ID | Finding | State |
| --- | --- | --- |
| R11-1 | Idle window re-rendered on every account poll. | Fixed and measured above. |
| R11-2 | Control + GUI RSS 327–329 MB exceeds the 300 MB target; footprint is 226 MB. | Accepted as a scoped product exception on 18 October (see below). Attribution: the WebKit page process, which is most of the GUI footprint at ten sessions (page 146 MB, desktop 30 MB, GPU 16 MB, networking 6 MB; the page's footprint exceeds its 84 MB RSS because footprint includes compressed memory). The SDK broker is 23 MB of the 28 MB control footprint. |
| R11-3 | Status, task progress, interruptions and startup parsed the whole command journal (up to 20,000 rows); status p95 rose to about 12 ms over the soak and control RSS grew 12.6%. | Fixed: status cost is flat from 100 to 20,000 records (0.25 ms) and supervisor RSS at 20,000 records fell from 32 MB to 12 MB; soak status p95 5.1 ms, control RSS growth +8.5%. The remaining growth is small and bounded by the journal limit; recheck in the Windows and Linux soaks. |
| R11-4 | Idle CPU is mostly Muse (about 0.67% of one core per idle session). | Recorded; outside Lascoria's control. |
| R11-5 | The benchmark runs without account management, so it omits the account host that a signed-in subscription keeps running (one more Node process and one more Muse process). | Open: measure signed in during native acceptance (S1); merging the account connection into the SDK broker would remove one Node process (about 45–50 MB RSS) at the cost of sharing its fault boundary. |

Not yet measured: Windows and Linux, hidden, minimised and closed window, active streaming and tool runs, waiting questions and approvals, long transcripts and diffs, sleep/wake and network recovery, energy impact, p99 interaction latency, and live providers. Raw reports stay in `.dev/benchmarks/r11/` (ignored).

## Scoped exception: macOS resident memory (18 October)

The user accepted the measured macOS overage: "I think I can live with the current memory situation, as the physical memory reported by Activity Monitor is below 300MB." What this covers, exactly:

- macOS arm64, the documented ten-session idle workload, signed-out (no account host), release build with the window open: control + GUI **RSS 327–329 MB, above the 300 MB target**, while physical footprint (what Activity Monitor shows as Memory) is 226 MB. The RSS figure stays reported as measured; it is not relabelled as footprint, and the target itself is unchanged.
- It does not cover Windows or Linux, the signed-in account host (R11-5), active streaming or tool workloads, other window states, or any future growth. Each still has to be measured against the target, and any regression above today's figures reopens the decision.
- R11 stays open: signed-in host, active workloads, leak/soak with the window, and Windows/Linux baselines remain outstanding. No further RSS tuning is planned for macOS unless a new measurement shows growth.

