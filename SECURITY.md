# Security policy

Lascoria is preparing its first public release. No supported release series or security-maintenance window has been declared yet. The [release checklist](docs/implementation-progress.md) distinguishes implemented controls from remaining acceptance work; the [security review](docs/security-review.md) records the threat model, tested boundaries and known findings.

## Report a vulnerability privately

Do not put credentials, private source, live transcripts or a usable exploit in a public issue or pull request.

The intended reporting channel is [GitHub private vulnerability reporting](https://github.com/kabudu/lascoria/security/advisories/new). Its availability must be enabled and verified before public opening; this document does not claim that it is already enabled. If the link is unavailable, ask the maintainer to establish a private reporting channel without including vulnerability details in that request. No reporting email, response deadline or bug-bounty programme is currently declared.

A useful private report includes:

- The affected revision or version, operating system and architecture.
- The behaviour you expected and what happened, with minimal reproduction steps.
- The trust boundary crossed and likely impact.
- A synthetic fixture or proof where possible, with secrets and personal data removed.

Test only systems and data you own or have permission to assess. Preserve other users' sessions and report data-loss or credential-exposure risks without exploiting them against real accounts.

## Important boundaries

Muse owns its model execution and native permissions. Lascoria's local supervisor owns command admission, recovery, workspace actions and explicit local session sharing. Model output, peer messages and decision-provider advice must never approve tools or grant authority. A completed task is not automatically accepted evidence.

API keys belong in the operating-system credential vault; private transcripts, backups and exports remain sensitive local data. Explicitly enabled decision integrations can send disclosed workspace content to their providers. The [account policy](docs/accounts.md), [decision-assistance guide](docs/decision-assistance.md) and [security review](docs/security-review.md) explain those limits.

Signed distribution, updater verification, dependency review and platform acceptance have separate [release gates](docs/public-launch.md). A clean secret scan or passing local test suite does not establish full security clearance. Security fixes and any affected-version guidance will be recorded in the [changelog](CHANGELOG.md).
