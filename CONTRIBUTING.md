# Contributing to Lascoria

Lascoria is preparing its first public release. Start with the [README](README.md), [release-readiness backlog](docs/release-readiness.md) and [roadmap](ROADMAP.md). Read [AGENTS.md](AGENTS.md) before changing or validating the implementation; it applies to people and coding agents alike.

For a substantial feature or change in scope, discuss the proposed behaviour in a repository issue first. For a security concern, use [SECURITY.md](SECURITY.md) instead of a public issue or pull request.

## Set up and validate

Use the pinned Rust toolchain, Node.js 24 or newer, Git, the native Tauri libraries for your operating system and the tested Muse version. The [release policy](docs/RELEASE.md) records setup and validation requirements. Bootstrap dependencies separately:

```sh
npm ci
npm run desktop:dev
```

Use disposable repositories and isolated Lascoria state for tests. Preserve existing sessions, pending questions and user work; never restart someone else's supervisor to test a build. Local CI uses controlled providers, not paid model accounts.

Run focused checks while working, then validate the final reviewed revision:

```sh
./scripts/ci-local.sh
```

Do not run two Playwright suites together, change UI sources during a UI suite, or run competing runtime-packaging commands. While the repository is private, hosted Actions stays disabled and local CI is authoritative. Prepared workflow files are not evidence that a hosted run passed.

## Shape a useful change

- Keep the default workspace quiet. Put technical diagnostics behind progressive disclosure and use plain language for user-facing actions.
- Preserve ownership: Rust controls durable state, the official Node SDK worker integrates Muse, and Tauri/React presents it. Do not bypass Muse's permission or approval boundaries.
- Make failure behaviour explicit. Review cancellation, partial writes, stale state, lost replies, retries, resource limits and cleanup alongside the successful path.
- Add behavioural regression coverage for meaningful changes. Reproduce a reported defect when practical, then verify the same case after the fix.
- Update affected help, documentation, changelog and running checklists. Distinguish implemented behaviour from native acceptance and future scope.
- Keep secrets, real transcripts, private repositories and environment-specific captures out of tracked files and reports. Do not weaken a scanner rule to hide a finding.

## Send a pull request

Describe the problem and resulting behaviour, the checks you ran, the tested revision and operating system, and any remaining limitations. Use a draft when work or validation is incomplete. Keep unrelated changes out of the diff, and do not add AI co-author or session trailers to commit messages.

Commit/push, merge, public opening and publication are separate actions. A passing PR does not authorise signing-key changes, enabling hosted Actions, changing repository visibility or publishing artifacts. Maintainers follow the [release policy](docs/RELEASE.md) and [public-opening gates](docs/public-launch.md).

## Licence

Lascoria is licensed under [Apache-2.0](LICENSE). Contributions intentionally submitted for inclusion are covered by its contribution terms unless explicitly stated otherwise. Keep existing copyright and third-party notices, and include the provenance and licence of any new dependency or asset. Do not submit material you do not have permission to contribute.
