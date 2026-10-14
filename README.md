# Spatial Constellation Harness

Understand, steer, and review parallel coding work from one live map of tasks, dependencies, changes, and evidence.

Stage A implements a local Rust supervisor, a Node worker using the official Muse SDK, and a diagnostic CLI. Stage B adds a Tauri desktop client with React and TypeScript, using light mode by default. A native Rust MSP SDK is a possible follow-up after the concept is proven; the current `muse-codes` crate wraps headless CLI output and does not replace this interactive MSP integration.

## Run the desktop client

```sh
npm ci
npm run desktop:dev
```

Start a session from an existing Git repository, then inspect the task map/list, attention queue, transcript, captured diffs and revision-bound human evidence. Closing the GUI leaves the supervisor running. [Stage B scope, trust model and validation](docs/stage-b.md) describe the current development client and remaining release gates.

## Run the diagnostic client

Prerequisites: macOS, Rust 1.97+, Node.js 24+, and Muse Code 1.4.8 available as `muse` or through `MUSE_BIN`. The SDK is pinned to 1.4.8 and the worker checks the binary version and schema fingerprint. Compatibility changes require rerunning the lifecycle suite.

```sh
npm ci
npm run build
npm start -- up
npm start -- start '{"workspace":"/absolute/path/to/repository"}' session-one
npm start -- status
```

`up` launches the Rust service independently and reconnects if it already exists. `supervisor` runs it in the foreground for diagnostics. The default provider is credential-free `echo`; set `SCH_PROVIDER=meta` before launching the service to use your configured provider. Live sessions explicitly select the provider and default model advertised by Muse's native catalog, so workflow children have a recorded parent route. This uses the catalog default, with no model picker in this development client; existing sessions retain their recorded route. Muse owns credentials, permissions, and its sandbox. The harness does not disable them.

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

State lives in `~/.spatial-constellation`, or `SCH_STATE_DIR`. Use separate directories for independent diagnostic runs. The directory is private, the authenticated Unix socket and token are owner-restricted, and an OS lock prevents duplicate supervisors. No network control API is exposed. `SCH_NODE` selects Node; `SCH_WORKER` is a private development/test override. Launch-time environment changes take effect on the next supervisor start.

## Verify Stage A

```sh
npm run check
npm test
```

The suite requires the real Muse 1.4.8 binary. It uses temporary repositories and isolated XDG configuration/data directories. Its scripted model binds only to loopback, uses a dummy credential, and exercises real Muse tools and approvals without a paid provider. It also uses explicit fault fixtures for lost acknowledgements and incompatible handshakes. Test-owned processes and temporary data are cleaned up.

[Stage A requirements, evidence, and limits](docs/stage-a.md) distinguish real runtime proof from injected scenarios. [Architecture decisions](docs/architecture.md) describe the Rust/Node boundary and later SDK replacement option. [Revised product plan](docs/Spatial_Constellation_Harness_Revised_Plan.docx) remains the source plan; the Rust ownership decision in the architecture document supersedes its provisional Node supervisor choice.

The constellation canvas fills the workspace. Drag empty canvas space to pan, or focus the canvas and use arrow keys. Sessions, Attention and Task inspector are floating panels: drag their headers or focus a move handle and use arrow keys, collapse each panel independently, and use Reset panels to restore defaults. Positions and collapse state persist. Transcript, Diff and Evidence remain tabs within the task inspector. Attention counts remain visible when its panel is collapsed.

Use Zoom in/out or the percentage button to reset to 100%. Fit to view frames visible nodes in the largest free area around the current panels and controls. Drag any map node to pin its position, or focus it and use Shift+arrow keys to move it; plain arrow keys still navigate between nodes. Zoom, camera and pinned positions persist across reopening.

Two-finger scrolling pans the canvas. Pinch, or hold Ctrl/Cmd while using the wheel, to zoom around the cursor. Canvas input is coalesced to animation frames; native trackpad momentum is preserved without an extra inertial animation. Scroll over a floating panel to scroll that panel instead.

Stage C has started with local diagnostics, repeatable runtime/UI benchmarks and explicit Muse Wonder selection for new sessions. See [Stage C measurements and remaining gates](docs/stage-c.md). Run `npm run benchmark:runtime` for the five-minute runtime observation or `npm run benchmark:ui` for the synthetic projection benchmark. Resource budget misses remain visible in the JSON report.
