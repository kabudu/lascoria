# Session permissions

The main header has Model & effort and Permissions controls for the selected session. They remain available when the task inspector is collapsed. The permissions dialog names the session being changed.

## Profiles and approval rules

New Lascoria sessions use Ask me unless you save a different future-session default. Ask me, Auto-review and Read-only are offered only when Muse reports them available. Existing sessions resume with their native profile; a future-session default does not change them. Custom and unrestricted profiles can be reported but cannot be selected here.

Muse owns policy evaluation and operating-system enforcement. Lascoria reads effective state from Muse and never treats a pending selection as applied. Read-only also refuses command/write approvals in Lascoria, even if Muse offers an allow choice. Choose a different profile explicitly before approving those actions.

Advanced approval rules change shell review, not filesystem/network grants. Skipping shell approval requires reported sandbox support and a sandboxed filesystem boundary. Read-only cannot relax these rules. A profile or mode change does not approve a waiting request or revoke existing saved allowances. The current protocol has no rule-deletion operation; manage saved rules through Muse after safely closing the affected host.

Changes require confirmation against a freshly read permission state. Concurrent changes and worker restarts invalidate earlier confirmations. A lost response is reconciled through the durable command receipt rather than automatically replaying the mutation. Session and persistent approval choices require a separate confirmation naming their scope and native rule. Unknown choices are refused.

## Sandbox capability checks

Check what the sandbox allows starts an ordinary Muse task using the current model and permission boundary. It can consume model allowance and ask for approval. It requires an idle session, available sandbox support, a sandboxed filesystem and a non-Read-only profile.

The requested command inspects its own process and briefly binds, listens and connects on an ephemeral loopback port. It does not contact an external service, install dependencies, write workspace files, request escalation or use Workspace Run. Unix checks require Python 3; Windows uses PowerShell and .NET. Missing tools and inconclusive failures remain not checked.

A result is accepted only from a completed native shell item matching the exact requested command, turn, nonce, default sandbox argument and successful, untruncated execution envelope. A bounded native response-yield argument is accepted; it does not relax command or sandbox matching. Model prose alone is not evidence. Results distinguish allowed, denied and not checked. They describe this command and boundary, not every tool, future command or managed policy. Network profile labels alone do not prove bind/listen access.

The current worker displays the last check and marks it historical after a permission change. After restart, its transcript and command receipt remain, but no current check result is invented. There is no automatic unsandboxed fallback or retry.

## Runtime compatibility

This increment pins the official Node SDK to 1.4.14 and Muse to 1.4.14-R7309.1 with the matching schema fingerprint. Development and CI bootstrap is explicit (`node scripts/bootstrap-muse-test.js`) and verifies the vendor manifest, size, SHA-256 and reported build. It never replaces a global Muse installation or restarts an active session. Release upgrades must verify the latest stable CLI/SDK pair together. Newer permission records may not be readable by older Muse versions; do not downgrade a session store to test compatibility.
