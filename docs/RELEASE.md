# Release and validation policy

Lascoria source is public under the owner’s explicit approval on 21 October. The native validation workflow is enabled and has passed on macOS, Windows and Linux. Master protection requires the verified native check names, zero required approving reviews, resolved conversations and linear history; force pushes and deletions are disabled. Public source opening does not approve binary, release or website publication. Local and hosted evidence must name the exact revision and scope; running or absent checks are never reported as passing.

Run the same entry point for each final reviewed increment:

```sh
./scripts/ci-local.sh
```

Bootstrap dependencies separately: Node matching package.json, the pinned Rust toolchain/components, npm dependencies, compatible Muse 1.4.10 on PATH (or MUSE_BIN), Playwright's Chromium runtime and platform-native Tauri libraries. Gitleaks must be installed. The script stages the generated debug runtime before native compilation, including on a clean checkout. It does not install dependencies or fetch crates; Cargo runs offline, Muse auto-update is disabled, and model tests use local controlled providers/echo. A fresh machine must first obtain the documented dependencies from their official sources. Native live provider acceptance remains separate and must not be inferred from fixture tests.

The gate scans tracked source only, rejects U+2014 and broken/out-of-repository documentation links, checks application metadata, runs redacted working-tree, staged-index and full reachable-history secret scans, diff hygiene, formatting/static analysis, Rust runtime/native tests, the complete Node suite and React/native-bridge workflows. It fails on missing dependencies and does not silently skip required checks. A specifically reviewed prose-only historical Gitleaks false positive is listed by exact fingerprint; no secret rule or source tree is broadly excluded. The text scanner refuses symlinks/linked ancestors and oversized inputs before reading contents. Secret scanning does not establish complete personal-data, licensing or public-claim clearance.

Record the exact command, reviewed commit, OS/tool versions, exit status and evidence location in the PR. A change after that run needs the affected validation repeated, with a final-head CI run before claiming the increment satisfies this gate. Keep raw native/model captures private; commit only minimised synthetic/public evidence. Do not run simultaneous Playwright invocations or competing debug/release resource packaging.

Use [the running release checklist](release-readiness.md) and [public-launch gates](public-launch.md) for acceptance and stop-ship conditions. Public opening, hosted-CI activation and signed artifact publication need the explicit documented owner-approved gate. Visibility alone is not approval to activate hosted CI. Do not create a release, publish a package, merge the current draft PR or make the repository public from this policy alone. The prepared release process is described under [Cutting a release](#cutting-a-release).

The current draft PR targets master after the owner-authorised retarget on 21 October. Preserve its head/history until authorised delivery resolves it. Review remote changes and feedback, fix material findings, verify the final head and only then merge/synchronise/clean branches when authorised. Public release requires the complete OS/architecture and signing/updating contract, versioned curated release notes, rendered desktop/narrow previews, immutable artifact identity/checksums and safe resumption after partial publication.

## Cutting a release

The prepared release pipeline starts from a version tag on the default branch: `.github/workflows/release.yml` checks versions and curated notes, requires the reusable native validation workflow, builds the target matrix, signs/notarizes the macOS bundles, signs updater bundles, and reconciles the complete immutable artifact set before publication. The updater manifest contains each artifact's signature; it is not itself a substitute for artifact verification. It is prepared but inactive: Actions are disabled while the repository is private, and the workflow also skips itself on a private repository.

### One-time setup (maintainer)

Repository secrets and variables. Values never go in the repository or in the app.

| Name | Kind | What it is |
| --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | secret | Provisioned 21 October. The production updater key is encrypted, with a private local copy and separate native credential storage for its password. Keep a private recovery backup; do not regenerate it for QA or print/export it through diagnostics. Losing it can prevent existing installs from updating. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | secret | Provisioned 21 October. Kept separately from the encrypted key; never recorded in source, command arguments or public evidence. |
| `LASCORIA_UPDATER_PUBKEY` | variable | Provisioned 21 October; release builds bake in the matching production public key. Its SHA-256 fingerprint is `17505c24c73e6d6362ab25200019023a684b30d862921ce0d69f7262299eae35`. Ordinary development builds have no key and report updates as not configured. QA uses a separate fixture key. |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD` | secrets | Configured and verified by name on 21 October: the Developer ID Application certificate (.p12) and its password, following the existing release setup. |
| `APPLE_SIGNING_IDENTITY`, `APPLE_TEAM_ID` | variables or secrets | Configured and verified by name on 21 October: the existing signing identity and team. |
| `APPLE_ID`, `APPLE_PASSWORD` | secrets | Configured and verified by name on 21 October: the existing notarization account and app-specific password. |

The owner approved unsigned Windows installers for the first release on 21 October. Publisher signing (Authenticode) is deferred; signed Tauri updater artifacts, checksums and native installer/update acceptance remain required. Windows may display an unknown-publisher or reputation warning. Smart App Control or managed policies can block unsigned applications, so installation is not supported under policies that refuse this build. Do not recommend disabling protection. See [Microsoft’s Smart App Control guidance](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions) and [Tauri’s Windows signing guidance](https://v2.tauri.app/distribute/sign/windows/).

### Candidate artifact acceptance

Run Release manually on the reviewed candidate branch to build and upload signed artifacts for native acceptance without creating a tag or GitHub Release. The version is read from the manifests and checked against the curated notes/changelog. Builds and the native matrix run in parallel; publication always depends on both. Download the exact candidate artifacts for the installed-platform checks before the version-tag publication run. Manual runs never enter the publisher.

### Each release

1. `node scripts/release.js prepare X.Y.Z` (or `X.Y.Z-beta.N` for a beta). Strict SemVer and a complete version/lockfile preflight run before edits; malformed versions, missing entries and inconsistent versions are refused. It moves the `## Unreleased` entries in `CHANGELOG.md` under `## X.Y.Z - <date>`, leaves an empty `## Unreleased`, bumps every version field (npm, Tauri, the three Cargo packages and their lockfiles) and creates `docs/releases/vX.Y.Z.md`.
2. Curate `docs/releases/vX.Y.Z.md`: the first line is the release title, `# Lascoria vX.Y.Z: short theme`; the rest is the release body (opening, material changes, compatibility and support limits, one install path), one paragraph or list item per line, no U+2014. The GitHub Release links to the CHANGELOG for the full list.
3. Run `./scripts/ci-local.sh`, review the diff, commit, and merge to the default branch through the normal review.
4. Tag that commit `vX.Y.Z` and push the tag. The workflow refuses tags that are not on the default branch, versions that disagree, a missing CHANGELOG section or uncurated notes (`node scripts/release.js verify vX.Y.Z` runs the same check locally).
5. The workflow builds macOS (Apple silicon and Intel: app and DMG, signed and notarized), Windows x64 (NSIS installer) and Linux x64 and ARM64 (AppImage and .deb). The inventory requires every declared target and installer/updater artifact. A globally serialized publication job verifies local checksums, the reviewed tag/commit, repository visibility and metadata, then resumes or creates a matching draft. It verifies remote sizes/digests before publishing. Tags with a prerelease suffix are published as prereleases. Windows Authenticode is deferred by the first-release policy above.
6. In-app updates read `latest.json`: stable installs use the latest stable release; beta installs use the rolling `updater-beta` prerelease. Publishing an older completed build cannot move either channel backwards. The beta job uploads and verifies a stage, renames the old manifest to a digest backup, then promotes the stage. A brief missing-manifest response during an interrupted swap is a recoverable check failure; rerunning reconciles the highest verified version. The app verifies artifact signatures and signed versions before installation.

Interrupted publication never deletes/recreates a version draft or clobbers immutable assets. `scripts/publish-release.js` resumes only matching tag/commit/title/body/prerelease metadata and byte-identical assets; missing assets can be added to that draft. Existing matching published releases are recognised without mutation. Unknown assets, changed bytes, authentication failures or ambiguous identities stop the run for reconciliation. Lost mutation replies are observed before a bounded retry. Valid Retry-After deadlines are honoured within a 60-second cumulative wait budget and three attempts; individual requests and the whole operation have explicit time/count limits. Reuse the original reviewed artifact set when resuming: a rebuild with different signing timestamps or manifest bytes is a conflict, not permission to overwrite the earlier draft.

The mutable beta alias is separate from immutable version releases. It retains verified backup manifests, never lowers the selected version, and rejects equal-version/different-byte conflicts. Its 64-asset bound requires explicit backup reconciliation before exhaustion; no automatic deletion of published version artifacts is provided. Hosted publication/retry behaviour has controlled API-fixture coverage, not a claim that an inactive workflow has run against GitHub.

Every current update replaces the full runtime. On **all three operating systems**, installation therefore requires explicit pause/stop of active work; Rust independently holds the supervisor's owner lock while replacing files, excluding another window or service writer. A retained UI-only update would require a separately negotiated immutable runtime and is not the present behaviour. Keep drafts, account policy and uncertain command outcomes through restart, and never replay a tool merely to make recovery look complete. Scoped macOS signed N-to-N+1 acceptance is recorded below; Windows/Linux, production-pipeline and remaining failure/migration acceptance stay open.


### Local macOS signing acceptance

Use an existing local Developer ID identity and its ten-character team ID in `APPLE_SIGNING_IDENTITY` and `LASCORIA_APPLE_TEAM_ID`, without exporting private keys. Run:

```sh
node scripts/package-macos-qa.js --developer-id
node testing/macos-signing-smoke.js
```

The QA app keeps its isolated identity/path, compiles the supervisor's team requirement, signs the Node runtime with its V8 entitlements and the supervisor without extra entitlements, then seals the app with hardened runtime. `--update-acceptance` is an explicit additional build feature: it requires Developer ID signing, a compile-time HTTPS loopback endpoint, its fixture CA and a separate QA updater public key. Production builds have no runtime endpoint/key override and do not include the QA trust boundary. It does not submit for notarization, configure updater signing, install globally or publish. The default QA command remains ad hoc and removes the release-team variable for its build. Both modes suppress inherited notarization credentials for the local QA bundler.

The smoke uses disposable state and a minimal native socket peer. It proves signed-peer acceptance, token-only interpreter refusal, same-path ad hoc refusal and acceptance after restoring the valid signature, without restarting the supervisor or making model calls. It checks that runtime provenance matches the signed bytes. The release workflow uses the same runtime signer before sealing/notarizing the production app; provenance describes the final signed executables, rather than their pre-signing hashes. The smoke alone does not establish notarization, installed-app accessibility or N-to-N+1 updates; separately recorded local notarization evidence is summarised below.


### Current local acceptance and opening status

On 21 October, the owned macOS arm64 Developer ID QA app based on `7b8232d` was accepted by Apple's notarization service, stapled and validated, and accepted by Gatekeeper as a notarized Developer ID app. Its native local Echo follow-up completed, and the actual macOS Save panel exported the retained transcript with validated contents and mode 0600. This closes those scoped macOS checks, not clean-install or all-platform release acceptance. The final owned macOS arm64 QA versions 0.1.1 and 0.1.2, built from reviewed source `75864df` with isolated QA identity/version/fixture configuration, received fresh accepted notarization and valid stapled tickets. The actual native Tauri Install and restart flow replaced 0.1.1 with 0.1.2; post-install deep strict signature verification, ticket validation and Gatekeeper assessment passed.

Three real Muse SDK sessions used a controlled local provider to exercise a pending question, pending permission and an active model call. Confirmation stopped the old service before replacement; the restarted service had a new process ID and retained all six session IDs, completed baseline progress and an unsent draft. All three pending states became saved stops without stale questions/approvals. The approval-sensitive sentinel file remained absent. Provider request counts stayed at three through restart, proving no automatic replay; an explicit follow-up in the same session completed and raised the count to four. The original user service was preserved. This is native SDK/control-plane acceptance with a local fixture provider, not a paid live-provider trial or production GitHub update.

Native failure checks rejected a tampered signature, an announced 300 MiB artifact and a wrong-platform manifest; cancelling a slow download allowed a subsequent download retry. An initial QA archive extraction failure exposed and led to a fix for repeat pause/stop after an unsuccessful installation; the corrected archive excludes Apple metadata, and browser regression covers retry after leaving and reopening Updates with only one service stop. The release manifest also refuses updater artifacts above the client's 256 MiB budget. Migration failure, incompatible supervisor, real GitHub unavailability/rate limiting and Windows/Linux replacement remain open.

The production updater secrets/public variable and Apple signing/notarization names are configured; no key/password value is recorded here. GitHub source is now public and Actions enabled under explicit owner approval. [The default-branch protection policy](../.github/master-protection.json) is applied: it targets zero required approving reviews, resolved conversations, linear history, no force pushes/deletions and strict native checks on macOS/Windows/Linux. The emitted macOS/Windows/Linux check names were verified before application. The first hosted matrix is still in progress; no passing hosted result is claimed yet.

The [approved branch-history cleanup](public-history-cleanup.md) is applied and verified. The owner explicitly accepted the identified retained original PR-history residual before approving public source opening. Windows/Linux signed updater installation, the remaining production/failure matrix, native accessibility/resource/platform checks and privacy/security gates remain open; local QA artifacts are not public releases.

Version 0.1.1 metadata and curated notes are prepared for review only. No tag, installer, release or website is published by this preparation. The release date and notes must be reconciled with the final accepted artifact set before a separately approved tag/publication.

### Universal macOS distribution

The app declares macOS 13.5 or later, matching the actual minimum OS load commands in both pinned Node executables. The public macOS download is one universal app and disk image for Apple Silicon and Intel. Tauri builds both desktop slices; the packaged supervisor and pinned Node runtime are also merged with lipo before Developer ID signing. Both official Node archives are checked against the pinned distribution checksums. Release verification requires arm64 and x86_64 slices in all three executables inside both the updater archive and mounted disk image. The updater manifest maps both macOS platform keys to the same signed universal archive. Windows and Linux retain their native packages.

### Recover a completed build

If only publication fails, run Recover verified release publication from master with the original version tag and Release run ID. Recovery requires the tag to remain on master, every original build and native validation gate to have passed, and the exact unexpired artifact inventory with matching source revision and archive digests. It downloads and verifies the existing packages without rebuilding, checks the curated notes against the tag, and uses the same immutable publisher and serialized updater reconciliation. Manifest timestamps use the source commit time so retries reproduce the same metadata bytes. Unknown or changed release assets remain errors.

The publisher accepts authenticated GitHub installation tokens, including the workflow GITHUB_TOKEN. GitHub enforces the required Contents write permission on each mutation; HTTP 401/403 errors stop without blind retries. See [GitHub token permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

### Verified first binary release

[Lascoria v0.1.2](https://github.com/kabudu/lascoria/releases/tag/v0.1.2) is public from annotated source commit `9ccc01e`. All 13 uploaded assets were independently downloaded and checked against their published checksums; all four updater signatures verify with the production key. Both macOS containers contain Apple Silicon and Intel slices in the desktop, supervisor and Node, declare macOS 13.5, and pass Developer ID, stapled ticket and Gatekeeper checks. Canonical release rendering, stable/beta manifests and the deployed website were verified on 22 October.

Publication confirmation uses the successful response bound to the existing release ID. A lost reply is reconciled by ID; canonical tag lookup is checked alongside the draft inventory. A cached empty listing never authorizes repeating an uncertain draft-create request. An unexpected duplicate remains a manual reconciliation condition; no assets are deleted or overwritten.
