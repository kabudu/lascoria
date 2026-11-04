# Selective staging

Added 4 November 2026 (Unreleased). In an isolated task worktree, the Workspace tab's **Stage and commit** section shows what is staged and what is not, stages and unstages whole files or individual hunks, previews the exact commit content and commits only the staged index. Unselected edits and new files stay in the worktree.

Not included: branches, push, pull requests, merge or conflict resolution, discard of individual changes, an embedded editor or terminal. Those remain on the [roadmap](../ROADMAP.md).

## Where it applies

- Isolated task worktrees only, one folder at a time. A Project session's folder selector chooses the worktree; the supervisor resolves the folder ID to that session's own worktree. A session working directly in your checkout shows a short explanation and no staging controls, so Lascoria never changes the index of a checkout it does not own.
- The session must be current and idle, with no running test command, exactly as for the existing commit and discard controls. Reading the list does not require an idle session.

## Ownership and authority

The Rust supervisor performs every Git mutation and records a durable receipt in the command journal. React only names paths and hunk IDs taken from a view the supervisor produced. Git runs without a shell, with repository hooks disabled, commit signing off, `core.fsmonitor` off and every configured clean/smudge/process filter replaced by a required empty driver, so a filter selected by `.gitattributes` makes the operation fail closed instead of running. Paths are passed as literal pathspecs on standard input (`GIT_LITERAL_PATHSPECS=1`, `--pathspec-from-file`), so names such as `*.txt`, `-dash.txt` or `:(top)` name only themselves. A path is accepted only if the current view lists it on the side being acted on.

Hooks and commit signing are not run, matching the earlier guarded commit; nothing in this increment widens execution authority. Use your own Git client when a repository requires hooks, signing or filters.

## Revision binding

Every view carries a `revision`: SHA-256 over the canonical worktree path, `HEAD`, the exact index entries (`git ls-files --stage -z`: mode, object ID, stage and path) and the existing working-tree content fingerprint. Each action names the revision it was chosen from. The supervisor recomputes it and refuses the action if anything differs: an edit by Muse, an editor or another tool, a `git add` from another client, a new commit, or a view from another Project folder with identical content.

Hunk IDs hash the side, path and exact hunk bytes. The supervisor rebuilds the patch from its own diff; the client never sends patch text.

## Operations

| Operation | Kind | Parameters | Result |
| --- | --- | --- | --- |
| `workspace/changes` | Read | `sessionId`, optional `folderId` | `revision`, `head`, `branch`, `staged` and `unstaged` files (path, change, `wholeOnly` reason, hunks with `id` and `text`), `untracked`, `conflicts`, `stagedPatch`, `limits` |
| `workspace/stage` | Journaled mutation, stable request ID | `revision`, `action` (`stage` or `unstage`), `files`, `hunks` (`{path, id}`) | Receipt with files, hunk count, previous revision and index digests before and after |
| `workspace/commit` | Journaled mutation, stable request ID | `revision`, `message` | Receipt with new `head`, `tree`, `previousHead`, committed files and how many unstaged changes remain |

`workspace/commit` without a `revision` keeps the original guarded commit of every Git-visible change, bound to the content fingerprint, for protocol compatibility. The app no longer offers it.

### Staging atomically

`workspace/stage` takes Git's own `index.lock`, copies the index to a private file beside it and applies every selected change to that copy: selected hunks through one `git apply --cached` (with `--reverse` to unstage), whole files through `git add -A` or `git restore --staged --source=HEAD`. Only when all of them succeed is the copy renamed over the lock and then over the index, the same publication protocol Git uses. Before publishing, the working-tree content fingerprint is checked again, because `git add` reads files as they are at that moment; a file edited during the action makes it refuse. Any failure, refusal or timeout before publication leaves the index byte-for-byte unchanged. An existing `index.lock` from another process is reported and never removed. If the supervisor itself is killed while holding the lock, Git reports a leftover `index.lock` in the task worktree; remove it only after confirming no Git process is running there.

Skipping a hunk never changes the preimage the remaining hunks of that file apply to, so any subset of a file's hunks applies in one patch.

### Committing exactly the preview

`workspace/commit` checks the revision, writes a tree from the index and compares that tree entry by entry with the previewed index entries. It creates the commit with `git commit-tree` (identity from normal Git configuration) and moves the task branch with `git update-ref <branch> <new> <previewed HEAD>`, which fails if the branch moved. The index is left as it was, so it matches the new commit and unstaged edits remain unstaged.

## Outcomes, retry and recovery

- `applied`: the change was made; the receipt names what changed.
- `rejected`: refused before anything changed. Stale revisions, invalid selections, conflicts, another process's lock, Git refusals and staging timeouts are all `rejected`, because the real index is replaced only in the final uninterruptible step.
- `outcomeUnknown`: only when the supervisor stopped mid-operation, or a commit timed out while the branch update might have run. Refresh the list and inspect the task branch.

Mutations are never replayed automatically. A repeated request ID returns the original receipt. A retry with a new request ID still names the old revision, so after a change that did apply it is refused as stale rather than applied twice. After any action the app reloads the list, keeps selections that still exist and shows the refusal reason.

## Special cases

| Case | Behaviour |
| --- | --- |
| New, deleted, binary, permission-changed, type-changed or submodule files | Whole-file staging only, with the reason shown. |
| Renames | Rename detection is off: a rename appears as a deleted and a new file, each staged whole. |
| Pre-staged content | Shown under **Staged** alongside later unstaged edits to the same file; both sides are independent. |
| Merge conflicts | Listed; staging and commit are paused until they are resolved in your Git client. |
| Symlinks, special files or files outside the repository | The view refuses, as the existing change preview does. |
| Assume-unchanged or skip-worktree entries | The view refuses, because they hide changes. |
| Files needing Git filters (such as LFS) | Refused without running the filter. |
| Intent-to-add entries | Staged whole; a commit refuses while they remain, because they cannot be committed exactly. |
| Non-UTF-8 paths | Refused with an explanation. |

## Bounds

At most 500 changed files per view, 500 hunks per file and 500 selected files and hunks per action; each diff side is read within the 1 MiB Git output budget; every Git step has an 8-second deadline and each view or action a 30-second deadline. The existing content fingerprint limits (2,200 files, 1 MiB per file, 16 MiB in total) apply. Operations within a session are serialised by its supervisor lane, and each action runs a fixed number of Git processes regardless of how many files or hunks are selected.

## Evidence

- Rust (`supervisor/src/staging.rs`, disposable real repositories): separate hunks in one file, pre-staged plus unstaged edits, multi-file selection, stage/unstage of hunks and files, commits that leave unselected edits, stale working-tree and index refusal, another process's lock, invalid selections, special paths (spaces, Unicode, leading dash, `*`, quotes), binary, deletion and mode changes, intent-to-add entries, conflicts, a filter that must not run, symlink refusal, quoted header parsing and Project folder isolation, including two folders with identical content.
- Rust-backed UI (`test/ui/staging.spec.ts`): the rendered Workspace tab through the native bridge in an isolated two-folder Project session; hunk and multi-file selection by pointer and keyboard; unstage; stale view and stale commit refusals with unchanged index and HEAD; exact commit preview; committed content and retained worktree edits checked with Git; receipt statuses; the other folder and the original checkouts untouched; axe checks and layout in light and dark at 1440 and 820 pixels.
- Native acceptance: not yet run. The rendered tests use the real supervisor and desktop bridge binaries in a browser, not a packaged native window, and run in local CI on macOS. Hosted CI runs the Rust staging tests on macOS, Windows and Linux but not the Playwright workflows.
