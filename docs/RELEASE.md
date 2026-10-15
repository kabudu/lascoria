# Release and validation policy

Lascoria remains private. GitHub Actions is disabled at repository level by the owner's instruction. Repository-owned local CI is authoritative during private development; disabled or absent hosted checks are policy-compliant and must never be reported as passing hosted CI. The prepared workflow source is retained for later explicit activation.

Run the same entry point for each final reviewed increment:

```sh
./scripts/ci-local.sh
```

Bootstrap dependencies separately: Node matching package.json, the pinned Rust toolchain/components, npm dependencies, compatible Muse 1.4.9 on PATH (or MUSE_BIN), Playwright's Chromium runtime and platform-native Tauri libraries. Gitleaks must be installed. The script does not install dependencies or fetch crates; Cargo runs offline, Muse auto-update is disabled, and model tests use local controlled providers/echo. A fresh machine must first obtain the documented dependencies from their official sources. Native live provider acceptance remains separate and must not be inferred from fixture tests.

The gate scans tracked source only, rejects U+2014 and broken/out-of-repository documentation links, checks application metadata, runs redacted working-tree, staged-index and full reachable-history secret scans, diff hygiene, formatting/static analysis, Rust runtime/native tests, the complete Node suite and React/native-bridge workflows. It fails on missing dependencies and does not silently skip required checks. A specifically reviewed prose-only historical Gitleaks false positive is listed by exact fingerprint; no secret rule or source tree is broadly excluded. The text scanner refuses symlinks/linked ancestors and oversized inputs before reading contents. Secret scanning does not establish complete personal-data, licensing or public-claim clearance.

Record the exact command, reviewed commit, OS/tool versions, exit status and evidence location in the PR. A change after that run needs the affected validation repeated, with a final-head CI run before claiming the increment satisfies this gate. Keep raw native/model captures private; commit only minimised synthetic/public evidence. Do not run simultaneous Playwright invocations or competing debug/release resource packaging.

Use [the running release checklist](release-readiness.md) and [public-launch gates](public-launch.md) for acceptance and stop-ship conditions. Public opening, hosted-CI activation and signed artifact publication need the explicit documented owner-approved gate. Visibility alone is not approval to activate hosted CI. Do not create a release, publish a package, merge the current draft PR or make the repository public from this policy alone.

The current implementation is delivered on an explicitly stacked draft feature branch. Preserve its base/history until authorised delivery resolves it. Review remote changes and feedback, fix material findings, verify the final head and only then merge/synchronise/clean branches when authorised. Public release requires the complete OS/architecture and signing/updating contract, versioned curated release notes, rendered desktop/narrow previews, immutable artifact identity/checksums and safe resumption after partial publication.
