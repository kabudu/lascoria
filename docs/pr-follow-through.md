# Pull request follow-through

Goal: follow a task from opening its GitHub pull request through failed checks, review feedback and a verified fix. Use the existing GitHub CLI sign-in and delivery flow. Keep GitHub replies and merges in GitHub.

1. **Read model.** Extend Rust's read-only delivery snapshot with a separate GitHub observation. Derive repository, branch and PR number from the managed folder and its delivery receipt or existing branch lookup. Query by number and check repository, branch and head before accepting the result. Report missing and unavailable observations separately. Preserve the existing output and add no dependencies.
2. **Inspector.** Show lifecycle, review decision, checks, observed head and refresh time beside existing local validation. Keep background reads bounded and foreground errors visible. Never interpret an empty check list as passing.
3. **Feedback.** Preview the chosen check or comment, its source and observed revision. Add it as quoted external context to the original session draft only after user action. Keep the current draft and leave sending to the user.
4. **Attention and observation history.** Surface open PR failures and review requests through the task card and existing attention order. Share bounded refresh work across panels, deduplicate by repository and PR number, and stop automatic work for terminal PRs. Retain a bounded history keyed by commit so old results cannot appear current. Avoid loading comment bodies during polling.
5. **Acceptance.** Use a controlled GitHub CLI to exercise failing and succeeding heads, absent checks, outages, closed PRs and malformed output. Verify the rendered workflow and run local CI. Then exercise the full loop with a real disposable PR and native app, and measure real developer follow-through separately.

## Checklist

- [x] Define scope, ownership and validation boundaries.
- [x] Add a bounded GitHub observation to delivery status. Controlled CLI coverage checks failed and passing observations on different heads and refuses a mismatched repository.
- [x] Implement revision-specific inspector status and a failed-check draft preview. Rendered acceptance is tracked below.
- [x] Implement on-demand file review comments for the observed head, with a quoted draft preview. Limit each read to a single page of 30 comments and each displayed body to 2,000 characters.
- [x] Keep up to four previously observed heads per PR in supervisor memory, capped at 32 PRs. Render prior checks in a separate, non-actionable section. Focused Rust tests cover eviction and revisited heads; the browser verifies that a passing new head preserves the earlier failed result as history.
- [x] Route observed PR check failures and requests for changes into Attention and Next to review. Show a compact indicator on the owning session. The PR is scoped to the session folder, which may contain multiple turns. Browser coverage verifies opening the correct Project folder and clearing attention when the observed head passes and is approved.
- [x] Record the selected top-level task ID when opening a PR. Show its card cue only when an applied receipt links that PR, session and folder to a task that still exists. Older receipts retain session-level attention.
- [x] Controlled delivery workflow verified that the linked card cue appears for failed checks and clears on a passing, approved head.
- [x] Implement application-level polling for PRs represented by recent applied delivery receipts. The controlled browser acceptance is tracked below.
- [x] Focused supervisor delivery tests (6 passed), TypeScript, repository checks and diff whitespace checks passed.
- [x] First inspector slice passed full local CI with the pinned Muse binary, including all 58 browser workflows.
- [x] Revalidate review comments with focused supervisor tests, TypeScript and the controlled browser workflow. The browser verifies current-head selection, older-comment exclusion, source link in the preview and preview clearing on refresh.
- [x] Review-comment and history increment passed full local CI with the pinned Muse binary: 115 Rust tests, 108 Node tests with one skip, and 58 browser workflows.
- [x] Attention increment passed full local CI with the pinned Muse binary, including 58 browser workflows.
- [x] Verify that an automated refresh observes a failed PR through the native bridge with the inspector closed, restores Attention and opens the correct PR details. The focused browser workflow passed.
- [x] Add a distinct Needs your input control and a labelled node cue for blocking permissions and questions. Focus the exact decision from the header or the existing attention navigation.
- [x] Bring the demo’s attention flow into the app. Reveal the highest-priority blocking decision in Attention and show its real permission or answer controls there.
- [x] Focused hierarchy, node-activity and native-bridge permission workflows passed. They cover revealing a question in a previously collapsed Attention panel, locating its node, focusing the question and presenting a permission decision inline.
- [x] Full local CI passed for the app implementation at `51bcfd0`: 115 Rust tests, 108 Node tests with one Linux-only skip and 58 browser workflows.
- [x] Hosted macOS, Windows and Linux passed on `5c6d58c`. Linux verified that the exact Bubblewrap loopback startup failure leaves capability evidence unobserved.
- [x] Verify a real private GitHub PR in the packaged macOS app. A hosted check failed on the first head. Polling surfaced it with the inspector closed; selecting the Attention row opened Workspace, and the preview added the check and first head to the Muse draft. After a controlled fixture correction was committed and pushed through the supervisor, hosted CI passed on the second head, the card cue cleared and the first result remained in history. The disposable PR was closed.
- [x] Visual QA of native Attention: one live SDK permission request was approved from the auto-expanded panel. Raw request metadata crowded the inline card, so the revised build shows the exact shell command and moves the full payload into a disclosure. Native inspection confirmed spacing, header-to-decision focus and inline rejection. The focused delivery and node-activity browser workflows passed on the visual fix.
- [ ] Full local and hosted CI on the final visual fix.
- [ ] Run comparative developer trials.


## Implementation boundaries

- The supervisor trusts the scoped session folder and configured GitHub destination. It accepts a PR number only from a matching delivery receipt or the existing branch lookup. It validates the returned URL, number, branch and 40-character commit ID before exposing an observation. An observation is point-in-time evidence, separate from the local file fingerprint and from delivery mutations.
- The first slice uses the existing refresh action and refreshes on delivery activity. Each GitHub CLI operation has the existing 20-second deadline and 256 KiB response ceiling, shares the two-slot remote query limit, and returns at most 50 check names. Current status includes its observation timestamp. Superseded responses and previews are dropped on scope or refresh changes.
- The application schedules from the recent command window, deduplicates up to 32 GitHub URLs and issues one request at a time with 15 seconds between scheduler ticks. Open PRs become eligible after 60 seconds, failures back off from 2 to 16 minutes and clear the current attention signal, and closed or merged PRs are skipped while their receipt remains in scope. The scheduler pauses while the window is hidden. The Rust receipt-only poll uses the existing two-slot remote-query limit and does not scan worktree files or retrieve comment bodies. The history cache has no database writes and clears on supervisor restart. It retains only observed check metadata, with least-recently-observed PR eviction. The initial inspector must not start a separate periodic poll.
- A PR blocker should have stable identity across refreshes and include repository, number, head and check or review identity. Suppress duplicates and remove the current blocker when its head changes or its PR closes. Preserve existing attention priority for permission decisions and questions. Extend keyboard navigation tests to verify folder selection and focus restoration.
- Fetch file review comments only on demand, bound the CLI output and page size, and verify the repository, PR and head after the read. Only comments whose commit matches the observed head are eligible. Changes to selected scope, local head or GitHub observation invalidate the preview. General review summaries, resolved-thread state and pagination remain outside this slice.
