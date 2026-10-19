# Native acceptance checklist

Status: prepared 17 October 2026 for the increments marked "native pending" in [implementation progress](implementation-progress.md): R5 Data & backups, R17 Log out, D3 history search, continuation and transcript export, R14 images, R15 next-task folder changes, D4 notifications, R12 F1 peer binding, and the Muse 1.4.9 to 1.4.10 upgrade. Each check here is acceptance evidence for one operating system only. Passing it does not close a release gate on its own; the parent gates in [release readiness](release-readiness.md) still need every listed platform and case.

## Ground rules

- Use only the validation builds and disposable state below. Never point them at your normal Lascoria data, and never stop or restart a supervisor you did not start for this run.
- `echo` mode uses Muse's local echo provider: no model provider, credential or network use. Only checks marked **sign-in** need your Muse subscription; they make no paid API calls unless you choose an API key.
- Keep screenshots, logs and exported files in the ignored `.dev/` folders. Record outcomes (pass, fail or not run, with OS version and build revision) in implementation progress, not raw captures.
- A failure is a finding. Note the exact step, what you saw and whether it repeats; do not work around it during the run.

## Builds

| OS | Build | Launch |
| --- | --- | --- |
| macOS (arm64) | `node scripts/package-macos-qa.js` makes `.dev/macos-qa/Lascoria Acceptance.app` (ad hoc signed, unsigned for distribution) and `provenance.json` with the revision and binary checksums. | `node testing/qa-launch.mjs echo ~/.local/bin/muse-bin-1.4.10-R6427.1`, `live` with the same binary for checks that need Muse's real models after signing in inside the app (QA scripts can still drive it), or `bound` (see F1/U1). `reopen` relaunches only the app with the same state. `stop` ends what `echo` started; in `bound` mode the app owns its supervisor, so end it with **Log out…**, **Pause work and quit**. |
| Windows (x64) | `node scripts/package-windows-qa.js` on the Mac makes `.dev/windows-qa` (cross-built, unsigned). Copy the whole folder to the laptop. | In that folder: `runtime\node.exe testing\qa-launch.mjs echo <path to Muse 1.4.10 muse.exe>`. Install Muse 1.4.10 first through U1 if the laptop still has 1.4.9. |
| Linux | `npm run desktop:prepare`, then `cargo build --release --features custom-protocol` in `src-tauri`; run `src-tauri/target/release/spatial-constellation-desktop` with an isolated `SCH_STATE_DIR` and XDG folders. Without a physical Linux desktop, an X server such as Xvfb hosts it (WebKitGTK). | See the Linux desktop evidence below. |

## A. Automated checks (each OS)

Run from the repository (macOS, Linux) or the copied package (Windows), with Muse 1.4.10:

| ID | Command | Expected |
| --- | --- | --- |
| A1 | `node testing/lifecycle-smoke.js <app folder> <muse 1.4.10> [app binary]` | One JSON line with `"result":"PASS"`. It covers a real echo task, image staging and sending, transcript export (private file), case-insensitive search, continuation without a model turn, backup/export/import, archived-session removal, staged restore applied on restart with a safety backup, and peer binding in both directions. On macOS the app folder is `.dev/native-qa` (after `package-native-qa.js`) and the app binary is `.dev/macos-qa/Lascoria Acceptance.app/Contents/MacOS/LascoriaAcceptance`; on Windows use `.` and `Lascoria.exe`. Anything in `notExercised` is recorded as not run. |
| A2 | Windows only: `runtime\node.exe testing\windows-smoke.js . <muse.exe>` | `"result":"PASS"`, including job-object process-tree cleanup and Credential Manager. |
| A3 | `node --test testing/relay-agent.test.js` with `LASCORIA_RELAY_APP` set to the package | All tests pass (local session messages, restart, drafts). |

## B. Desktop checks (macOS and Windows, `echo` mode unless stated)

Start two sessions in disposable folders first (**New session**, any small Git repository; give them different names).

| ID | Steps | Expected |
| --- | --- | --- |
| N1 Notifications | Workspace menu, **Settings…**, **Notifications**. Turn on **Show desktop notifications**. **Send a test notification**. | The status line says the test was sent and a system notification appears. If it does not, the OS notification settings for Lascoria QA are the first thing to check; record which. |
| N2 | Start a task in session 1, then switch to another app before it finishes (window behind another window). Repeat with the window minimised. | One notification, "A task finished", naming session 1 and not the task text. Note any delay compared with the task's finish time. |
| N3 | Start a task while the Lascoria window is in front. | No notification. |
| N4 | In **Settings…**, **Notifications**, untick session 2. Start a task in session 2 and switch away. | No notification for session 2. Session 1 still notifies. |
| N5 | Start a task and at once choose **Log out…**, **Close Lascoria and keep work running**. Wait until it would have finished, then `qa-launch.mjs reopen`. | The finished task is listed in Attention but is not announced on reopening. |
| D1 Data & backups | Workspace menu, **Settings…**, **Data & backups**. **Back up now**, export it through the save dialog to a folder outside the app's data, import that file. | Backup listed; exported file only readable by you (macOS: `ls -l`, Windows: file Properties, Security); import listed as Imported. |
| D2 | Archive session 2, then **Remove sessions** for it. | A cleanup backup appears first; the session disappears; its task folder stays on disk. |
| D3 | **Prepare restore** from the first backup, quit with **Pause work and quit**, relaunch with the same mode. | Session 2 is back. A "before restore" backup exists. Account choice unchanged. |
| L1 Log out | Workspace menu, **Log out…**. Check each choice's wording, cancel with **Stay in Lascoria**, then use **Close Lascoria and keep work running** with **Do this whenever I close the window**. Close the window with the title-bar button next time. | No work stops on cancel or keep-running; the remembered choice applies to the window close button. |
| H1 History | Workspace menu, **Search history**, search a word from session 1's first task in different case. | The result opens session 1 at the transcript. |
| H2 | Archive session 1, open it, **Continue in a new session**. | A new linked session starts in the retained folder, with no Muse task until you start one. |
| T1 Transcript | **Export transcript…** beside the session heading; save as `.md`. | The file contains the retained messages and no internal notes; only you can read it. |
| I1 Images | **Add image**, paste an image, drop an image on the composer; reload with Ctrl/Cmd+R; remove one; send a task with the rest. | Images survive the reload; the removed one is gone; the task shows the images; a PDF or 10 MB image is refused with a clear message. |
| U2 Account & usage | Workspace menu, **Account & usage** with no session selected, then with one; tick **Show the weekly allowance in the toolbar**. Sign-in variant: after a task in S1. | Without a reading: "No usage reported yet". After S1: both windows with countdown and local reset time, report age, and the toolbar figure. API-key mode: no allowance view. |
| R1 Support report | Workspace menu, **Settings…**, **Support report**, **Prepare report**, read it, **Save report…** to a folder outside the app's data. | The text shows counts and states only: no folder paths, session names or task text. The saved file matches the preview and only you can read it. |
| K1 Skills | In a session, type `/` and then a few letters; close and reopen the picker. | Lascoria and Muse skills are listed under separate headings with sources; typing filters without a pause after the first opening. |
| G1 Project goal | Save a Project with a goal and a folder note, start a Project session with a plain task, then open **Token use** in the inspector. | The transcript shows only your task text; Token use shows session and task tokens or says they are not reported. |
| P1 Project folders | Save a Project with two folders and start a Project session. Edit the Project to add a third folder. In the session, tick **Use the updated folders for this task** and start a task. | The change applies only with that task; the default folder cannot change; the session shows the three folders afterwards. |

## C. Bound mode and upgrade (macOS and Windows, sign-in)

| ID | Steps | Expected |
| --- | --- | --- |
| F1 Peer binding | `qa-launch.mjs bound`. Let the app start its supervisor and reach the account screen. Then, from a terminal with the same `SCH_STATE_DIR` as the launch printed, run `node src/cli.js status` (Windows, in the package: `runtime\node.exe runtime\workers\cli.js status`). | The app works normally. The terminal request is refused with "Only the Lascoria app can control its background service". |
| U1 Upgrade from 1.4.9 | `qa-launch.mjs stop`, delete `state-bound`, then `qa-launch.mjs bound <Muse 1.4.9 binary>` (macOS: `.dev/installed-qa/state/runtime/1.4.9-R6297.1/muse`). Open **Muse account**. | Setup reports Muse 1.4.10 ready (it finds the 1.4.10 binary next to the launcher) or, where none is installed, offers **Install Muse** for 1.4.10. On Windows, install it and confirm the checksum step and progress. |
| S1 | Sign in with your subscription in bound mode and start one short task. | The task completes; Usage shows an observation. Sign out afterwards with **Sign out of Muse…** in Muse account if you do not want the QA state signed in. |

## Recording

For each OS record: OS version, hardware, build revision from `provenance.json`, Muse build, and for each ID pass/fail/not run with a one-line note. Summarise in [implementation progress](implementation-progress.md); keep raw evidence in `.dev/`. Then stop everything with `qa-launch.mjs stop` and delete the `state-*` folders.

## Settings, updates and efficiency follow-up (18 October)

These checks cover commits `f6dfbc0`, `90ef03f`, `338864d` and the takeover updater fixes. They remain pending until outcomes are recorded for the tested platform.

| ID | Steps | Expected |
| --- | --- | --- |
| S1 | Open Settings, search for "theme", press Enter, then navigate sections with arrow keys. Resize the window narrower. | Matching section opens, navigation stays keyboard accessible, and the sidebar stacks without obscuring controls. |
| S2 | In Editor choose a detected editor. Open the session folder, then a file from Workspace. | The chosen editor opens the correct folder/file. A missing editor produces recoverable feedback. |
| S3 | Open Updates in a development/QA build without a release key. | Updates are explicitly unavailable; no unsigned download or installation is offered. |
| S4 | In Token efficiency set a budget and concurrency warning. Start controlled tasks, exercise the warning and cancel it. | Warnings explain the soft limit. Cancelling the concurrency question does not start work. Compaction is unavailable while a task runs. |
| S5 | Run a Workspace test, offer its recorded result, then change the folder and ask again. | The result is labelled as not rerun, adding it only edits the draft, and changed content retires reuse. |

Actual signed download cancellation, replacement, signature rejection and N-to-N+1 installation require signed release fixtures on each target OS. Development-mode S3 is not evidence for those cases. Live T5 savings require separate isolated live trials with independent correctness checks.

## Decision assistance (R10, 19 October)

Release builds reach only the compiled-in vendor endpoints, so these checks never press **Test connection**, **Send for review** or any control that sends, and never leave a workspace turned on for background triage while a key is saved. A key used here is a made-up value saved only to check the native vault; it is forgotten before the run ends. Live quality trials are separate and need a deliberately configured key of your own.

| ID | Steps | Expected |
| --- | --- | --- |
| DA1 | **Settings…**, search "decision", open **Decision assistance**. Read the intro and each provider's policy link and endpoint. | Every provider is off with no key; nothing says advice approves anything; the page explains that the provider bills the requests. |
| DA2 | Before saving any key, look at **Background triage** and **Muse can ask**. | Each provider list offers only Off, with "Enable a provider with a saved key above first." |
| DA3 | Save a made-up key for one provider, turn it on with manual reviews for session 1's workspace, choose it for **Muse can ask** and tick **Use it for this session's workspace**. List the session helper's tools (`testing/relay-tools.mjs`), untick, list again, tick again. Then save a replacement made-up key. | The key field clears and the provider stays open. `ask_decision_assistant` is listed only while ticked. The replacement key turns the provider and both modes off, and the tool is no longer listed. The keychain holds one Lascoria decision item, scoped to the QA state. |
| DA4 | Turn the provider on and allow the workspace again. In the Diff tab save a snapshot, open **Optional decision assistance**, then **Preview exactly what will be sent**. | The preview shows the model, destination, size and exact request body before anything is sent. Do not send. |
| DA5 | **Remove key…**, read the confirmation, **Remove key and turn off**. Open **Recent requests and metrics**. | The confirmation names the consequence and the remove button reads as destructive; the provider shows No key saved, the keychain item is gone, and no requests were made. |
| DA6 | Narrow the window and use only the keyboard through the section. | Controls stay reachable and labelled; no text overlaps. |


### Decision and canvas continuation, 18 October

A rebuilt working-tree macOS QA release bundle based on `b9f173a` used isolated state and synthetic repositories. At 901 CSS pixels, New session remained clickable with expanded tools, task search filtered immediately, Settings chrome stayed fixed while its content scrolled, and the saved two-request daily limit displayed correctly. An exact manual Jev disclosure preview preceded one negative-control request: the added line said PASSED, and the question asking whether it said FAILED returned 4% probability of yes (`jev-1.13.0`). The advisory result and feedback controls were readable. The QA key was forgotten and owned processes stopped without restarting the user supervisor.

Separate Rust-adapter live trials passed five simple oracles each for Jev and SubQ, including helper identity replay and automatic triage. These do not establish coding-task quality, calibration, a live Muse model choosing the tool, or Windows/Linux native acceptance. OpenAI returned 401; the user limited further trials to Jev and SubQ. Final clean-head source validation is recorded in draft PR #1.

### Independent quality check, 19 October

`node testing/decision-quality-trial.js --paid .dev jev,subq` on `e869a40` (macOS arm64, isolated echo-provider state, keys forgotten afterwards). Each provider reviewed four synthetic diffs that add a fixed-amount discount before tax, with the question whether every test passes; `node --test` on the same change gave the answer. Ground truth: correct with a default (pass), discount after tax (fail), missing default so an existing call returns NaN (fail), correct refactor (pass).

| Provider | Model | Correct | Brier score | Probabilities of passing (in that order) |
| --- | --- | --- | --- | --- |
| SubQ | `subq-snap-preview` | 4/4 | 0.005 | 0.95, 0.07, 0.08, 0.93 |
| Jev | `jev-1.13.0` | 3/4 | 0.277 | 0.91, 0.49, 0.92, 0.88 |

Jev missed the regression that only shows through the existing test (0.92 for a change that fails) and was undecided on the reordered discount. This supports the product's framing of advice as an estimate that never accepts evidence or replaces running the tests; it is a small synthetic sample, not a calibration study.

## Isolated Project sessions and the Project map (R15, 19 October)

Use two disposable Git repositories with one commit each.

| ID | Steps | Expected |
| --- | --- | --- |
| PW1 | New session, Project. Fill the name, a goal and both folders. Look at the map, then tick **Give each folder its own isolated worktree** and read the explanation. | The map shows the folders around the goal; the explanation names the repository-root requirement and that the session keeps its folders. |
| PW2 | Start with a short task. Read Muse's echo of the Project note. | The note lists the session's worktree paths, never the original folders. |
| PW3 | Edit a file in the second folder's worktree. Workspace tab, **Folder**: the second folder, **Refresh change preview**, **Commit changes…**. | Only that folder's change appears; the commit lands on its task branch; both original checkouts stay clean and on their own branches. |
| PW4 | **Discard worktree…**, read the list, confirm. | Every folder is listed with its uncommitted changes; both worktrees are removed and both task branches keep their commits. |

## Native drops (R14/R15, 19 October)

| ID | Steps | Expected |
| --- | --- | --- |
| DR1 | Drag a text file and an image from the file manager onto the composer of an open session. | The composer shows a dashed outline while dragging; both files are staged in the strip with the same checks as Attach file. |
| DR2 | Drag a folder onto the composer. | It is refused with its name; nothing is staged. |
| DR3 | New session, Project. Drag two folders from the file manager onto the setup. | They fill the empty folder row and add a row; existing labels are retained and new rows use folder names; nothing is saved until Save project. Dragging a file there is refused. |


### Continuation live evidence, 19 October

A signed-in Muse task in isolated QA state invoked Jev once through the decision tool, recorded a completed `jev-1.13.0` answer (0.98) and replied 0.98. The public general-knowledge statement was the only decision context; the key was forgotten. This is prompted tool use, not spontaneous delegation or a coding-quality assessment. OpenAI was not retried.

The separate subscription token benchmark completed three baseline and three economical/reused-result repairs of the same tiny addition fixture; every independent test passed. Mean reported tokens: 179,069 versus 140,057 (21.8% lower); mean elapsed 26.44 versus 21.64 seconds. These working-tree observations on Muse 1.4.10/macOS arm64 do not establish general savings, provider billing savings or full T5 acceptance. Physical DR1-DR3 and Windows/Linux acceptance remain open. QA bundles now use a distinct identifier/window title; computer-use still returned the original pending-question window during this run, which was not modified. No native drop pass is claimed.


### Native continuation evidence, 19 October

Based on `68f0e2b` plus the reviewed working-tree changes in the accompanying PR receipt:

- macOS arm64 DR1/DR2: the user physically dragged the synthetic text/image pair into the isolated QA composer and confirmed highlight/staging and folder refusal. The native view showed both files and the named refusal; `attachment/list` independently returned exactly the two ready, session-owned attachments (text 34 bytes, PNG 70 bytes). macOS DR3 also passed with user assistance: two folder paths appeared in the map/list, text input was refused, and `project/list` remained empty until explicit Save. The existing App label was retained; the new row used its folder name. Windows physical DR2 folder rejection was confirmed by the user and its named native notification. The user also confirmed successful Windows physical text/image drops. Windows DR3 also passed with user assistance: both folders appeared on its map, the native setup displayed the file refusal, and no Project was saved implicitly. Linux drops remain pending.
- QA selection: a unique macOS executable, in addition to the bundle identifier and title, selected the isolated window correctly. The macOS QA packager now uses `LascoriaAcceptance`, re-signs after renaming it and retains one current acceptance bundle (the legacy demo is left untouched). A reopen check still selected the legacy running window through the reused `dev.lascoria.qa` identifier, so new acceptance builds reserve `dev.lascoria.acceptance` and the separate `Lascoria Acceptance.app` path as well. The rebuilt acceptance package passed signature/layout checks and its native window selected the correct synthetic session. Both staged attachments reappeared after UI replacement with the same QA supervisor. The physical trial used the disposable uniquely named clone. Original user windows and supervisors were preserved.
- Windows x64 installed-resource checks with official Muse 1.4.10-R6427.1: `windows-smoke.js` passed all eleven checks, including native turn, unauthenticated IPC rejection, draft restart, command execution, detached-descendant cleanup on normal completion and supervisor crash, fingerprinting, and Credential Manager save/read/delete without a journal secret. `lifecycle-smoke.js` passed all ten checks with no unexercised entries: image staging/send/clear, transcript export, history search, continuation without a model turn, backup/import and removal/restore, and peer-process refusal/desktop acceptance. Both used controlled/echo providers, not paid model requests.
- The Windows Project worktree regression first failed at Muse `session/start`: additional roots lacked the native Windows namespace prefix. The SDK worker now applies Node's platform path conversion at start and next-task replacement; Unix paths remain unchanged. The same installed-resource test then passed: both worktree roots reached the real Muse host with a controlled provider, scoped preview/commit stayed in the selected repository, stale discard was refused, and all-folder discard kept the commits and original checkouts intact. The portable test is packaged for repeatable platform acceptance. A second installed-resource Windows regression passed next-task folder replacement, retained user transcript/context, compaction and supervisor recovery.
- Windows native Attach file selected a synthetic text/image pair through the OS chooser and displayed both staged items, including the PNG thumbnail/dimensions. This proves native picking, not native drag/drop. Automation did not establish an OS drag session through the remote viewer. User assistance established both Windows folder rejection and successful text/image file drops. The two ready attachments were retained unchanged across an owned-UI reopen with the same QA supervisor, and the restored native strip showed both names/dimensions.

The transferred Windows archive and official vendor Muse binary were SHA-256 verified before execution. These were unsigned private QA artifacts, not published distributions. Automatic antivirus scans completed without exceptions or disabled protection. Result logs remain local to the laptop; copying them back through the redirected share was refused, so the passing exit codes and summaries were verified in its console. Owned Mac and Windows QA UIs/supervisors were stopped after validation; private fixture state/logs were retained, and original user sessions were preserved. Full R14/R15, Linux, interruption and public-release gates remain open.


Repeat the installed-resource Project checks from a private unpacked QA package with its pinned Node and Muse binaries (no provider key is needed):

```bat
set "LASCORIA_PROJECT_APP=C:\path\to\private-qa-package"
set "MUSE_BIN=C:\path\to\verified-muse.exe"
rem Put Git for Windows and the package's runtime folder on PATH first.
"%LASCORIA_PROJECT_APP%\runtime\node.exe" --test "%LASCORIA_PROJECT_APP%\testing\project-worktrees.test.js"
"%LASCORIA_PROJECT_APP%\runtime\node.exe" --test "%LASCORIA_PROJECT_APP%\testing\project-context.test.js"
```

Each test starts its own disposable supervisor/state and local controlled model provider, then cleans up. It never uses the user's running supervisor. These checks exercise the real Muse protocol but are not live-model quality trials.

## Session helper binding and skill reports (F1 and R9, 19 October)

Run from the repository (macOS, Linux) or an installed QA package with `LASCORIA_RELAY_APP` set to it (Windows, `runtime\node.exe`), with Muse 1.4.10 as `MUSE_BIN`:

```sh
node --test --test-concurrency=1 test/relay-identity.test.js test/skills-observed.test.js test/relay-agent.test.js
```

| ID | Test | Expected |
| --- | --- | --- |
| HB1 | `relay-identity.test.js` | With peer binding on, the helper Muse starts for a session sends a message before and after a supervisor restart; a helper started by the test is refused with no capability, a guessed one and (macOS, Linux) the real one copied from the helper's environment; the capability is in no data file; on Linux a desktop client started with `LD_PRELOAD` is refused. |
| SK1 | `skills-observed.test.js` | The session host reports `experimentalApi`; a typed `/release-notes` request produces a `skillRead` item naming the skill and its source, and a plain task produces none. The skill is installed only when the test's Muse home is isolated; otherwise the test is skipped rather than writing to the user's Muse configuration. |

Results: Linux x64 (container, Muse 1.4.10) HB1 and SK1 passed; macOS arm64 HB1 passed (`ps eww` capability read), and both ran in local CI on `8386cf2` and `4cfb250`. Windows x64 (laptop, official Muse 1.4.10-R6427.1, unsigned QA package of `e869a40`, SHA-256 verified before unpacking): `relay-identity`, `skills-observed` and `relay-agent` passed, 3/3 with none skipped, so the Muse-started helper is accepted through the Windows process tree and Muse's home was isolated for the skill install. Copying the result log back to the redirected folder was refused by the redirection (read-only); the log stays in the QA folder on the laptop.

## Linux desktop (19 October)

Ubuntu 24.04 x64 container, WebKitGTK 2.52.6 under Xvfb (no GPU; software rendering), release desktop built from `c36d371`, isolated state and XDG folders, input through XTest:

- Echo mode (script-started supervisor): the window connected ("Background service connected"), showed the session, and a task typed into the composer with **Start turn** completed (`echo: Say hello from Linux`) with the transcript and the Attention entry. The echo provider also leaves failed background reminder items, as it does on every platform with that provider.
- Bound mode (the desktop starts its own supervisor from `runtime/`): Muse 1.4.10 was found ready and the account screen appeared; a Node CLI client was refused with "Only the Lascoria app can control its background service", so F1 peer binding holds with the real Linux desktop. The API key status showed as unavailable because the container has no Secret Service.

Not covered: a physical Linux desktop session (Wayland or X11 with a file manager), so native file drops, the folder chooser, notifications and the Secret Service vault stay open for Linux.
