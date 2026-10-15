# Release implementation progress

Started 15 October 2026 from `fa330e2`. Scope and acceptance criteria: [release readiness](release-readiness.md). Updated as work progresses. **Implemented** and **verified** are separate; whole release gates stay unchecked until every acceptance item has evidence. Public release is not yet approved or ready.

## Decisions and environment

- First release must support macOS, Windows and Linux. No macOS-only scope reduction.
- Signing follows `/Users/kabudu/projex/qatq/.github/workflows/release.yml`: APPLE_CERTIFICATE, APPLE_CERTIFICATE_PASSWORD, APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID. Inspect/reuse credentials without printing or committing values. Updater signing is separate from Apple code signing.
- Lazarus mode source `/Users/kabudu/projex/engineering-agent-skills` refreshed with `git pull --ff-only` to `4b2ab8a`; updated skill and debugging/performance references read.
- Existing application identifiers, state paths and evidence identities remain compatible. Local checkout path is retained.
- User provided the connected Windows laptop through Windows App (`MyWindows`); remote desktop availability verified on 15 October. Use an isolated Lascoria test installation and preserve existing applications. Native Windows validation uses an unsigned cross-built package and the official vendor Muse executable.

## Running checklist

| Item | State | Evidence / next action |
| --- | --- | --- |
| R1 Muse onboarding/install | Implemented; partial native validation | Pinned vendor download, checksum/size/protocol verification, existing-runtime selection, progress and cancellation implemented. Isolated macOS packaged app proved missing-Muse detection, cancellation/partial cleanup, retry and private installation readiness. Windows/Linux and remaining error/accessibility cases pending. |
| R2 installed resources / OS ports | Implemented foundations; acceptance in progress | Packaged Node/SDK/supervisor. Windows local-only named pipes with current-user/SYSTEM DACL, protected state, Credential Manager and job-based test cleanup implemented. Native Windows IPC test and embedded UI launch passed. Real Muse echo, process-tree cleanup, draft restart and Credential Manager smoke passed on the laptop; Linux native validation and signed installers remain open. |
| R3 signed in-app updater | Pending | Reuse qatq Apple credential conventions; separate updater signature key and versioned active-work handoff required. |
| R4 repository rename | Implemented; remote read verified | Renamed to `kabudu/lascoria`, kept private, updated origin; `git ls-remote` succeeds. Update metadata and verify push. Public audit/CI/release preparation still open. |
| R5 durable drafts / data lifecycle | Partial implementation verified | SQLite drafts use revision checks and stable retry IDs outside the 48-KiB layout record; UI save/reload and backend restart tests passed. Cross-window conflict recovery, full native close/update acceptance and backup/retention remain open. |
| R6 Stage C acceptance | Pending | Real history/update bursts, sustained packaged measurements and developer-usefulness trials outstanding. |
| R7 accessibility / failures | In progress | Busy-node feedback derives from native state; reduced-motion and stale-state semantics required. Complete native OS accessibility/failure matrix later. |
| R8 usage Settings and /usage | Pending | Use read-only native observations without model turns or host restart; preserve timestamps and account scope. |
| R9 slash skills | Pending | Session-scoped native discovery and invocation; keyboard/scrollable picker; selecting does not submit or interrupt. |
| R10 BYOK decision assistance | Research complete; design pending | First-party Jev/TypeSafe, SubQ and OpenAI Decisions contracts verified. Clean default canvas, opt-in Settings, scoped disclosure and optional metrics; no automatic policy enabled. |
| D1 Git delivery | Pending | Selected staging/push/PR/conflicts/signing scope. |
| D2 editor / terminal | Pending | External editor handoff and interactive-terminal story. |
| D3 search / archive continuation | Pending | Search/export and safe continuation with retained worktree. |
| D4 notifications / attention | In progress | Canvas activity first; desktop notification preferences remain. |
| D5 capabilities management | Pending | R9 first; activation/plugin/MCP scope next. |
| T1 token instrumentation | Pending | Distinguish child totals, context occupancy and subscription allowance. |
| T2 evidence reuse | Pending | Revision/configuration-bound validity, no inferred acceptance. |
| T3 work budgets / loops | Pending | Soft admission limits, in-flight overshoot explicit. |
| T4 efficiency policies | Pending | Optional model/effort presets and native compaction; preserve instructions. |
| T5 savings benchmark | Pending | Repeated comparable tasks, correctness and completed work required. |
| Rust SDK research | Assessment delivered | Optional experiment only after parity gates; no production migration. |
| Dependency scheduler / auto acceptance | Not scoped | Requires agreed semantics; never implied by graph assertions. |

## Validation log

- Repository rename API returned `kabudu/lascoria`, `private: true`; remote HEAD read succeeded. No repository visibility change, history rewrite or state migration.
- Self-contained macOS release bundle built (137.37 MiB); copied to an isolated QA location and launched with a fresh HOME/state and PATH=/usr/bin:/bin. Bundled supervisor/Node/SDK worked without a system Node or Muse on PATH.
- Quit and reopened the isolated native app after installation: the private runtime selection persisted and the account screen again showed Muse ready without another download.
- Native onboarding exposed Meta returning an empty HTTP 200 for requests without a User-Agent. Reproduced with curl, fixed with an explicit Lascoria User-Agent, then reran the original native workflow successfully. Download cancellation removed the partial file; retry installed the 368,615,952-byte macOS artifact after SHA-256 and SDK protocol checks. Account screen showed Muse 1.4.9 ready and enabled browser sign-in. No model request or API key was used in this install check.
- Installer Rust tests cover destination restrictions, stalled-operation cancellation and corrupt/truncated artifact rejection. All three tests passed again after the User-Agent and installer-hardening fixes.
- Current UI suite: four tests passed in 55.4 seconds, including real Muse workflow through the Rust bridge and a draft saved through the UI, observed through the supervisor, and restored after page reload. Current desktop TypeScript/format/Clippy checks and all three installer Rust tests pass after the User-Agent fix. The full runtime suite subsequently passed (30 Node tests and 7 supervisor Rust tests); these are working-tree checks, not release acceptance for every OS.
- No release gate is complete based solely on documentation, a type declaration, a compiled cross-platform target or an earlier test run.

- New steering: R10 records Jev, SubQ and OpenAI Decisions BYOK integrations. Verified the dedicated OpenAI Decisions endpoint; it must not be replaced by Responses. Provider UX/permission design remains an explicit gate. No external decision call or credential setup performed.

## Windows validation, 15 October

- Native target: user-provided Windows 10 laptop, build 19045, reached through Windows App `MyWindows`. No Rust/Node/Git were on PATH. QA uses an isolated `%LOCALAPPDATA%\LascoriaQA` tree and a portable Git copy from the official Git for Windows release, without changing global PATH.
- Native named-pipe/private-state round-trip test: 1 passed. Endpoint is local-only, restricted to current user/SYSTEM, with the existing protocol token still required.
- First cross-built desktop loaded `devUrl`; native testing caught it. Added an explicit `custom-protocol` Cargo feature and made the QA packaging script build with it. Rebuilt native app displayed the embedded account/onboarding UI.
- Meta Windows Muse 1.4.9-R6297.1 SHA-256 matched `c877fc5f852b8030a015e24ead5959d79771d4f6f78d28b748a83c711c59abc6`. Direct version check exited 0 and the real SDK handshake returned compatible=true. Avast then quarantined the vendor binary as IDP.HELU.BD15. Do not bypass protection, silently substitute a runtime or claim full live Windows acceptance. The user restored the binary directly. The subsequent real native Muse echo workflow passed; this is not a paid live-model/browser-login proof. No antivirus exception or protection change was made by the agent.
- Windows test-command ownership uses a trusted helper that joins a kill-on-close job before launching cmd.exe. A private stdin liveness pipe also terminates the helper and descendants when the supervisor dies. Native timeout/crash tests and Credential Manager checks passed using the real Muse echo backend for session work and a labelled controlled account worker for isolated vault-policy checks. The smoke separately exercised quoted executable paths containing spaces.
- Added macOS/Windows/Linux CI for formatting, Clippy, Rust boundary tests, portable projection tests and native builds. CI results remain pending push; this does not replace laptop interaction or release signing.

- Native Windows failures were reproduced and fixed: Git rejected extended `\\?\` worktree paths, so external Git arguments now use ordinary absolute paths while containment checks remain canonical. A minimal cmd.exe comparison proved that mixed-separator argv[0] caused shell syntax failure; component-wise path construction fixed the original workspace command test.
- Security review hardened the Windows endpoint with a fresh 256-bit random pipe name, private endpoint state, strict local endpoint syntax and desktop verification of the server process SID before sending the token. No TCP listener is introduced.
- Optional vault errors no longer prevent browser subscription login. IPC startup no longer waits on a vault probe; authenticated recovery stays gated until account state is observed. The controlled subscription lifecycle passed on macOS, with all-OS CI coverage added for the unavailable-vault case.
- Draft-save batch failures now wait for sibling writes to settle before releasing the save lock. Existing stable request IDs and compare-and-swap revisions remain authoritative.

- Final Windows package before path-boundary correction: desktop SHA-256 `c01f92dcbe20bef1097e9a54de387710de03901f17a9c517bb8685815a89ceb6`, supervisor `ef403b0b8dc539692b83fca52e649b1ef27f2df8b4582aecf567c81b2483ad5d`: all 11 native smoke checks passed after security/auth review. Avast independently scanned the unsigned executables; no protection bypass was used.
- Native onboarding then found another Windows boundary issue: Tauri's extended resource path caused Node to exit before loading the probe (`EISDIR`). A direct ordinary-versus-extended-path process comparison reproduced it. Runtime resource paths now use ordinary absolute paths when invoking Node, including account and session workers. Final native rerun follows below.
- Full current runtime suite passed: 7 supervisor Rust tests and 30 Node tests, including real 1,536-tool stream saturation, exact final text and generation-1 gap recovery. All 4 React/native-bridge workflows passed, including persisted draft reload. Format/TypeScript/Clippy, 2 runtime platform tests and 3 installer tests passed. Windows cross-target Clippy passed for runtime and supervisor. Path-only follow-up checks are recorded separately.

- Corrected Windows package: desktop SHA-256 `4af8d04048e30cd98baafc6a590b12be1534ce6a3c62f2f7652eaa5420c4783f`, supervisor `113864daebc688e4a128e748d1ff382de0a1b2dcabba381e09ed69f51ee72f6f`. All 11 runtime checks passed again. The original native onboarding failure is fixed: the packaged UI now shows **Muse 1.4.9 ready** and enables **Continue with Muse**. Four UI/native-bridge tests passed again after the path fix (56.2 seconds). Browser login/live provider completion remains separately tracked.
