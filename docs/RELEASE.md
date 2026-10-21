# Release and validation policy

Lascoria remains private. GitHub Actions is disabled at repository level by the owner's instruction. Repository-owned local CI is authoritative during private development; disabled or absent hosted checks are policy-compliant and must never be reported as passing hosted CI. The prepared workflow source is retained for later explicit activation.

Run the same entry point for each final reviewed increment:

```sh
./scripts/ci-local.sh
```

Bootstrap dependencies separately: Node matching package.json, the pinned Rust toolchain/components, npm dependencies, compatible Muse 1.4.10 on PATH (or MUSE_BIN), Playwright's Chromium runtime and platform-native Tauri libraries. Gitleaks must be installed. The script does not install dependencies or fetch crates; Cargo runs offline, Muse auto-update is disabled, and model tests use local controlled providers/echo. A fresh machine must first obtain the documented dependencies from their official sources. Native live provider acceptance remains separate and must not be inferred from fixture tests.

The gate scans tracked source only, rejects U+2014 and broken/out-of-repository documentation links, checks application metadata, runs redacted working-tree, staged-index and full reachable-history secret scans, diff hygiene, formatting/static analysis, Rust runtime/native tests, the complete Node suite and React/native-bridge workflows. It fails on missing dependencies and does not silently skip required checks. A specifically reviewed prose-only historical Gitleaks false positive is listed by exact fingerprint; no secret rule or source tree is broadly excluded. The text scanner refuses symlinks/linked ancestors and oversized inputs before reading contents. Secret scanning does not establish complete personal-data, licensing or public-claim clearance.

Record the exact command, reviewed commit, OS/tool versions, exit status and evidence location in the PR. A change after that run needs the affected validation repeated, with a final-head CI run before claiming the increment satisfies this gate. Keep raw native/model captures private; commit only minimised synthetic/public evidence. Do not run simultaneous Playwright invocations or competing debug/release resource packaging.

Use [the running release checklist](release-readiness.md) and [public-launch gates](public-launch.md) for acceptance and stop-ship conditions. Public opening, hosted-CI activation and signed artifact publication need the explicit documented owner-approved gate. Visibility alone is not approval to activate hosted CI. Do not create a release, publish a package, merge the current draft PR or make the repository public from this policy alone. The prepared release process is described under [Cutting a release](#cutting-a-release).

The current implementation is delivered on an explicitly stacked draft feature branch. Preserve its base/history until authorised delivery resolves it. Review remote changes and feedback, fix material findings, verify the final head and only then merge/synchronise/clean branches when authorised. Public release requires the complete OS/architecture and signing/updating contract, versioned curated release notes, rendered desktop/narrow previews, immutable artifact identity/checksums and safe resumption after partial publication.

## Cutting a release

The release pipeline follows the `projex/qatq` process: a version tag on the default branch starts `.github/workflows/release.yml`, which checks the tree against the tag, builds every supported target natively, signs and notarizes, and creates a real GitHub Release with the packages, a signed updater manifest and checksums. It is prepared but inactive: Actions are disabled while the repository is private, and the workflow also skips itself on a private repository.

### One-time setup (maintainer)

Repository secrets and variables. Values never go in the repository or in the app.

| Name | Kind | What it is |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | The updater signing key. Create it yourself with `npx tauri signer generate -w ~/.tauri/lascoria-updater.key` and keep a private backup: losing it means existing installs can no longer update. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | Its password. |
| `LASCORIA_UPDATER_PUBKEY` | variable | The matching public key (`~/.tauri/lascoria-updater.key.pub`). Release builds bake it in; development builds have none and report updates as not configured. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | secrets | Base64 Developer ID Application certificate (.p12) and its password, as for qatq. |
| `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` | variables or secrets | Signing identity and team, as for qatq. |
| `APPLE_ID`, `APPLE_PASSWORD` | secrets | Notarization Apple ID and app-specific password, as for qatq. |

Windows packages are not Authenticode-signed yet, so Windows may show a SmartScreen warning on first run; the updater signature still protects updates. Add a code-signing certificate before calling Windows support complete.

### Each release

1. `node scripts/release.js prepare X.Y.Z` (or `X.Y.Z-beta.N` for a beta). It moves the `## Unreleased` entries in `CHANGELOG.md` under `## X.Y.Z - <date>`, leaves an empty `## Unreleased`, bumps every version field (npm, Tauri, the three Cargo packages and their lockfiles) and creates `docs/releases/vX.Y.Z.md`.
2. Curate `docs/releases/vX.Y.Z.md`: the first line is the release title, `# Lascoria vX.Y.Z: short theme`; the rest is the release body (opening, material changes, compatibility and support limits, one install path), one paragraph or list item per line, no U+2014. The GitHub Release links to the CHANGELOG for the full list.
3. Run `./scripts/ci-local.sh`, review the diff, commit, and merge to the default branch through the normal review.
4. Tag that commit `vX.Y.Z` and push the tag. The workflow refuses tags that are not on the default branch, versions that disagree, a missing CHANGELOG section or uncurated notes (`node scripts/release.js verify vX.Y.Z` runs the same check locally).
5. The workflow builds macOS (Apple silicon and Intel: app and DMG, signed and notarized), Windows x64 (NSIS installer) and Linux x64 and ARM64 (AppImage and .deb). It uploads everything to a draft release, checks the asset list, then publishes. Tags with a pre-release suffix are published as prereleases.
6. In-app updates read `latest.json`: stable installs from the latest non-prerelease, beta installs from the rolling `updater-beta` prerelease, which every release refreshes. The app verifies each bundle's signature, and the signed version, before installing.

If a run fails after the draft was created, rerunning the workflow deletes that unpublished draft and starts again. A published release is never overwritten; fix it by hand and cut a new version.


### Local macOS signing acceptance

Use an existing local Developer ID identity and its ten-character team ID in `APPLE_SIGNING_IDENTITY` and `LASCORIA_APPLE_TEAM_ID`, without exporting private keys. Run:

```sh
node scripts/package-macos-qa.js --developer-id
node testing/macos-signing-smoke.js
```

The QA app keeps its isolated identity/path, compiles the supervisor's team requirement, signs the Node runtime with its V8 entitlements and the supervisor without extra entitlements, then seals the app with hardened runtime. It does not submit for notarization, configure updater signing, install globally or publish. The default QA command remains ad hoc and removes the release-team variable for its build. Both modes suppress inherited notarization credentials for the local QA bundler.

The smoke uses disposable state and a minimal native socket peer. It proves signed-peer acceptance, token-only interpreter refusal, same-path ad hoc refusal and acceptance after restoring the valid signature, without restarting the supervisor or making model calls. It checks that runtime provenance matches the signed bytes. The release workflow uses the same runtime signer before sealing/notarizing the production app; provenance describes the final signed executables, rather than their pre-signing hashes. This check does not establish notarization, installed-app accessibility or N-to-N+1 updates.
