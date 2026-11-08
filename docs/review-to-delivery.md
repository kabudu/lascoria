# Review to delivery and constellation hierarchy

Introduced in v0.3.0. This milestone builds on [selective staging](staging.md). Its aim: a developer can see what their agents are doing, intervene easily and ship the work with confidence. It does not claim Lascoria is better than other harnesses; that would need the comparative trials described under [Measuring success](#measuring-success).

## What the developer does

In an isolated task worktree, the Workspace tab opens with **Deliver this work**. It shows one next step and one primary button, worked out from the supervisor's current state:

| State | Next step (primary action) |
| --- | --- |
| Merge conflicts in the worktree | None. Resolve them with your Git client; delivery is paused. |
| A push or pull request is running | None; progress is shown. |
| The last push or pull request has an unknown outcome | **Check the remote** |
| Uncommitted changes, no current test result | **Run `<last command>`**, or **Choose a test command** when none has run in this folder |
| Uncommitted changes, the current test failed | **Ask Muse to fix the failure** (adds the command, exit code and output to the task draft) |
| Uncommitted changes, the current test passed, nothing staged | **Stage all changes**; files and hunks can be chosen under *Choose files and hunks* |
| Staged changes | **Commit staged changes…** (opens the exact commit preview with the message field focused) |
| Committed, not on the remote | **Push to `<remote>`…** (review, then confirm) |
| The remote branch has commits this branch lacks | None. Nothing is pushed over them; reconcile with your Git client. |
| Pushed to GitHub, no open pull request | **Open a pull request…** (review, then confirm) |
| A pull request from the branch is open | **Open pull request** in the browser |
| Pushed elsewhere, or GitHub CLI missing | None; says where to open the pull request or how to enable it |

*Details* discloses the facts behind the step: change counts, the test result and whether it describes these exact files, commits on the branch and not on the remote, the destination remote and URL (with a remote chooser when there are several), the pull request URL and any remote or GitHub error. The selective-staging controls stay available under *Choose files and hunks*; the test runner, repository context and finish controls are unchanged below. The Workspace tab has a single primary button.

Sessions working directly in the user's own checkout show no delivery controls, as before.

## Validation bound to content

A test command now records a **file fingerprint** before and after it runs: SHA-256 over every Git-visible file's path, bytes and executable bit, without `HEAD`. Committing the tested files does not change it; any edit does. Delivery calls a result current only if the command finished, the files did not change while it ran, and the fingerprint still matches the files now. Otherwise it says why: no run, changed since, changed during the run or recorded before file fingerprints existed (runs from earlier versions are never presented as current), still running or interrupted.

When some changes stay unstaged, the step says that the test ran on every file, including what is not being committed. Lascoria never claims the commit alone was tested.

## Push and pull request

Both are explicit, journaled supervisor commands with a stable request ID, run in the background so they never hold the command lane. Each names the delivery `revision` the user reviewed: SHA-256 over the worktree, task branch, `HEAD`, remote name, push URL, fetch URL and configured receive-pack command. A new commit, a branch switch or a changed remote after review refuses the action with nothing sent. A rejected or failed command is recorded as such; status reports its message.

**Push** (`workspace/push`): rechecks the destination with `git ls-remote` first. The push uses that captured destination URL directly, so a remote-name configuration change cannot redirect it. If the remote branch already has the reviewed commit, it records success without pushing (a retry after a lost acknowledgement). If the remote branch has commits the task branch lacks, it refuses. Otherwise it pushes exactly the reviewed commit (`<sha>:refs/heads/<task branch>`), never forced, then asks the remote again; the remote's answer decides the recorded outcome. Pushes with no commits are refused.

**Pull request** (`workspace/pullRequest`): GitHub only, through the GitHub CLI. When fetch and push name different GitHub repositories, the pushed repository owns the pull request. It requires the remote branch to hold the reviewed commit, lists open pull requests from the branch and returns an existing one instead of opening another. After `gh pr create` it lists again, so a pull request created before a lost response is found and recorded. Title (default: the last commit subject), base branch (default: the remote's default branch, else the source checkout's branch), description and draft (default on) are chosen in the review form. The review shows the repository, the branch and its commits.

**Unknown outcomes**: if the remote cannot confirm what happened, the command is recorded as *outcome unknown* and the next step is **Check the remote**. A supervisor restart during a push or pull request marks it outcome unknown. Every later push or pull request checks the remote first, so retrying never duplicates.

**Bounds**: one push or pull request per session at a time; remote queries 20 seconds, push and creation 60 seconds; at most two status-triggered remote queries at once across the app; up to 50 commits listed (the total is always counted); GitHub CLI output 256 KiB; 20 remotes.

**Credentials**: Git uses the user's own credential helpers and SSH agent. Terminal prompts are disabled, and SSH runs in batch mode unless the user configured their own SSH command. The GitHub CLI uses its own sign-in, with prompts and update checks disabled. Lascoria never reads, stores or returns a credential. User information is removed from every remote URL and from every Git and GitHub CLI message before it is stored or shown. Repository hooks are not run, matching commits. The desktop app opens only `https://github.com/<owner>/<repo>/pull/<number>` addresses.

`SCH_GH_BIN` selects a controlled GitHub CLI for tests. Otherwise Lascoria looks on `PATH` and in the usual install locations, because a desktop app's background service may not inherit a shell `PATH`.

## Protocol

| Operation | Kind | Parameters | Result |
| --- | --- | --- | --- |
| `workspace/delivery` | Read; handled outside the command lane | `sessionId`, optional `folderId`, `remote`, `checkRemote` | `revision`, `branch`, `head`, `base`, `changes`, `clean`, `filesFingerprint`, `validation`, `remotes`, `remote`, `trackingHead`, `remoteBranch`, `outgoing`, `branchCommits`, `hosting`, `pullRequest`, `suggestedBase`, `suggestedTitle`, `last` |
| `workspace/push` | Journaled background mutation | `revision`, `head`, `remote` | `remote`, `url`, `branch`, `head`, `alreadyPushed`, `pushedAtMillis` |
| `workspace/pullRequest` | Journaled background mutation | `revision`, `head`, `remote`, `title`, `body`, `base`, `draft` | `repository`, `pullRequest` (`number`, `url`, `state`, `isDraft`, `title`, `headSha`, `base`), `existing`, `reconciled` |

`workspace/run` results gain `filesFingerprint` and `endFilesFingerprint`. Existing fields are unchanged.

## Constellation hierarchy

- **Task names**: a task's name is the first line of its prompt that has words, without Markdown markers, cut at a word boundary (80 characters). A name the user gives (Task label) and a native subagent objective take precedence.
- **Ownership**: each card shows whose work it is, from native provenance only: *Your task*, *Subagent of …*, *Workflow of …* or *Workflow step of …*. A missing parent is not invented. The inspector header says the same.
- **Folded groups**: **F** on a focused card, or *Fold N subtasks into this card* in the inspector, folds that task's native subtasks into its card, which shows *+N folded*. Folding never moves a card; saved and automatic positions are kept. A subtask that needs attention, and every task above it, stays visible inside a folded group. *Collapse completed* also no longer hides work that needs attention.
- **Next to review**: shown in the header when anything needs attention, with **⌘J** or **Ctrl+J**. Each press goes to the next item across every open session: permission decisions, then questions, then failures, interruptions and completed work to inspect, in that order. It selects the task, reveals its card, clears search and opens the inspector on the matching tab. Runtime history is not included.

## Measuring success

Two kinds of measurement are kept apart.

**Scripted measurements** run the real supervisor and bridge with the controlled echo provider and local repositories. They show that a journey works and roughly how long the app takes. They are not user trials. Results (macOS 27, Apple Silicon, debug build, one run each, 8 November):

| Journey phase (`test/ui/delivery.spec.ts`) | Wall time |
| --- | --- |
| Choose and run the first check (failing) | 1.4 s |
| Send the failure to Muse | 1.4 s |
| Recheck after the fix | 1.7 s |
| Stage and commit | 3.0 s |
| Review and push, including one refused stale review | 3.1 s |
| Open the pull request (controlled GitHub CLI) | 1.6 s |

Folding 150 subtasks on one map took 28 to 190 ms across four single runs (`test/ui/hierarchy.spec.ts`), dominated by the test's own polling.

**Comparison trials** need real developers, the same pinned Muse model and repository, and realistic tasks. They have not been run. Protocol:

- Pin the Lascoria build, Muse CLI/SDK pin, model and effort, repository and commit, and task statement. Use the same conditions in each harness.
- Per task, record time to find active work, time to answer questions or approvals, time to check correctness, time to deliver (pushed branch or pull request), missed failures (a failing check or finding delivered unnoticed) and recovery mistakes (a wrong, duplicate or lost action after a failure or restart).
- Report each measured value with its conditions and run count. Report repeat use only from voluntary use over time, never from scripted or prompted sessions.

## Milestone checklist

Status: **implemented**, **validated** (evidence listed), **partly validated** (gap listed) or **not done**.

| # | Requirement | Status | Evidence or gap |
| --- | --- | --- | --- |
| M1 | One contextual primary action; advanced Git controls disclosed | Validated | `delivery.spec.ts` asserts one primary button in the Workspace tab and a step per state; staging tests open *Choose files and hunks* |
| M2 | Validation bound to exact files; honest missing, stale and unverified states | Validated | `validation_is_current_only_for_the_exact_files_it_ran_on`; journey shows stale after the fix and current after commit |
| M3 | Findings resolved in place: failure sent to Muse with output, conflicts pause delivery | Validated | Failure path in `delivery.spec.ts` and packaged macOS; a real merge conflict pauses delivery with no primary action in `delivery-recovery.spec.ts` |
| M4 | Selective staging protections preserved | Validated | Existing staging and workspace rendered workflows and 9 staging Rust tests pass |
| M5 | Commit from the step, exact preview, focused message, keyboard submit | Validated | Journey commits with keyboard only after the primary action |
| M6 | Push shows destination, branch and outgoing commits; revision-bound; never forced; no blind duplicate | Validated | `push_sends_exactly_the_reviewed_commit_once_and_never_overwrites`; journey refuses a stale review with nothing pushed, then pushes |
| M7 | Pull request created once; existing one shown; lost acknowledgement reconciled | Validated | Controlled-CLI Rust and rendered tests, and against real GitHub: from the packaged macOS app, a push over SSH and draft pull request #1 on a private disposable repository (base `main`, title from the commit); a second request found #1 instead of opening another; a signed-out GitHub CLI is named plainly and the step says to sign in |
| M8 | Unknown-outcome reconciliation | Validated | Rust tests; `delivery-recovery.spec.ts`: the remote accepts a push and then cannot be reached, the step offers *Check the remote*, and once it is reachable the commit is shown as delivered with exactly one push command recorded |
| M9 | Credentials outside React, persistence and logs; bounded network operations | Validated | `credentials_never_leave_urls_or_messages`, `unreachable_remotes_are_reported_without_credentials_and_change_nothing`; URL opener allowlist test |
| M10 | Per-root Project ownership | Validated | Journey: the API folder shows its own state and its remote is untouched |
| M11 | Recovered work and edits kept | Validated | Push and pull request never touch the worktree; stale reviews refused; staging protections unchanged |
| H1 | Meaningful task names; explicit names win | Validated | `test/hierarchy.test.js` |
| H2 | Ownership from native provenance | Validated | Unit test; rendered owner line on cards and inspector |
| H3 | Compact groups that keep positions; keyboard equivalent | Validated | `hierarchy.spec.ts`: **F** folds 150 subtasks, chip, positions unchanged, inspector unfold |
| H4 | Pending attention never hidden in a collapsed group | Validated | Unit test (attention chain kept); rendered failing subtask stays visible while folded |
| H5 | Reliable “take me to what needs attention” | Validated | Unit order and wrap-around; rendered **⌘J/Ctrl+J** and button across two sessions |
| V1 | Narrow, light and dark layouts; accessibility | Validated | Axe with no violations and no horizontal overflow at 1440 and 820 px in both themes; canvas axe at 150 cards; the working panel is never covered by canvas tools (checked to fail without the fix); dark theme and narrow windows in the packaged apps |
| V2 | Concurrent sessions | Validated | `delivery-recovery.spec.ts`: two sessions push at once to their own remotes and branches; a second push in a session that is pushing is refused before anything is sent. Attention jump across sessions in `hierarchy.spec.ts` |
| V3 | Packaged native app interaction | Validated (macOS, Linux, Windows) | macOS packaged journey with nine findings fixed and rechecked; Linux WebKitGTK and Windows WebView2 packaged journeys, two more findings fixed ([native acceptance](native-acceptance.md#review-to-delivery-and-map-hierarchy-d7d8-8-november)). The last fix was rechecked on Linux, not repeated on Windows |
| V4 | Scripted measurements | Validated | Table above |
| V5 | Comparison trials and voluntary repeat use | Not done | Need real developers and time; protocol above |
