# Rust-native Muse SDK assessment

Assessed 15 October 2026 against Lascoria's current source, official SDK 1.4.9, the published MSP documentation and `muse-codes` 1.4.5.

## Recommendation

There is merit in a Rust-native **MSP client**, especially for desktop packaging, explicit memory ownership and removing the shared V8 broker. Build a bounded experimental adapter after the account flow is stable; keep the official Node adapter as the production implementation and comparison oracle until parity is demonstrated. This assessment authorizes no migration or crate publication.

The valuable deliverable is an interactive `muse serve` client with correct authoritative state and recovery. A wrapper around `muse exec --json` does not replace the present integration. The existing third-party [`muse-codes` 1.4.5](https://docs.rs/muse-codes/1.4.5/muse_codes/) documents that headless execution surface and captured event types; its documented scope still does not establish interactive MSP parity. Its auth helpers do not change that distinction.

## What it could improve

- Packaging: remove Lascoria's requirement to ship a compatible Node runtime and load JavaScript broker resources. Muse itself remains a separately managed executable unless a permitted distribution arrangement is established.
- Fault boundaries: one compiled adapter process per session could avoid the present shared-broker failure affecting ten session contexts. An in-process Rust library instead removes that process boundary; a panic, process abort or native dependency failure could affect the supervisor. Rust alone does not provide session isolation.
- Resource control: bounded channels, allocation accounting and fewer serialization boundaries may help burst handling and large histories. These are hypotheses to measure, not language guarantees.
- Ownership: the team could expose MSP features independently of the TypeScript facade's release cadence, while taking on protocol compatibility and support responsibility.

It will not remove native Muse host memory, model latency, provider authentication expiry or billing policy. Keep the subscription/API-key routing policy in Lascoria's account coordinator and use supported Muse account operations; reimplementing OAuth or inventing token-refresh behaviour is outside an MSP adapter's remit.

## Performance case today

The controlled ten-session observation in [Stage C memory results](stage-c-memory.md) measured 53.2 MB control RSS, 154.5 MB GUI RSS and 207.7 MB combined RSS, with 0.68% combined idle CPU. The full tree including Muse hosts averaged 1,613.5 MB RSS. Those results used SDK/Muse 1.4.8 and the stated small-history workload; they are not a Rust comparison or a current 1.4.9 performance guarantee.

Removing all 53.2 MB of measured control memory would save only about 3.3% of that measured full tree, and some Rust control memory must remain. Real adapter savings would therefore be smaller under that accounting. The much larger saving from ten Node processes to one shared broker has already been captured. A Rust migration should be justified primarily by packaging or a demonstrated active-workload limitation, not a claim that the current idle budget still fails.

## Scope and hard parts

The current adapter is only about 470 lines in `src/session-worker.js`, plus the 88-line broker, because the official SDK owns substantial semantics. Porting those lines alone omits the difficult implementation:

1. Bounded NDJSON transport, handshake/capabilities, request correlation, server-request responses, shutdown escalation and child-process cleanup.
2. Typed method envelopes generated from a pinned Muse schema, while preserving unknown open-enum variants and unknown item payloads.
3. Authoritative item/session/turn fold, streamed fields, revisions, duplicate delivery and host-death presentation.
4. Cursor-based paging, live subscription, gap splice, late overlap delivery, snapshots and durable resume.
5. Stable command IDs, acceptance versus application, uncertain outcomes and no automatic resubmission of mutations.
6. Approval requirement tokens, decision freshness, structured user input, model/effort controls and account operations used by Lascoria.

The [fold rules](https://meta-models.github.io/muse-code-sdk/next/guides/msp-concepts/fold-model/) distinguish provisional deltas from committed revisioned objects. In particular, opaque cursors must never be sorted lexically to infer recovery order. The installed SDK's `facade/gap-fill.js` also contains explicit late-overlap and coalesced-gap handling; the Rust implementation needs those behaviours, not merely an event loop that looks equivalent on a happy-path transcript.

## Compatibility and validation

The [wire implementer's guide](https://meta-models.github.io/muse-code-sdk/next/guides/msp-wire/) documents a pre-1.0 protocol with possible non-additive changes, schema export commands and a handshake fingerprint. Pin a tested binary/schema pair, detect mismatches before execution, distinguish supported stable methods from experimental account methods, and surface unsupported features explicitly. Schema generation supplies shapes; it does not generate the fold or recovery algorithm.

The [official repository](https://github.com/meta-models/muse-code-sdk) contains protocol declarations, SDK source and test material under the MIT licence. Reuse or translation must retain applicable notices and provenance. Its public source is mirrored from upstream; integration maintenance should track published anchors rather than assume changes to mirrored files can become an upstream collaboration path.

The [conformance guide](https://meta-models.github.io/muse-code-sdk/next/guides/msp-wire/conformance/) describes transcript replay and says the packaged corpus and interactive testkit are not yet distributed. The repository also advertises recorded fixtures. Inventory the exact pinned checkout before committing to complete official conformance coverage; do not equate a subset of public SDK fixtures with the full server corpus. Missing fixtures must become explicit coverage gaps supplemented by captured, sanitized local scenarios.

Run identical scenarios against each adapter using separate sessions/worktrees. Never mirror mutating commands into the same live session. Compare normalized authoritative state and command facts, not byte-identical IDs or stream timing. Require existing lifecycle, permissions, structured questions, model changes, concurrent scheduling, host/broker death, uncertain-command reconciliation and native saturation tests. Add malformed frames, late duplicates, schema mismatches, closed stdin, oversized history and bounded resource exhaustion.

## Phased decision gates

- **Contract first:** inventory current Lascoria operations, pin schema/source provenance, build a backend-neutral conformance runner and retain Node as the reference.
- **Read-only experiment:** implement transport and bounded history/fold in a separate experimental crate. Replay fixtures, compare cold state and gap convergence, and account for retained allocations.
- **Controlled execution:** add commands and decisions in isolated fixtures; prove cancellation, teardown, no replay and account-mode isolation. Then run live Muse from the native UI.
- **Adoption decision:** repeat identical one- and ten-session startup, idle, streaming, recovery and large-history workloads at least three times per backend. Compare p95 latency, peak/steady RSS, CPU, bundle size and failure isolation. Adopt only with parity and a concrete packaging or measured performance gain; retain a tested Node fallback through an upgrade cycle.

This is a multi-increment protocol implementation and ongoing compatibility commitment, not a small authentication patch. A credible calendar estimate should follow the schema/fixture inventory and the first fold prototype. A general-purpose public SDK, multi-platform distribution and broad MSP coverage are separate scope decisions; Lascoria only needs a tested subset initially.

## Authentication isolation finding

The account implementation must distinguish **sign out of Lascoria** from **revoke the shared Muse credential**. The experimental [`account/logout` contract](https://meta-models.github.io/muse-code-sdk/next/generated/msp/methods/account-logout/) explicitly includes a best-effort session revoke before clearing credentials. A private `XDG_CONFIG_HOME` redirects metadata but does not establish an independent macOS Keychain namespace. The installed native 1.4.9 binary contains the service identifier `ai.meta.dev.credentials`; no supported per-client Keychain-service override was established in this review. Treat the credential cache as potentially shared with Muse CLI.

A local Lascoria logout should persist the logged-out policy, cancel pending login and close authenticated hosts, leaving the shared Muse cache untouched. Returning through **Continue with Muse** must require successful completion of a new browser flow; merely observing an existing Muse `loggedIn` state must not bypass Lascoria's logout. API credentials remain inactive until explicitly selected. Document that logging out locally does not revoke other Muse clients.

The installed launcher at `/Users/kabudu/.local/bin/muse`, lines 19–25 and 472–499, lets `MUSE_AUTH_PATH` override its credential metadata read path. This is launcher evidence, not proof that native MSP honours that variable: the native executable contains no matching variable name. Managed children should remove the ambient override to avoid the launcher's separate credential lookup crossing Lascoria's selected configuration. Integration fixtures must use an environment-only dummy API key rather than legacy on-disk credential records that Muse could migrate into a shared credential store. The suspected legacy-file migration requires before/after validation; it was not proven by this read-only review.
