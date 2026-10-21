//! Binds a session message helper to the Muse host Lascoria started for that session
//! (security finding F1, "relay helper argv").
//!
//! Without this, any same-user process could run the supervisor binary as
//! `--relay-mcp <session>` and use that session's relay and decision tools. A helper is now
//! accepted for a session only when all of these hold:
//!
//! 1. It presents the session's relay capability: a random secret issued for each host
//!    generation, sent to the worker over its private pipe and handed by Muse to the helper
//!    in its environment. It is never journalled, shown or exported.
//! 2. It descends from this supervisor through a Muse host: its parent's ancestors, within a
//!    few levels, include this process (helper, Muse host, SDK worker, supervisor).
//! 3. Its parent is the same process as the first accepted helper's parent for this
//!    capability. Muse starts the helper when the session starts, before any model turn can
//!    run a tool, so later look-alikes started from another session's host are refused even
//!    if they learn the capability.
//!
//! Development and test supervisors without a named desktop stay token-only, like the rest
//! of the peer policy.
use anyhow::{Result, bail, ensure};
use std::{collections::HashMap, sync::Mutex};

/// Muse host to supervisor: the host's parent is the SDK worker, whose parent is this
/// supervisor. Two spare levels allow a platform launcher between them.
const MAX_ANCESTRY: usize = 4;

struct Grant {
    generation: u64,
    capability: String,
    host: Option<u32>,
}

static GRANTS: Mutex<Option<HashMap<String, Grant>>> = Mutex::new(None);

/// 244 random bits from the operating system, as for the control token.
fn random_capability() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// A fresh capability for this session's new host generation, replacing any earlier one.
pub fn issue(session: &str, generation: u64) -> String {
    let capability = random_capability();
    GRANTS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(
            session.to_owned(),
            Grant {
                generation,
                capability: capability.clone(),
                host: None,
            },
        );
    capability
}

/// The capability to hand to this session's current host.
pub fn current(session: &str) -> Option<String> {
    GRANTS
        .lock()
        .unwrap()
        .as_ref()?
        .get(session)
        .map(|g| g.capability.clone())
}

/// Forget a stopped generation's capability; a newer generation's is kept.
pub fn revoke(session: &str, generation: u64) {
    if let Some(grants) = GRANTS.lock().unwrap().as_mut()
        && grants
            .get(session)
            .is_some_and(|g| g.generation <= generation)
    {
        grants.remove(session);
    }
}

/// Checks a connecting helper for `session`. `parent` reports a process's parent.
pub fn verify(
    session: &str,
    presented: Option<&str>,
    helper: Option<u32>,
    supervisor: u32,
    parent: impl Fn(u32) -> std::io::Result<u32>,
) -> Result<()> {
    let refused = "This session message helper was not started by Lascoria for that session";
    let (Some(presented), Some(helper)) = (presented, helper) else {
        bail!("{refused}");
    };
    let host = parent(helper).map_err(|_| anyhow::anyhow!("{refused}"))?;
    let mut ancestor = host;
    let mut descends = false;
    for _ in 0..MAX_ANCESTRY {
        match parent(ancestor) {
            Ok(next) if next == supervisor => {
                descends = ancestor != host;
                break;
            }
            Ok(next) if next != ancestor && next != 0 => ancestor = next,
            _ => break,
        }
    }
    ensure!(descends, "{refused}");
    let mut grants = GRANTS.lock().unwrap();
    let Some(grant) = grants.as_mut().and_then(|g| g.get_mut(session)) else {
        bail!("{refused}");
    };
    ensure!(
        crate::peer::same_secret(presented, &grant.capability),
        "{refused}"
    );
    match grant.host {
        None => grant.host = Some(host),
        Some(pinned) => ensure!(pinned == host, "{refused}"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // Process tree: supervisor 1 -> worker 10 -> hosts 100 (session A) and 200 (session B).
    // 101 and 201 are their helpers; 300 is a script outside Lascoria; 102 is a tool that
    // host 100 started directly.
    fn tree() -> impl Fn(u32) -> std::io::Result<u32> {
        let parents: HashMap<u32, u32> = [
            (10, 1),
            (100, 10),
            (200, 10),
            (101, 100),
            (102, 100),
            (201, 200),
            (300, 99),
            (99, 1),
            (1, 0),
        ]
        .into();
        move |pid| {
            parents
                .get(&pid)
                .copied()
                .ok_or_else(|| std::io::Error::other("gone"))
        }
    }

    #[test]
    fn helpers_are_bound_to_their_session_capability_and_host() {
        let (a, b) = (
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        );
        let cap_a = issue(&a, 1);
        let cap_b = issue(&b, 1);
        let check =
            |session: &str, cap: Option<&str>, pid| verify(session, cap, Some(pid), 1, tree());
        // No capability, a wrong one, or another session's.
        assert!(check(&a, None, 101).is_err());
        assert!(check(&a, Some(&"0".repeat(64)), 101).is_err());
        assert!(check(&a, Some(&cap_b), 101).is_err());
        // A process that does not descend from this supervisor through a Muse host: the
        // script's parent 99 is a direct child of the supervisor, so it is no Muse host.
        assert!(check(&a, Some(&cap_a), 300).is_err());
        assert!(check(&a, Some(&cap_a), 10).is_err());
        assert!(verify(&a, Some(&cap_a), None, 1, tree()).is_err());
        // The real helpers pin their hosts.
        check(&a, Some(&cap_a), 101).unwrap();
        check(&b, Some(&cap_b), 201).unwrap();
        // A tool under A's host that learnt B's capability cannot act as B, and a restarted
        // helper under the same host is still accepted.
        assert!(check(&b, Some(&cap_b), 102).is_err());
        check(&a, Some(&cap_a), 102).unwrap();
        check(&a, Some(&cap_a), 101).unwrap();
        // A new generation issues a new capability and forgets the old host pin.
        let next = issue(&a, 2);
        assert!(check(&a, Some(&cap_a), 101).is_err());
        assert_ne!(next, cap_a);
        check(&a, Some(&next), 101).unwrap();
        assert_eq!(current(&a).as_deref(), Some(next.as_str()));
        // Stopping an older generation keeps the newer grant; stopping the current one ends it.
        revoke(&a, 1);
        check(&a, Some(&next), 101).unwrap();
        revoke(&a, 2);
        assert!(current(&a).is_none());
        assert!(check(&a, Some(&next), 101).is_err());
        revoke(&b, 1);
    }

    #[cfg(unix)]
    #[test]
    fn real_parent_lookup_reports_this_process_tree() {
        let me = std::process::id();
        let parent = lascoria_runtime::platform::parent_pid(me).unwrap();
        assert_eq!(parent, unsafe { libc::getppid() } as u32);
    }
}
