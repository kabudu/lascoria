# Public-history cleanup

Status: PR #1 was merged privately with its commits preserved, and the owner then approved the prepared history replacement on 21 October 2026. The three changed branch heads were replaced atomically using exact expected-old leases after final local CI passed at `35498ad`. Three earlier branch heads were unchanged; no branch or tag was deleted. A fresh branch-only clone contains 154 commits, passes secret scanning and has the corrected README. Verified restricted backups and the original-to-rewritten mapping remain outside the checkout. The owner explicitly accepted the retained historical identifiers on 21 October; that known residual no longer blocks PL03 in [public-launch.md](public-launch.md). Public opening remains a separate approval.

The initial candidate audit covered 152 commits: 142 changed identity, author/committer attribution and parent topology were preserved, and changed file content was restricted to the three approved documents. The current source tree matched the reviewed pre-cleanup tree exactly before evidence-reference reconciliation. Historical signatures cannot survive rewriting signed commits; future releases must be signed from the final reviewed revision. Current evidence references and the exact scanner exception are reconciled to candidate commit identities; the private mapping retains provenance.

GitHub still serves the original refs/pull/1/head. A fresh mirror therefore includes both cleaned branch history and original PR history. Its secret audit has only the two exact reviewed occurrences of the same prose-only false positive, one in each history, excluded by a private audit allowlist; no credential finding was found. The repository allowlist remains restricted to the cleaned-history occurrence. Private session-link trailers, a session identifier and local environment references remain reachable through the hosted PR history. The owner explicitly accepted these retained historical identifiers on 21 October after reviewing the limitation. The prepared Support request was not sent. This acceptance covers the identified session links, session identifier and local environment references, not unknown credentials or future findings. Branch rewriting and secret scanning alone do not establish universal erasure or complete security clearance.

## Findings and scope

The read-only inventory covered 136 reachable commits, 1,220 unique text blobs (about 35.2 MB), commit messages, the tracked planning document's XML/metadata, and image metadata. The reachable path inventory contained no private runtime directory or log/database/key-shaped artifact path; the text checks found no credential-shaped match. These are scoped inventory results, not complete privacy clearance or proof that no secret ever existed.

| Finding | Treatment to prepare |
| --- | --- |
| Nine historical commits contain private `Claude-Session` links and AI co-author trailers. | Remove those trailers from the affected historical messages. Preserve legitimate human author/committer attribution; do not re-author unrelated work. Keep the exact affected-commit map private. |
| Historical `docs/stage-c-memory.md` contains one real native session identifier. | Replace the identifier with a generic description while retaining the tested behaviour, runtime and result. The current document has already been minimised; older versions still need treatment. |
| Historical `docs/rust-sdk-assessment.md` and `docs/implementation-progress.md` contain absolute owner paths and local remote-desktop aliases. | Replace only the reviewed local references with home-relative, repository-relative or generic references. Current-document cleanup does not remove the historical versions. |
| Synthetic fixture emails, device codes, UUIDs and redaction-test paths matched the inventory patterns. | Retain reviewed fixtures. Do not weaken tests or remove useful synthetic evidence merely because it resembles an identifier. |

The public plan deliberately contains no private session URL, session identifier, owner path, credential value or affected-commit lookup table. The owner's normal public Git attribution is separate from private runtime/capture data. A future finding that is an actual credential requires revocation or rotation first; rewriting history alone is not credential remediation.

## Before any rewrite

- [x] Resolve delivery of PR #1 with the owner. It was merged into private master with its commits preserved after exact-head local CI passed on 21 October. The prepared remote replacement was separately approved and applied. Public opening remains unapproved.
- [x] Obtain separate, explicit approval for the exact history rewrite and remote ref replacements, including any necessary protection changes. Commit/push permission for feature work is not force-push or branch-deletion permission.
- [ ] Freeze writes during cleanup and inventory all local/remote branches, tags, PR refs and collaborators' clones. Record the chosen public ref set and every historical location of the findings.
- [x] Save a verified, access-restricted archive of the original Git refs outside the future public checkout. Do not include ignored runtime credentials or live captures in a repository archive. Keep original-to-rewritten commit/ref mappings and any replacement-input files private; never add those inputs to the future public tree.
- [x] Confirm the approved replacement rules against a fresh private clone and a current supported `git-filter-repo`. Do not operate on the active development checkout or the user's running Lascoria state.

## Local preparation after approval

- [x] Apply narrowly scoped message and file replacements in the disposable clone. Remove the reviewed private-session and AI trailers; sanitise the reviewed historical documentation. Do not remove arbitrary source trees, disable secret rules or discard unrelated history to make a scan pass.
- [x] Review the resulting code/tree changes against the original. Only the approved message/document minimisation should differ; identify unexpected changes before proceeding.
- [x] Re-inventory every intended public ref, including commit messages and document metadata. Run full-history secret scanning plus the broader privacy checks; a secret scanner alone cannot validate session-link or environment minimisation.
- [x] Reconcile changed commit/tag identities and invalidated signatures. Update public evidence references so they do not guide readers to removed identifiers in old cached revisions. Keep any necessary old-to-new evidence mapping private and rerun final-head local CI on the exact proposed public tree.
- [x] Present the exact ref-change plan, validation result, backup location and rollback/recovery procedure for owner approval before replacing remote refs. Do not publish existing QA artifacts as releases from a rewritten revision; build distribution artifacts from the final reviewed source.

## Remote and clone cleanup after approval

- [x] Replace only the approved refs, then verify the remote's advertised branches/tags and a fresh clone. Preserve or reinstate the reviewed branch-protection policy through separately authorised changes.
- [x] Review affected PR refs, cached commit/diff views, releases/artifacts and any forks. The retained original PR ref was verified and its identified privacy residual explicitly accepted by the owner; no Support request was sent. Historical procedure: Ask GitHub Support for eligible cached/PR-reference removal when necessary; record the result rather than assuming a force push removed those copies.
- [ ] Give collaborators a specific clean-clone/rebase procedure. Prevent an old branch, tag, bundle or merge from reintroducing the original objects.
- [x] Record the residual disclosure and explicit owner decision: accept the identified original PR history on 21 October. Historical procedure: Do not silently treat the selected cleanup plan as acceptance of retained private identifiers or automatically create/delete repositories as a workaround.
- [ ] Repeat PL03 against the actual public candidate and obtain the separate PL04 public-opening decision. Repository visibility, hosted Actions activation, protection application and release publication remain separately recorded actions.

GitHub documents that rewriting history changes downstream commit identities, can invalidate signatures and disrupt PRs, and does not erase copies in clones, forks, cached views or PR references. Its support policy also limits removal assistance; a cleanup cannot promise universal erasure. See [GitHub's sensitive-data removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository) before executing this plan.


## Existing clones

Keep private copies of uncommitted changes before changing a clone. A fresh clone is the safest path: use the cleaned default branch, then apply reviewed uncommitted patches without importing old Git refs. Do not merge or push an old branch/tag/bundle into the cleaned repository. The active maintainer checkout was clean and synchronized to the rewritten master and two affected local branch pointers without restarting the user's supervisor. Its old reflog objects remain private recovery data; they are not advertised branch refs. Other collaborators' clones still need confirmation.
