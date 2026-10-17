# Lascoria

**The spatial coding workspace.** Give your agents room to work.

Understand, steer, and review parallel coding work from one live map of tasks, dependencies, changes, and evidence.

[Release policy and local CI](docs/RELEASE.md) defines private validation and public-opening authority. [Release-readiness backlog](docs/release-readiness.md) tracks Muse installation onboarding, signed GitHub updates, repository rename/publication preparation and remaining product gates.

[Lascoria identity](docs/branding.md) documents the folded-wing mark, light-first palette, assets and compatibility boundaries.

[Daily coding workflow](docs/daily-coding-workflow.md) describes isolated task worktrees, repository context, direct test execution, guarded commits/discard and session archival. Existing state and internal binary paths remain compatible with the former harness name.

Stage A implements a local Rust supervisor, a Node worker using the official Muse SDK, and a diagnostic CLI. Stage B adds a Tauri desktop client with React and TypeScript, using light mode by default. A native Rust MSP SDK is a possible follow-up after the concept is proven; the current `muse-codes` crate wraps headless CLI output and does not replace this interactive MSP integration.

## Run the desktop client

```sh
npm ci
npm run desktop:dev
```

Start a session from an existing Git repository, then inspect the task map/list, attention queue, transcript, captured diffs and revision-bound human evidence. Closing the GUI leaves the supervisor running. [Stage B scope, trust model and validation](docs/stage-b.md) describe the current development client and remaining release gates.

## Installed-runtime preview

Desktop builds package the supervisor, Node runtime, official Muse SDK and workers. First launch detects Muse and offers a private, pinned installation from Meta or an existing compatible binary. Downloads have size/checksum verification and a real protocol handshake; Muse installation and account sign-in are separate steps.

macOS packaged onboarding has passed native install/cancel/retry/reopen checks. The Windows port includes local-only named pipes with a user/SYSTEM DACL, Credential Manager storage and test process-tree cleanup. Windows native launch and 11 runtime checks passed on a Windows 10 laptop, including a real Muse echo turn, Credential Manager, draft restart and descendant cleanup after timeout and supervisor crash. The user restored the official Muse binary after antivirus quarantine. A real browser-subscription Muse Wonder task also read a disposable repository, asked a question, survived UI replacement, and completed after the answer. Linux native validation and signed installers/updaters remain release blockers. See the [running checklist](docs/implementation-progress.md) for current evidence, rather than treating compilation as platform acceptance.

For a native development build, run `npm run desktop:build`. Native acceptance runs follow [the native acceptance checklist](docs/native-acceptance.md). Cross-built Windows validation packages use `scripts/package-windows-qa.js`, which explicitly enables the embedded frontend. No unsigned QA archive is a public release.

## Run the diagnostic client

Development prerequisites: Rust 1.97+, Node.js 24+, Git, and Muse Code 1.4.10 available as `muse` or through `MUSE_BIN`. The SDK is pinned to 1.4.10 (`src/muse-version.js`, `runtime-support` and `package.json` must agree; the repository check enforces it) and the worker checks the binary version and schema fingerprint. Compatibility changes require rerunning the lifecycle suite.

```sh
npm ci
npm run build
npm start -- up
npm start -- start '{"workspace":"/absolute/path/to/repository"}' session-one
npm start -- status
```

`up` launches the Rust service independently and reconnects if it already exists. `supervisor` runs it in the foreground for diagnostics. The default provider is credential-free `echo`; set `SCH_PROVIDER=meta` before launching the service to use your configured provider. Live sessions explicitly select the provider and default model advertised by Muse's native catalog, so workflow children have a recorded parent route. The desktop offers explicit model selection for new sessions and model/effort settings for existing sessions; the diagnostic start command uses the catalog default unless `modelId` is supplied. Existing sessions retain their recorded route. Muse owns credentials, permissions, and its sandbox. The harness does not disable them.

### Muse account and API key

The desktop offers browser subscription login and secure API-key configuration on first launch and from **Muse account** in the header/menu. Browser login takes precedence over a saved key. A subscription failure never silently activates API billing. Logout stops Muse hosts and remains logged out after restart; **Forget API key** separately removes the secure credential entry. See [account policy, lifecycle and validation](docs/accounts.md).

The supervisor retains an account host independently of the window, restores persisted login before session recovery and observes credential state in the background. Muse owns OAuth and supported renewal; revoked or expired access can still require **Reconnect Muse**. An open window is not a guarantee of indefinite provider authorization.

Unmanaged diagnostic runs still use Muse's ordinary browser/environment credential rules. For those runs, `muse login` refreshes the CLI credential, and `resume` restarts the affected host. Muse's default environment/stored-key precedence differs from Lascoria's managed subscription-first policy; an API-key billing error is not a subscription billing result. Existing diagnostic supervisors are not silently migrated when a window attaches.

Copy the returned session ID into the next request:

```sh
npm start -- turn '{"sessionId":"SESSION_ID","text":"Explain this repository"}' turn-one
npm start -- status
npm start -- steer '{"sessionId":"SESSION_ID","turnId":"CURRENT_TURN_ID","text":"Focus on the tests"}' steer-one
npm start -- cancel '{"sessionId":"SESSION_ID","turnId":"CURRENT_TURN_ID"}' cancel-one
```

For an approval, inspect `sessions[].state.approvals[].requested`, then send `decide` with the exact `sessionId`, `approvalId`, `currentRequirementId` as `requirementId`, and one offered `choiceId`. For structured questions, use `answer` with the current `userInputId` and the runtime's question IDs and answer format. Old turn targets and resolved approvals are rejected.

Use a stable request ID when retrying. The CLI prints an automatically generated ID before submission if one was not supplied. Reusing an ID returns its journaled outcome; changing its payload is rejected. `outcomeUnknown` does not authorize retrying with a new ID: inspect the recovered session and its effects first.

```sh
npm start -- resume '{"sessionId":"SESSION_ID"}' recover-one
npm start -- stop '{"sessions":["SESSION_ID"]}' stop-one
```

`stop` must name every registered session in the order shown by `status`. A changed set is rejected. It drains all workers and stops the supervisor. Closing an ordinary client only closes its socket.

State lives in `~/.spatial-constellation`, or `SCH_STATE_DIR`. Use separate directories for independent diagnostic runs. The directory is private, the authenticated Unix socket (macOS/Linux), Windows named pipe and token are owner-restricted, and an OS lock prevents duplicate supervisors. No network control API is exposed. `SCH_NODE` selects Node; `SCH_WORKER` is a private development/test override. Launch-time environment changes take effect on the next supervisor start.

## Verify Stage A

```sh
npm run check
npm test
```

The suite requires the real Muse 1.4.10 binary. Muse's own launcher can update itself and remove the pinned binary; point `MUSE_BIN` at a pinned native binary when that happens. It uses temporary repositories and isolated XDG configuration/data directories. Its scripted model binds only to loopback, uses a dummy credential, and exercises real Muse tools and approvals without a paid provider. It also uses explicit fault fixtures for lost acknowledgements and incompatible handshakes. Test-owned processes and temporary data are cleaned up.

[Stage A requirements, evidence, and limits](docs/stage-a.md) distinguish real runtime proof from injected scenarios. [Architecture decisions](docs/architecture.md) describe the Rust/Node boundary and later SDK replacement option. [Revised product plan](docs/Spatial_Constellation_Harness_Revised_Plan.docx) remains the source plan; the Rust ownership decision in the architecture document supersedes its provisional Node supervisor choice.

The constellation canvas fills the workspace. Drag empty canvas space to pan, or focus the canvas and use arrow keys. Sessions, Attention and Task inspector are floating panels: drag their headers or focus a move handle and use arrow keys, collapse each panel independently, and use Reset panels to restore defaults. Positions and collapse state persist. Transcript, Diff and Evidence remain tabs within the task inspector. Attention counts remain visible when its panel is collapsed.

Use Zoom in/out or the percentage button to reset to 100%. Fit to view frames visible nodes in the largest free area around the current panels and controls. Drag any map node to pin its position, or focus it and use Shift+arrow keys to move it; plain arrow keys still navigate between nodes. Zoom, camera and pinned positions persist across reopening.

Two-finger scrolling pans the canvas. Pinch, or hold Ctrl/Cmd while using the wheel, to zoom around the cursor. Canvas input is coalesced to animation frames; native trackpad momentum is preserved without an extra inertial animation. Scroll over a floating panel to scroll that panel instead.

Stage C has started with local diagnostics, repeatable runtime/UI benchmarks and explicit Muse Wonder selection for new sessions. See [Stage C measurements and remaining gates](docs/stage-c.md). Run `npm run benchmark:runtime` for the five-minute runtime observation or `npm run benchmark:ui` for the synthetic projection benchmark. Resource budget misses remain visible in the JSON report.

The default SDK transport shares one bounded Node broker across ten contexts while keeping Muse hosts independent. Use **Session model & effort** in the root-task inspector to change the model at the next model-call boundary or effort for subsequent turns. [Memory measurements, recovery and settings](docs/stage-c-memory.md) describe the tradeoffs and native GUI benchmark.
