# Decision assistance

Status: all three interaction models are implemented (manual snapshot review, background triage and a Muse-callable tool), with aggregate metrics and agree/disagree overrides. Live BYOK acceptance, independent quality checks and native platform acceptance remain open, so the R10 release gate is not closed. These are separate APIs and charges from Muse Code. Lascoria's official Node SDK worker continues to own Muse integration; the Rust supervisor owns this optional advice service.

## Configure and review

Open **Settings, Integrations, Decision assistance**. Each provider starts off. Save its key in the operating-system credential vault, choose a model, enable manual reviews and allow the current session's workspace. Saving or replacing a key turns that provider off and clears its workspace consent first. Removing a key does the same; a failed vault operation never silently re-enables access. The Muse subscription and Muse API key are separate entries and are unaffected.

**Test connection (paid API)** explicitly sends a fixed public arithmetic sentence, not workspace data, and may incur a charge. There are no automatic connection tests, retries or fallback destinations. A saved-key indicator remembers a successful vault write; the key is checked again when used, so removal outside Lascoria can require saving it again.

In a standalone session's **Diff** tab, select a saved snapshot and expand **Optional decision assistance**. Ask a yes/no question, choose among two to eight options, or score two to eight ordered levels. Preview shows the exact JSON text to be sent, the question, model, endpoint and byte count. It includes the selected capture's text patch and new-file records, not a whole transcript or arbitrary folder scan. A snapshot over 32,000 input bytes is refused rather than silently truncated. Project capture limitations still apply: multi-repository Projects need explicit repository selection before their snapshots can be reviewed.

Only **Send this snapshot for advice** starts the paid review. Lascoria verifies the live repository fingerprint before sending and again after receiving the answer. A changed snapshot, configuration or credential revision invalidates the preview or marks the answer stale. Results describe a dated check; files may change afterwards. Advice cannot accept evidence, approve a tool, route a model or send anything to Muse.

Provider probabilities are estimates, not correctness guarantees, and are not comparably calibrated across providers. Choice and score details retain each provider's native probabilities, labels and confidence; no explanation or chain of thought is fabricated. Model/request identity, source fingerprint, rubric version, timestamp, reported token counts and latency are inspectable. Price remains unknown because these contracts do not report a billed amount.

## Background triage

**Background triage** in the same settings is off until you choose a provider for it and turn it on for a session's workspace; this consent is separate from manual reviews, and choosing a different provider clears it. Unlike manual reviews it sends data without asking each time. About every 15 seconds Lascoria looks at the chosen workspaces for a session whose latest task finished or that is waiting for you, and sends one predicate ("does this need the user's attention soon?") about each such update, once. The text is built by the supervisor from the session record and limited to the parts you choose: what you asked for (your own words, never Lascoria's hidden context notes), Muse's latest reply and the task outcome, and the question Muse is waiting on. At most three updates are sent per pass and at most the daily limit you set (default 50). When the answer is at least 50%, a quiet "Likely needs you" note appears beside the session name.

## Muse can ask

**Muse can ask** gives sessions in the workspaces you turn on an `ask_decision_assistant` tool in their local Lascoria tools. Muse asks one yes/no, choice or score question (two to eight options) about up to 16,000 characters of text it chooses. The tool is refused, with an instruction to continue without it, unless you turned it on for that workspace; it has a daily limit, and repeating a request ID returns the recorded answer without a second call. Muse sees the answer with a notice that it is an estimate that approves nothing. Because Muse chooses the text, a confused or prompt-injected session could send repository content to your provider: turn this on only where that is acceptable (security finding F8).

Replacing, removing or disabling a provider's key turns off both modes for that provider, before the vault is touched.

## Metrics and overrides

A collapsed **Usage summary** shows, per provider, requests overall and in the last 24 hours, by use (reviews, triage, Muse, tests) and by outcome, reported tokens, typical and 95th-percentile latency, and how often you marked an answer wrong. **Seems right / Seems wrong** on an answered result records that judgement. Cost stays unknown because these APIs do not report a billed amount.

## Failure, privacy and bounds

Credentials bypass the command journal and never enter React state. The password field clears on submission. Credential reads/writes use a shared native-vault admission limit and ten-second deadlines; a timed-out native operation retains its permit until the blocking operation really finishes. Advice does not acquire a Muse session lane or hold the database lock across network or vault work. The session relay helper has no access to these operations.

The supervisor admits at most two requests globally. HTTPS destinations are compiled-in vendor endpoints, redirects and automatic transport retries are disabled, connection establishment is bounded to five seconds and the HTTP request to twenty seconds. Responses are limited to 32 KiB and validated against the requested question. Repository checks reuse the existing bounded capture implementation with an outer ten-second deadline. Cancellation is available while a request is preparing or running; cancelling does not establish that the provider did not bill it. A request that has not yet started or already finished is reported as such.

An identity is persisted before HTTP egress. Previews and connection-test admission are bound to the running supervisor generation, so an old preview cannot spend after a restart or restore even if a backup predates its request record. A lost response, process exit or incomplete outcome cannot trigger a paid retry: **Retrieve original request** is read-only, and an interrupted request is shown as unknown. A new call requires a new explicit send. The latest 100 full results are retained, with up to 5,000 compact request identities; admission stops at that bound instead of forgetting identities and risking replay. Configuration uses a namespaced presentation record and outcomes use an indexed decisions table in the same durable database. Schema 4 upgrades schema 3 in place without replacing sessions; older readers refuse the newer schema. Request lookup and the latest-100 history read do not materialise the entire retained history. No separate unsynchronised history file is introduced. Removing an archived session strips its full advice data while retaining compact request identities; the normal pre-cleanup safety backup retains the original data. Raw snapshot inputs are not duplicated into the request history; the original captures remain subject to their existing retention rules. Response bodies and unrecognised fields are not logged; credential reflection is rejected before persistence. Request history includes the user's question and is private local application data.

The provider's account retention policy applies. Lascoria neither promises zero retention nor invents a per-request control that these endpoints do not expose. Review the displayed vendor policy before enabling a workspace:

- [TypeSafe API](https://docs.typesafe.ai/api): named `noul`, `choice` and `score` questions and keyed answers.
- [SubQ Decisions](https://docs.subq.ai/endpoints/decisions-api/) and [retention](https://docs.subq.ai/using-the-api/data-retention/): a separate preview API, not the chat compatibility route.
- [OpenAI Decisions](https://developers.openai.com/api/reference/resources/decisions/methods/create) and [data controls](https://developers.openai.com/api/docs/guides/your-data): named predicate/choice/score questions and typed answer arrays.

## Acceptance still required

Controlled tests cover native wire shapes for all nine provider/question combinations, local HTTP lifecycle, disclosure, workspace consent, lost replies, retained identities, cancellation, admission, stale files/configuration, bad responses, credential reflection and helper authority. These prove integration mechanics, not live model quality, live billing or native platform acceptance. Background triage, the Muse tool, metrics and overrides have their own controlled tests (consent, chosen parts only, once per update, daily limits, idempotency, revocation). R10 is not complete until live trials, independent task-quality checks and native macOS, Windows and Linux acceptance pass.
