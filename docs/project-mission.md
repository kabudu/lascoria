# v0.6.0 Project Mission

Project Mission brings an approved project plan, task dependencies, evidence, integration, and review into one workflow. It is entered from an existing saved project. The default workspace keeps its existing layout.

## Implementation checklist

- [x] Store one editable, revisioned mission per saved project. Bound the plan, reject dependency cycles and stale edits, and keep the plan through restart.
- [x] Show plan dependencies and readiness on a shared canvas. Assign tasks to project sessions, review the brief, and start each approved task through the existing Muse turn path. Only a completed turn and explicitly accepted current evidence can satisfy a dependency.
- [x] Prepare a revision-bound rehearsal from committed changes in the same repository. Use a separate isolated session for the rehearsal. Preserve the original repository and contributing branches, handle conflicts without guessing, and run the existing revision-bound checks on the combined changes.
- [x] Start an independent review in a separate Muse session with the acceptance criteria and exact tested diff. Record actionable findings against the owning plan task. Rechecking a changed integration revision requires fresh evidence.
- [x] Exercise planning, stale evidence, conflicts, recovery, independent review and delivery in one end-to-end scenario. Check narrow layout, keyboard access and both themes.
- [x] Verify the packaged macOS map at an 820-pixel window width. Keep the task inspector below the map in both themes so the next task remains visible. Cover that width in the controlled regression.
- [ ] Review authority, compatibility, recovery and resource bounds. Run final-head local CI and hosted validation, and record evidence in the PR.
- [ ] Run native installed-app and live-provider acceptance before signed distribution.

## Boundaries

The Rust supervisor owns plans, readiness, revision checks and Git writes. The official Node SDK continues to own Muse turns. Tauri and React render the mission and use the existing session, review, draft and attention entry points.

A mission is bound to the saved project. Tasks are started by the developer and retain command identity for recovery. Upstream evidence is checked before every dependent launch. The rehearsal operates on one project repository at a time in a dedicated worktree; it never pushes automatically. A reviewer sees the reviewed diff and criteria through the ordinary turn API, with separate session identity. Review acceptance remains a developer decision.

## State and recovery

| Action | Saved evidence | What happens if it changes |
| --- | --- | --- |
| Save a plan | Project identity, plan revision and dependency graph | A stale editor reloads the current plan. Reopen started tasks before editing their assignment, brief or criteria. |
| Accept a task | Completed Muse turn, workspace fingerprint, evidence summary and optional existing handoff | The task loses its accepted status. Dependent work records which evidence it ran against, so accepting a new result does not silently approve earlier work. |
| Assemble changes | Exact base and ordered contributing commits, saved before Git writes | The dedicated integration worktree resumes without a live Muse host. If Git still has the recorded merge, inspect, stage and continue it, or abort it. An unrelated Git operation requires separate inspection. |
| Approve review | Integrated commit, workspace fingerprint, latest passing check and review turn | A different check or tree needs fresh review. The normal push and PR actions verify approval and contributing evidence again. |

One plan holds up to 12 tasks and six dependencies per task. A rehearsal accepts up to six contributing commits from the same repository. The review preview transmits the whole diff only when it fits within 28 KB. Review findings are explicitly recorded by the developer and added to the owning task's draft. Existing archived-session cleanup clears project evidence and copied review prompts associated with the removed session.

## Acceptance

The controlled scenario uses two contributing tasks, a dependent verification task and an independent reviewer. It tests a Muse question and its Attention destination, changes an upstream interface after acceptance, resolves a Git conflict across a supervisor restart, checks the combined tree and routes a finding to its owner. The push targets a temporary local repository. The test uses the real Tauri IPC bridge, Rust supervisor, Muse CLI and SDK, a controlled model provider and Chromium. A live-provider run in the installed native app and signed distribution are separate release acceptance.
