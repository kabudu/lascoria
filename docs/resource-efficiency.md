# Resource efficiency (R11)

Status: first current-build baselines, macOS only, 17–18 October 2026. Windows and Linux baselines, hidden/minimised/closed-window, active-streaming, sleep/wake and live-provider workloads are still open, so the R11 gate in [release readiness](release-readiness.md) stays open.

## Method

- Machine: Apple M4, 10 logical CPUs, 24 GiB, macOS (Darwin 27.0.0) arm64; Node 24.17.0; Muse and the official SDK 1.4.10 (Muse build 1.4.10-R6427.1).
- Build: release supervisor and runtime from the validation app (`scripts/package-macos-qa.js`), revision `c6b66f7` plus the measured working-tree changes below; ad hoc signed; GUI built with the embedded frontend.
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

## Against the targets

The provisional target is under 300 MB combined UI/control memory and under 1% of one core at idle with ten sessions.

- CPU: met after the fix (0.68–0.71%; 1.10–1.20% before).
- Memory measured as RSS, as the target was originally set: **not met**, 327–329 MB.
- Memory measured as physical footprint for the same processes (control plus GUI): 226 MB, within the target. Choosing the metric is a product decision; until it is made the RSS result stands as an open finding.
- The 14 October figures (207.7 MB RSS, 0.68%) used Muse 1.4.8, a debug supervisor and fewer features, so they are context, not a like-for-like regression baseline. The whole application with ten idle sessions is about 800 MB footprint (2.3 GB RSS) and 6–7% of one core, dominated by Muse.

## Findings and follow-ups

| ID | Finding | State |
| --- | --- | --- |
| R11-1 | Idle window re-rendered on every account poll. | Fixed and measured above. |
| R11-2 | Control + GUI RSS 327–329 MB exceeds the 300 MB target; footprint is 226 MB. | Open: metric decision, then reduce the WebKit page process, which is most of the GUI footprint at ten sessions (page 146 MB, desktop 30 MB, GPU 16 MB, networking 6 MB; the page's footprint exceeds its 84 MB RSS because footprint includes compressed memory). The SDK broker is 23 MB of the 28 MB control footprint. |
| R11-3 | Control RSS grew 12.6% over the soak while the command journal grew to 4,158 rows (tombstones are kept for retry safety), and status p95 rose from about 3 ms to 12 ms. `status` reads every command record before returning the latest 100. | Open: measure status cost against journal size and read only the latest records. |
| R11-4 | Idle CPU is mostly Muse (about 0.67% of one core per idle session). | Recorded; outside Lascoria's control. |

Not yet measured: Windows and Linux, hidden, minimised and closed window, active streaming and tool runs, waiting questions and approvals, long transcripts and diffs, sleep/wake and network recovery, energy impact, p99 interaction latency, and live providers. Raw reports stay in `.dev/benchmarks/r11/` (ignored).
