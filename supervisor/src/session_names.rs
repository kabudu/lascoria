//! Display identity only. Separate records survive worker snapshots and recovery.
use crate::db::Db;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

pub fn validate(value: Option<&Value>) -> Result<String> {
    let name = match value {
        None => "",
        Some(value) => value.as_str().context("Session name must be text")?,
    }
    .trim();
    ensure!(
        name.chars().count() <= 100 && name.len() <= 400 && !name.chars().any(char::is_control),
        "Use a session name of at most 100 characters without control characters"
    );
    Ok(name.to_owned())
}

pub fn list(db: &Db) -> Result<Vec<Value>> {
    let mut query = db.0.prepare("SELECT s.value,n.value FROM sessions s LEFT JOIN presentation n ON n.id = 'session-name:' || s.id ORDER BY s.rowid")?;
    let mut result = Vec::new();
    for row in query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
    })? {
        let (session, name) = row?;
        let mut session: Value = serde_json::from_str(&session)?;
        if let Some(name) = name {
            let name: Value = serde_json::from_str(&name)?;
            session["displayName"] = name["name"].clone();
            session["nameRevision"] = name["revision"].clone();
        } else if let Some(name) = session.get("initialName").cloned() {
            session["displayName"] = name;
            session["nameRevision"] = json!(0);
        }
        result.push(session);
    }
    Ok(result)
}

pub fn rename(db: &Db, params: &Value, id: &str) -> Result<Value> {
    ensure!(params.is_object(), "Params must be an object");
    ensure!(
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Invalid request ID"
    );
    let session = params["sessionId"].as_str().context("Session required")?;
    let exists: bool = db.0.query_row(
        "SELECT EXISTS(SELECT 1 FROM sessions WHERE id=?1)",
        [session],
        |row| row.get(0),
    )?;
    ensure!(exists, "Unknown session");
    let name = validate(Some(&params["name"]))?;
    let revision = params["expectedRevision"]
        .as_u64()
        .context("Name revision required")?;
    let key = format!("session-name:{session}");
    let prior = db
        .get("presentation", &key)?
        .unwrap_or(json!({"revision":0}));
    if prior["requestId"] == id {
        ensure!(
            prior["name"] == name && prior["expectedRevision"] == revision,
            "Name retry payload changed"
        );
        return Ok(prior);
    }
    ensure!(
        prior["revision"] == revision,
        "Session name changed; compare the latest name before saving"
    );
    let next = json!({"sessionId":session,"name":name,"revision":revision.checked_add(1).context("Name revision exhausted")?,"requestId":id,"expectedRevision":revision});
    db.put("presentation", &key, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names_survive_worker_writes_and_conflicting_or_uncertain_edits() {
        let db = Db::open(std::path::Path::new(":memory:")).unwrap();
        let row = json!({"id":"a","state":{"current":true}});
        db.put("sessions", "a", &row).unwrap();
        assert!(list(&db).unwrap()[0].get("displayName").is_none());
        let params = json!({"sessionId":"a","name":"  Fixture name  ","expectedRevision":0});
        let saved = rename(&db, &params, "first").unwrap();
        let version = db.version();
        assert_eq!(rename(&db, &params, "first").unwrap(), saved);
        assert_eq!(version, db.version());
        assert!(
            rename(
                &db,
                &json!({"sessionId":"a","name":"changed","expectedRevision":0}),
                "first"
            )
            .is_err()
        );
        assert!(rename(&db, &params, "stale").is_err());
        db.put("sessions", "a", &row).unwrap();
        assert_eq!(list(&db).unwrap()[0]["displayName"], "Fixture name");
        rename(
            &db,
            &json!({"sessionId":"a","name":"","expectedRevision":1}),
            "reset",
        )
        .unwrap();
        assert_eq!(list(&db).unwrap()[0]["displayName"], "");
        assert!(
            rename(
                &db,
                &json!({"sessionId":"missing","name":"x","expectedRevision":0}),
                "unknown"
            )
            .is_err()
        );
        assert!(validate(Some(&json!("x".repeat(101)))).is_err());
        assert!(validate(Some(&json!("line\nbreak"))).is_err());
        assert!(validate(Some(&json!(null))).is_err());
        assert_eq!(validate(Some(&json!("Café"))).unwrap(), "Café");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn renamed_identity_survives_database_reopen() {
        let path =
            std::env::temp_dir().join(format!("lascoria-name-{}.sqlite", uuid::Uuid::new_v4()));
        let db = Db::open(&path).unwrap();
        db.put(
            "sessions",
            "retained",
            &json!({"id":"retained","initialName":"Original","workspace":"fixture"}),
        )
        .unwrap();
        rename(
            &db,
            &json!({"sessionId":"retained","name":"Recovered name","expectedRevision":0}),
            "rename",
        )
        .unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        let rows = list(&db).unwrap();
        assert_eq!(rows[0]["id"], "retained");
        assert_eq!(rows[0]["displayName"], "Recovered name");
        assert_eq!(rows[0]["nameRevision"], 1);
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
}
