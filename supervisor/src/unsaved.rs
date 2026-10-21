//! R7: session updates that could not be saved, for example while the disk holding Lascoria's
//! data is full. Keep hosts running and retry the newest snapshot and command acknowledgements
//! when storage returns. This buffer is volatile: Muse's own log is not a replacement for the
//! supervisor journal if this process stops before flushing. Bounded per host: one snapshot,
//! `MAX_FACTS` unique receipts, fixed receipt fields and bounded command identities.
use crate::db::Db;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Mutex};

const MAX_FACTS: usize = 2000;
const MAX_COMMAND_ID_BYTES: usize = 256;

#[derive(Default)]
struct Pending {
    state: Option<Value>,
    facts: HashMap<String, Value>,
    interruption: Option<Value>,
}

#[derive(Default)]
struct Store {
    pending: HashMap<(String, u64), Pending>,
    error: Option<(String, u128)>,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Store) -> T) -> T {
    f(STORE.lock().unwrap().get_or_insert_with(Store::default))
}

fn note(error: &anyhow::Error) {
    with(|s| {
        if s.error.is_none() {
            s.error = Some((user_message(error), crate::db::now_ms()));
        }
    });
}

/// Save a host's state snapshot, or keep it for a later attempt if the database refuses it.
/// Rejects malformed or over-budget receipts. The caller stops the affected worker/broker.
/// Callers serialize updates and flushes under the database lock.
pub fn state(
    db: &Db,
    session: &str,
    generation: u64,
    state: Value,
    event: &Value,
    facts: &Value,
) -> Result<()> {
    let key = (session.to_owned(), generation);
    with(|s| -> Result<()> {
        let entry = s.pending.entry(key).or_default();
        let mut incoming = HashMap::new();
        for fact in std::iter::once(event).chain(facts.as_array().into_iter().flatten()) {
            // Db::state only needs these command acknowledgements. Never retain unrelated
            // notifications or arbitrary payloads across a storage outage.
            let Some(
                method @ ("turn/started" | "turn/completed" | "turn/unqueued" | "approval/resolved"
                | "userInput/settled"),
            ) = fact["method"].as_str()
            else {
                continue;
            };
            let Some(id) = fact["commandId"].as_str() else {
                continue;
            };
            if id.len() > MAX_COMMAND_ID_BYTES {
                bail!("Unsaved command identity exceeds its storage budget");
            }
            if entry.facts.contains_key(id) || incoming.contains_key(id) {
                continue;
            }
            if entry.facts.len() + incoming.len() == MAX_FACTS {
                bail!(
                    "Too many unsaved session updates while Lascoria's data folder is unavailable"
                );
            }
            incoming.insert(id.to_owned(), json!({"method":method,"commandId":id}));
        }
        // Check the complete incoming batch before changing the retained snapshot/facts.
        entry.facts.extend(incoming);
        entry.state = Some(state);
        Ok(())
    })?;
    flush(db);
    Ok(())
}

/// Record a host's interruption, or keep it for a later attempt.
pub fn interruption(db: &Db, session: &str, generation: u64, reason: Value) {
    with(|s| {
        s.pending
            .entry((session.to_owned(), generation))
            .or_default()
            .interruption = Some(reason);
    });
    flush(db);
}

/// Write everything waiting. Called after each new update and periodically.
pub fn flush(db: &Db) {
    let keys: Vec<(String, u64)> = with(|s| s.pending.keys().cloned().collect());
    for key in keys {
        let Some(entry) = with(|s| s.pending.remove(&key)) else {
            continue;
        };
        let result = (|| -> Result<()> {
            if let Some(state) = &entry.state {
                db.state(
                    &key.0,
                    key.1,
                    state.clone(),
                    &Value::Null,
                    &json!(entry.facts.values().collect::<Vec<_>>()),
                )?;
            }
            if let Some(reason) = &entry.interruption {
                db.interrupt(&key.0, key.1, reason.clone())?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            note(&error);
            // Put it back unless a newer update arrived meanwhile; then merge into that one.
            with(|s| {
                let slot = s.pending.entry(key).or_default();
                if slot.state.is_none() {
                    slot.state = entry.state;
                }
                for (id, fact) in entry.facts {
                    slot.facts.entry(id).or_insert(fact);
                }
                if slot.interruption.is_none() {
                    slot.interruption = entry.interruption;
                }
            });
            return;
        }
    }
    with(|s| s.error = None);
}

/// For status: what is waiting to be saved and why, or nothing.
pub fn report() -> Option<Value> {
    with(|s| {
        if s.pending.is_empty() {
            return None;
        }
        let (message, since) = s.error.clone().unwrap_or_default();
        Some(json!({"unsaved":s.pending.len(),"message":message,"sinceMillis":since}))
    })
}

/// A plain explanation for storage failures, which SQLite and the OS word technically.
pub fn user_message(error: &anyhow::Error) -> String {
    let text = format!("{error:#}");
    let full = error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::StorageFull)
    }) || ["database or disk is full", "No space left on device"]
        .iter()
        .any(|needle| text.contains(needle));
    if full {
        "Lascoria could not save to its data folder because the disk is full. Free some space, then check the session before trying again.".to_owned()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn refused_updates_wait_and_land_with_every_applied_command() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        let session = uuid::Uuid::new_v4().to_string();
        db.put(
            "sessions",
            &session,
            &json!({"id":session,"generation":1,"lifecycle":"connected","interruptions":[],"state":{"current":true,"turns":[]}}),
        )?;
        for id in ["first", "second"] {
            db.put(
                "commands",
                id,
                &json!({"id":id,"sessionId":session,"commandId":format!("c-{id}"),"status":"accepted"}),
            )?;
        }
        // The database refuses writes, as with a full disk.
        db.0.execute_batch("PRAGMA query_only=1")?;
        let done = |id: &str| json!([{"method":"turn/completed","commandId":format!("c-{id}")}]);
        state(
            &db,
            &session,
            1,
            json!({"current":true,"turns":["one"]}),
            &Value::Null,
            &done("first"),
        )?;
        state(
            &db,
            &session,
            1,
            json!({"current":true,"turns":["one","two"]}),
            &Value::Null,
            &done("second"),
        )?;
        // Duplicate native receipts must not consume the outage budget or retain payloads.
        let duplicate =
            json!({"method":"turn/completed","commandId":"c-first","detail":"x".repeat(8192)});
        state(
            &db,
            &session,
            1,
            json!({"current":true,"turns":["one","two"]}),
            &Value::Null,
            &json!(vec![duplicate; MAX_FACTS + 1]),
        )?;
        // An over-budget batch is refused atomically, retaining the last accepted snapshot.
        let oversized: Vec<Value> = (0..MAX_FACTS)
            .map(|i| {
                json!({
                    "method":"turn/completed","commandId":format!("new-{i}")
                })
            })
            .collect();
        assert!(
            state(
                &db,
                &session,
                1,
                json!({"turns":["rejected"]}),
                &Value::Null,
                &json!(oversized)
            )
            .is_err()
        );
        with(|s| {
            let pending = &s.pending[&(session.clone(), 1)];
            assert_eq!(pending.facts.len(), 2);
            assert!(
                pending
                    .facts
                    .values()
                    .all(|fact| fact.as_object().unwrap().len() == 2)
            );
        });
        let waiting = report().expect("updates wait");
        assert!(waiting["message"].as_str().unwrap().len() > 10);
        assert_eq!(
            db.get("sessions", &session)?.unwrap()["state"]["turns"],
            json!([])
        );
        // Space is back: the newest state lands and both commands are applied.
        db.0.execute_batch("PRAGMA query_only=0")?;
        flush(&db);
        assert_eq!(
            db.get("sessions", &session)?.unwrap()["state"]["turns"],
            json!(["one", "two"])
        );
        for id in ["first", "second"] {
            assert_eq!(
                db.get("commands", id)?.unwrap()["status"],
                "applied",
                "{id}"
            );
        }
        // An interruption refused the same way is written later too.
        db.0.execute_batch("PRAGMA query_only=1")?;
        interruption(&db, &session, 1, json!({"kind":"hostExited"}));
        db.0.execute_batch("PRAGMA query_only=0")?;
        flush(&db);
        let row = db.get("sessions", &session)?.unwrap();
        assert_eq!(row["lifecycle"], "interrupted");
        assert_eq!(row["interruptions"][0]["kind"], "hostExited");
        Ok(())
    }

    #[test]
    fn storage_failures_are_explained_plainly() {
        let full = anyhow::anyhow!("database or disk is full");
        assert!(user_message(&full).contains("disk is full"));
        let io: anyhow::Error = std::io::Error::from(std::io::ErrorKind::StorageFull).into();
        assert!(user_message(&io).contains("Free some space"));
        let other = anyhow::anyhow!("Unknown session");
        assert_eq!(user_message(&other), "Unknown session");
    }
}
