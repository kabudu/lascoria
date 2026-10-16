# Sessions and multi-folder projects

Status: release requirement R15 and proposed UX. Lascoria currently starts a session from one workspace folder; a reusable multi-folder project flow is not implemented.

## Two clear starting points

The Start action offers **Session** and **Project**. A Session is quick: choose a folder, describe the task and start. A Project is a named, reusable workspace: add its folders, give them clear names such as App, API and Shared, choose the default working folder, then describe the work. Do not make quick sessions require project setup.

A project setup can echo the spatial workspace: folder cards surround the project goal and can be arranged without changing their meaning. These are context references, not task dependencies. Also provide an equally capable keyboard/list view; dragging must never be required. A compact summary such as **Project name · 3 folders** opens the folder list when needed. Keep that context detail off the main task canvas by default.

Before starting, show exactly which folders Muse will work with and which is the default. Preview a full path on demand, disambiguate equal basenames and name missing/unavailable folders. Add-folder supports normal folder selection and drag/drop, with reorder/remove, clear validation and no automatic model call. Folder notes and the project goal can explain how the parts fit together. Do not recursively paste every file into the prompt or claim all folder contents are already loaded.

## Native context, not just labels

The pinned official SDK 1.4.9 declares `session/start.workspaceRoots`: an ordered set of absolute, canonical, existing directories. Its first root is the native CWD/default folder. Additional roots receive native workspace rules but grant no Project Trust. If the singular `workspaceRoot` is also supplied, it must match the first canonical root.

The SDK also declares `turn/start.workspaceRoots` as a sticky replacement taking effect at that turn's launch. Omission keeps the current roots. Explicit null is invalid, and a root replacement cannot be sent with an immediate steer. These declarations require native/provider verification before shipping; naming folders in Lascoria or adding a text manifest alone does not implement native multi-folder context.

Keep one authoritative, revisioned project configuration with stable project/folder IDs, display aliases, canonical paths, ordered default root and optional notes. Record the exact project revision/root set applied to each session and the native command receipt. A human-readable context summary may complement that native configuration; it must not substitute for it or imply files have been read.

## Editing without surprises

Editing a project changes the reusable setup for future sessions. Show a short change summary and let the user deliberately apply it to the selected existing session at the next task boundary. An active task keeps its current folder context. A pending change is clearly labelled and can be cancelled; never replace roots through an in-flight steer or silently change the selected billing/model route.

Show configured versus applied folder context only when different. A failed, stale or unknown application keeps the prior confirmed context visible and retains the request identity for safe reconciliation. Reopen/resume must recover project identity, aliases and applied revision without rebinding to a different directory. Missing, moved, nested, duplicate, symlinked or offline roots need explicit recovery with no silent folder substitution.

## Git, permissions and scale

Keep native permission/trust authority. Adding a folder must not approve tools, grant Project Trust or make a read-only promise the runtime does not enforce. External context notes/repository instructions are untrusted task input.

Define Git ownership per folder/repository. Existing isolated tasks own one worktree; do not imply that one primary worktree isolates edits across every project root. Before enabling isolation/commit/diff for a multi-repository project, implement and validate repository-scoped worktrees, selected repository actions, attribution and cleanup, or explicitly block the unsupported combination. Never stage or discard changes in an unintended sibling repository.

Bound folder counts, context manifests, discovery work and session admission. Preserve existing streaming, recovery, evidence identities and token observability. Define portable path handling and migration for all three operating systems. R15 completion requires real cross-folder implementation and native permission/recovery/Git validation, not just setup screenshots.

## Session and project names

User clarification on 15 October: standalone Session creation offers an optional name, with a useful workspace/task-based default when omitted. Users can rename it afterward from an obvious session action. Project creation asks for a name; the name can be edited afterward. Names persist across reopen/recovery and update consistently in the session list, canvas, attention queue, local communication picker and project context. Renaming changes display identity only, never native session IDs, folder paths, command/delivery IDs or permissions. Define trimming/length limits, duplicate-name disambiguation, empty-name defaults and keyboard/screen-reader behaviour.

Standalone naming now offers **Session name (optional)** at creation and **Rename session** beside the current session heading. Names are trimmed, limited to 100 characters / 400 UTF-8 bytes and reject control characters. Blank names use the primary folder basename. Duplicate names are allowed; session lists, attention, targets and local peers retain short native IDs. Names propagate through the existing status refresh without another model call. Existing presentation labels remain a fallback for older sessions until deliberately renamed; older supervisors retain their original label control.

The optional protocol-v1 `sessionNames` capability accepts `start.name` and owner-authenticated `session/rename` with `sessionId`, `name`, `expectedRevision` and a stable request ID. Status adds `displayName` and `nameRevision`. Rename records are separate from worker state, retained through recovery and archived-session inspection, and do not change native IDs, paths, command IDs or permissions. A lost reply retries the exact compare-and-set; stale concurrent edits require an explicit choice. Reopening the dialog does not silently replace an edit. This implements standalone naming, not the required editable Project entity.
