# Security review (R12)

Started 17 October 2026 against `codex/release-foundations-windows` at `5603378` plus the uncommitted R5/R17/D3 increment. This is the R12 threat model and findings register. It is an evidence-based source review in progress, not a completed audit: no adversarial runtime testing, fuzzing or independent reviewer has been applied yet, and a passing scanner or test suite does not close this gate.

## Deployment assumptions

- Lascoria is a single-user desktop application. The Rust supervisor, Node SDK workers, Muse hosts and test commands run as the signed-in operating-system user.
- Other local users and remote network attackers are out of trust. Processes of the same user are not uniformly trusted: repository code (build scripts, test runners, Git hooks, package scripts) and model-directed tools run as the same user but must not gain Lascoria's control authority.
- Muse owns model execution and its native permission prompts. Lascoria must never grant, imply or automate a Muse approval from model output, peer messages or provider confidence.

## Assets

| Asset | Where it lives | Notes |
| --- | --- | --- |
| Muse subscription session | Muse's own credential store | Lascoria performs app-local sign-out and never revokes the shared CLI login. |
| Meta API key | macOS Keychain, Windows Credential Manager, Linux Secret Service | Never in React state after submission, the journal, argv or diagnostics. UI tests assert the key bytes are absent from `state.sqlite`. |
| Supervisor control token | `<state>/token`, mode 0600 / user-only DACL | Full authority over the IPC protocol. See F1. |
| Journal (`state.sqlite`) | Private state directory | Transcript windows, drafts, command records, local messages, account policy. Backups have the same sensitivity. |
| Backups and exports | `<state>/backups/`, user-chosen export paths | Contain transcripts; exports are written 0600 and the UI says to store them privately. |
| Task worktrees and user repositories | `<state>/worktrees/`, user folders | Never deleted by cleanup; discard requires an exact content fingerprint confirmation. |
| Release signing and updater keys | Release infrastructure only (R2/R3) | Not yet provisioned; must never enter source or downloadable artifacts. |

## Trust boundaries and current controls

1. **WebView to Tauri commands.** Strict CSP (`default-src 'self'`, no remote scripts, `object-src`/`frame-src 'none'`, images limited to `self` and `data:`). No `dangerouslySetInnerHTML`, `eval` or remote content in the React tree; transcripts render as text. The bridge forwards only an allowlisted operation set and caps requests at 64 KiB. Native choosers return only bounded absolute UTF-8 paths; the supervisor revalidates every path before use. Browser hand-off accepts only `https://auth.meta.com/oauth/device/` URLs and avoids shell parsing on every OS.
2. **Local IPC (Unix socket / named pipe).** Unix peers must share the server's UID; Windows pipes have a random 256-bit name, a current-user/SYSTEM DACL and server-SID verification before the client sends the token. Every request carries the token and protocol version. Frames are line-limited to 64 KiB; connection and work admission are bounded (16 connections, 16 queued calls, 16 tasks, 4 per session lane).
3. **Supervisor to Node workers and Muse hosts.** Workers are spawned without a shell, with bounded stdio. Command records are journalled with `synchronous=FULL` before dispatch, uncertain outcomes become `outcomeUnknown`, and retries with the same identity return the original record instead of replaying it. Compacted history keeps request identity, so a late retry is refused (R5).
4. **Muse session MCP relay helper.** The supervisor binary in `--relay-mcp <session>` mode exposes three schema-validated tools, overwrites the owning session from argv and enforces user opt-in, budgets and revocation server-side. See F1 for the token it uses.
5. **Repository and filesystem.** Git runs with hooks and fsmonitor disabled and signing off, bounded output and timeouts. File context is Git-visible, repository-relative, symlink-refusing and limited to 64 KiB of non-binary text. Developer test commands run in their own process group or Windows job and are killed with their descendants. State files are created without following links and with private permissions.
6. **Data lifecycle (R5).** Backups use a single-transaction `VACUUM INTO`, are verified (integrity check, schema, required tables, SHA-256) before export, import or restore, and refuse newer schemas. Restore is staged and applied only at the next start under the owner lock, after an automatic backup, with the current account policy reinstated so no restore can switch billing routes.
7. **Image staging (R14).** Bytes enter only through bounded, owner-authenticated chunk operations into a private per-session folder, are typed by content, checked for size, dimensions and SHA-256, and are read by the session worker only on explicit send after a second checksum check. The journal stores IDs, not bytes. The relay helper cannot reach these operations.
8. **Network.** Muse installation uses a pinned vendor manifest with SHA-256 and size verification over HTTPS. Lascoria does not otherwise open network listeners. Optional BYOK decision providers (R10) are not implemented and need their own disclosure review.

## Findings register

Severity reflects impact if exploited before release. "Open" findings block public release unless explicitly accepted with documented scope.

| ID | Severity | Finding | Impact | Proposed remediation | State |
| --- | --- | --- | --- | --- | --- |
| F1 | High | The full-authority supervisor token is a same-user readable file, and the relay helper authenticates with it. Repository code run by tests, package scripts or approved Muse shell tools can read `<state>/token` and call any IPC operation: `decide` on pending Muse approvals, `turn` into other sessions, `workspace/run`, `data/export` or `stop`. | Confused deputy: untrusted repository content or a model-directed tool escalates past Muse's permission prompts and across sessions and workspaces. | Bind authority to the peer, not only the token: verify the connecting process's executable (macOS `LOCAL_PEERPID` plus code signature, Linux `SO_PEERCRED` plus `/proc/<pid>/exe`, Windows `GetNamedPipeClientProcessId`). Grant full operations to the signed desktop binary only and relay-agent operations only to the supervisor binary in helper mode, scoped to its argv session. Keep the token as a second factor. Development and test builds keep an explicit opt-out. | Implemented 17 October (`supervisor/src/peer.rs`): the desktop names itself in `SCH_DESKTOP_EXE`; peers are accepted by canonical path or identical content, the helper is limited to the three relay operations, and `--bridge-json` exists only in debug builds. Linux unit tests and the macOS Rust-backed refusal test (`test/ui/peer.spec.ts`) pass; Windows compiles but is not natively tested. Partially mitigated, see residual risks below. |
| F2 | Medium | `decide` (native approval) is reachable by any authenticated IPC client, with no user-presence signal distinguishing a click in the desktop UI from a scripted call. | Combined with F1, approvals can be automated. | Covered by F1's peer binding: only the desktop peer class reaches `decide`. | Implemented with F1; same residual risks |
| F3 | Low | `workspace/file` checks canonical containment, then opens by path. A concurrent same-user process can swap an intermediate directory for a link between the check and the open. | Reading a file outside the repository into model context. | Open the file first, then verify the opened handle's real path (`F_GETPATH`, `/proc/self/fd`, `GetFinalPathNameByHandle`), or use `openat2(RESOLVE_BENEATH)` where available. | Open |
| F4 | Low | Token comparison is not constant-time. | Local timing side channel only, against a 256-bit random token over a same-user socket. | Use a constant-time comparison. | Open |
| F5 | Info | Exports and backups contain transcripts and local messages. | Disclosure if the user stores an export publicly. | Exports are written 0600, and the UI and Help say they contain transcripts. Consider optional passphrase encryption before public release. | Mitigated in UI; encryption open |
| F6 | Info | Restoring an older backup cannot know about Muse-side work that happened after it. | Confusing state, not replay: startup interrupts every session and marks in-flight commands `outcomeUnknown`, and no journalled command is re-dispatched. | Documented in the restore dialog and Help. | Accepted (documented) |

### F1 residual risks

Peer binding stops a script that only reads the token. It does not yet stop same-user code that impersonates an accepted executable, so F1 stays open until these are addressed or explicitly accepted:

- **Code injection into the accepted binary.** A same-user process can launch the desktop executable with `LD_PRELOAD` on Linux, inject a DLL on Windows, or attach a debugger where the OS allows it. On macOS the hardened runtime blocks `DYLD_INSERT_LIBRARIES` and debugger attachment for signed builds, so the planned code-signature check (`SecCodeCheckValidity` against the Team ID) is the strongest platform; Linux and Windows need an equivalent decision (for example a desktop-held one-time secret passed over an inherited handle instead of a readable file).
- **Relay helper argv.** Any same-user process can start the supervisor binary in `--relay-mcp <session>` mode for a session it names, then use the three relay tools as that session. Opt-in, budgets and revocation still apply, but the session identity is not yet bound to a Muse host that Lascoria started. Binding the helper to a per-session secret issued at host start would close this.
- **Identity read at connection time.** The executable is resolved from the peer PID once per connection. PID reuse between connect and lookup is not exploitable without the token, and the token stays a second factor.
- Hashing an unfamiliar executable runs on a blocking thread and is cached for 16 paths, so a hostile peer cannot stall other connections.

## Remaining review scope

These parts of R12 have not been reviewed yet and must be completed before release:

- Supply chain: dependency audit (`cargo audit`/`npm audit` equivalents run offline against a pinned advisory database), licence inventory, CI action pinning when Actions are enabled, signing and notarisation, updater signatures (R3).
- Adversarial testing on all three operating systems: malformed or fuzzed IPC frames, cross-user connection attempts, endpoint replacement, hostile repositories, filenames, links and hooks, interrupted install/update, and resource exhaustion.
- Muse skills, plugins and MCP configuration from repositories, and cross-workspace access through Project roots.
- Full-history privacy review of the Git repository (PL03).
- A separate reviewer, vulnerability reporting guidance, and rerunning affected checks after each fix.
