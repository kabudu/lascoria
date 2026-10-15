# Lascoria development

Use Lazarus mode for implementation, reviews, validation and release work. The Rust supervisor owns durable control; the official Node SDK worker owns the Muse integration; Tauri/React owns presentation. Keep the default UI quiet and progressively disclose diagnostics.

The authoritative release inventory is docs/release-readiness.md with evidence/status in docs/implementation-progress.md. Public-opening gates are in docs/public-launch.md. Documentation alone does not complete a feature or platform gate.

## Delivery and validation

- Preserve unrelated changes and existing native user sessions/questions. Use isolated state directories for QA, close owned QA windows/processes and never restart the user's supervisor to test a build.
- Keep increments scoped, update behavioural tests/docs/checklists and self-review correctness, resource bounds, security, protocol compatibility, failure/retry semantics and UX. Validate a final reviewed head through ./scripts/ci-local.sh; record the command, revision and result in its PR.
- Start new independent work from the current clean base using codex/ branches. Preserve the current explicitly stacked draft PR until its delivery is resolved. Commit/push intended files, inspect remote diffs/reviews and keep evidence current. Merge, default-branch synchronisation, branch deletion and publication require the applicable authority; the current request authorises commit/push, not merge or release.
- While private, GitHub Actions stays disabled at repository level and local CI is authoritative. Existing prepared workflow source stays committed at the user's request. Visibility change and hosted-CI activation require the explicit public-opening/release gate; never call absent hosted CI passing.
- Do not publish packages, releases, binaries, websites or announcements, or change visibility merely because a PR is ready. Signed distribution, curated release previews and immutable artifact reconciliation have their own gates.

## Privacy and hygiene

- Never read, print or commit .dev/.muse-api-key. Keep credentials, real live captures and private environment evidence out of tracked files/history. Prefer synthetic/public fixtures; full-history secret scanning does not by itself establish full privacy clearance.
- Run the repository text/privacy checks before commit/push. Do not introduce U+2014. Keep scanner exceptions specific to a reviewed false positive; never exclude entire secret rules or source trees to make a gate green.
- Local CI performs no dependency installation. Bootstrap the pinned Rust/Node/Muse/browser dependencies separately; run tests with local controlled providers rather than real paid providers. Live native trials are separate, explicit acceptance evidence.
- Do not run two Playwright invocations together, edit UI sources while a UI suite runs, or run competing debug/release runtime packaging commands against .dev/bundle-runtime.
