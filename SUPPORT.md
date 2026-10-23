# Getting help

Start with **Help** in Lascoria's workspace menu. It is an offline, searchable guide to setup, accounts, sessions, Projects, attachments, skills, usage, local sharing, recovery and updates. The [README](README.md#documentation) links to the longer repository guides.

Lascoria is preparing its first public release. macOS, Windows and Linux are required targets, but their remaining acceptance work is recorded in the [release checklist](docs/implementation-progress.md). Development and QA builds are not supported public installers, and no guaranteed support response time is declared.

## Questions, bugs and feature requests

Use the repository's [issues](https://github.com/kabudu/lascoria/issues) for non-sensitive questions, reproducible bugs and feature proposals when you have access. Check the [roadmap](ROADMAP.md) and existing issues first. For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md) instead.

Include:

- Lascoria's version or source revision, your operating system and architecture, and the Muse version.
- The steps that reproduce the problem, what you expected and what happened.
- Whether it repeats in a disposable session or repository.
- The relevant error text and a sanitised screenshot or small synthetic fixture, if useful.

Do not post passwords, API keys, account identifiers, control tokens, private paths, raw state databases, backups or real conversations. Provider billing and subscription allowance are managed by the provider; Lascoria cannot change them or turn an API-key billing failure into a subscription result.

## Prepare a support report

Open **Settings → Data & privacy → Support report**. Read the preview before saving. It contains selected versions, counts and state summaries, not task text, conversations, paths, names or keys. Saving does not upload it anywhere; choose what to share yourself.

A support report is different from a transcript export or backup. Those contain private work and should not be attached to an issue. Diagnostic timings are not a billing statement or a complete CPU/memory report.

## Recover without making things worse

- For sign-in errors, open **Muse account** and reconnect. An expired subscription never silently switches to API billing.
- If the window closed while work continued, reopen it and inspect the current session before sending the task again.
- If an operation has an unknown outcome, inspect its effects and retained progress. A new request can duplicate a side effect; do not repeatedly resubmit it.
- If Lascoria says changes are not saved, free space or resolve the storage problem and keep its background service running until the warning clears.
- Before restoring data or testing an older build, read [Data and lifecycle requirements](docs/release-readiness.md#r5---durable-data-authentication-and-lifecycle-acceptance) and the in-app confirmation. Newer data formats cannot be assumed to work in older binaries.

Do not replace runtime files while tasks are active or delete a state directory as a first troubleshooting step. Keep your original work and backups until you understand the failure.

## macOS update address rejected

Lascoria 0.1.2 and 0.1.3 on macOS can reject a universal update with “The update's download address does not match this version and computer's secure release source”. The downloaded package has not been installed. This is a filename-validation defect in those versions, not evidence that the app is up to date.

Download the current universal macOS installer from [GitHub Releases](https://github.com/kabudu/lascoria/releases/latest). Pause work and quit Lascoria safely before replacing the app. The corrected updater accepts the universal package for both Apple Silicon and Intel while retaining the exact repository/version checks and mandatory signature verification. Versions that contain the correction still require a normal signed release before distribution.
