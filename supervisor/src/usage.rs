//! Account-scoped subscription usage observations (R8).
//!
//! Muse reports one set of subscription windows per account, observed by whichever host last
//! heard from the provider. Every session host can report the same windows, so this keeps the
//! freshest valid observation for the current account instead of adding or mixing them. It is
//! fed by explicit `usage` reads and by `usage/changed` notifications from session hosts, and it
//! is cleared whenever the account route changes, so another account's numbers never show.
//! Nothing here asks Muse for usage; reading the cache never sends a model request.

use serde_json::{Value, json};
use std::sync::Mutex;

struct Cache {
    latest: Option<Value>,
    /// Observations made before the last account change belong to the previous account.
    cleared_at_ms: u64,
    /// When the cached observation was last received from a host or read.
    received_at_ms: u64,
}

static CACHE: Mutex<Cache> = Mutex::new(Cache {
    latest: None,
    cleared_at_ms: 0,
    received_at_ms: 0,
});

fn int(value: &Value, key: &str) -> Option<u64> {
    value.get(key)?.as_u64()
}

/// The documented `SubscriptionUsage` shape, rebuilt from its known fields only, so unknown
/// or oversized provider data never reaches the UI through this path.
pub fn validated(usage: &Value) -> Option<Value> {
    let observed = int(usage, "observedAtMs")?;
    let tier = usage.get("tier")?.as_str()?;
    if tier.len() > 128 {
        return None;
    }
    let window = usage.get("window")?;
    let weekly = usage.get("weekly")?;
    let duration = int(window, "windowDurationMins").filter(|minutes| *minutes > 0)?;
    Some(json!({
        "observedAtMs": observed,
        "tier": tier,
        "window": {
            "usedPercent": int(window, "usedPercent")?,
            "resetsAtMs": int(window, "resetsAtMs")?,
            "windowDurationMins": duration,
        },
        "weekly": {
            "usedPercent": int(weekly, "usedPercent")?,
            "resetsAtMs": int(weekly, "resetsAtMs")?,
        },
    }))
}

/// Keeps `usage` if it is valid, belongs to the current account and is at least as fresh as
/// the cached observation. Returns whether it was kept.
pub fn record(usage: &Value, now_ms: u64) -> bool {
    let Some(usage) = validated(usage) else {
        return false;
    };
    let observed = usage["observedAtMs"].as_u64().unwrap_or(0);
    let mut cache = CACHE.lock().unwrap();
    if observed < cache.cleared_at_ms {
        return false;
    }
    let cached = cache
        .latest
        .as_ref()
        .and_then(|value| value["observedAtMs"].as_u64());
    if cached.is_some_and(|cached| cached > observed) {
        return false;
    }
    cache.latest = Some(usage);
    cache.received_at_ms = now_ms;
    true
}

/// The freshest observation for the current account, with when Lascoria received it.
pub fn latest() -> Value {
    let cache = CACHE.lock().unwrap();
    match &cache.latest {
        Some(usage) => json!({"usage":usage,"receivedAtMs":cache.received_at_ms}),
        None => json!({"usage":Value::Null}),
    }
}

/// Forgets the previous account's observation; called on every account route change.
pub fn clear(now_ms: u64) {
    let mut cache = CACHE.lock().unwrap();
    cache.latest = None;
    cache.received_at_ms = 0;
    cache.cleared_at_ms = now_ms;
}

#[cfg(test)]
pub(crate) static TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(observed: u64, window: u64, weekly: u64) -> Value {
        json!({
            "observedAtMs": observed,
            "tier": "tier_opaque_7",
            "window": {"usedPercent": window, "resetsAtMs": observed + 3_600_000, "windowDurationMins": 300},
            "weekly": {"usedPercent": weekly, "resetsAtMs": observed + 86_400_000},
            "extra": "not passed on"
        })
    }

    #[test]
    fn keeps_the_freshest_observation_without_adding_hosts_together() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear(0);
        assert!(record(&sample(2_000, 40, 10), 5_000));
        // Another host reporting the same or older windows does not add to or replace it.
        assert!(!record(&sample(1_000, 90, 90), 5_100));
        assert_eq!(latest()["usage"]["window"]["usedPercent"], 40);
        assert!(record(&sample(2_000, 40, 10), 5_200));
        assert!(record(&sample(3_000, 125, 20), 5_300));
        let latest = latest();
        // Over-quota readings are kept verbatim; the UI clamps only the remaining share.
        assert_eq!(latest["usage"]["window"]["usedPercent"], 125);
        assert_eq!(latest["receivedAtMs"], 5_300);
        assert!(latest["usage"].get("extra").is_none());
    }

    #[test]
    fn an_account_change_forgets_usage_and_refuses_older_reports() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear(0);
        assert!(record(&sample(2_000, 40, 10), 2_100));
        clear(10_000);
        assert_eq!(latest()["usage"], Value::Null);
        // A late notification from the previous account's host is ignored.
        assert!(!record(&sample(9_000, 70, 70), 10_100));
        assert_eq!(latest()["usage"], Value::Null);
        assert!(record(&sample(10_500, 5, 1), 10_600));
    }

    #[test]
    fn malformed_or_unknown_shapes_are_rejected() {
        let _guard = TEST_LOCK.lock().unwrap();
        clear(0);
        for bad in [
            json!(null),
            json!({"observedAtMs": 1}),
            json!({"observedAtMs": 1, "tier": "t", "window": {"usedPercent": -1, "resetsAtMs": 2, "windowDurationMins": 300}, "weekly": {"usedPercent": 1, "resetsAtMs": 2}}),
            json!({"observedAtMs": 1, "tier": "t", "window": {"usedPercent": 1, "resetsAtMs": 2, "windowDurationMins": 0}, "weekly": {"usedPercent": 1, "resetsAtMs": 2}}),
            json!({"observedAtMs": 1, "tier": "x".repeat(200), "window": {"usedPercent": 1, "resetsAtMs": 2, "windowDurationMins": 3}, "weekly": {"usedPercent": 1, "resetsAtMs": 2}}),
        ] {
            assert!(!record(&bad, 1), "{bad}");
        }
        assert_eq!(latest()["usage"], Value::Null);
    }
}
