use anyhow::{Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};

pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub struct Db(pub Connection);
impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version <= 1,
            "Unsupported supervisor journal schema {version}"
        );
        db.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        db.execute_batch("PRAGMA user_version=1;")?;
        Ok(Self(db))
    }
    pub fn put(&self, table: &str, id: &str, value: &Value) -> Result<()> {
        if !["sessions", "commands"].contains(&table) {
            bail!("Invalid table");
        }
        self.0.execute(
            &format!("INSERT INTO {table} VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value"),
            params![id, value.to_string()],
        )?;
        Ok(())
    }
    pub fn get(&self, table: &str, id: &str) -> Result<Option<Value>> {
        ensure!(["sessions", "commands"].contains(&table), "Invalid table");
        let raw: Option<String> = self
            .0
            .query_row(
                &format!("SELECT value FROM {table} WHERE id=?1"),
                [id],
                |row| row.get(0),
            )
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
            .transpose()
    }
    pub fn all(&self, table: &str) -> Result<Vec<Value>> {
        if !["sessions", "commands"].contains(&table) {
            bail!("Invalid table");
        }
        let mut statement = self
            .0
            .prepare(&format!("SELECT value FROM {table} ORDER BY rowid"))?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut values = Vec::new();
        for row in rows {
            values.push(serde_json::from_str(&row?)?);
        }
        Ok(values)
    }
    pub fn interrupt(&self, id: &str, generation: u64, mut reason: Value) -> Result<()> {
        let Some(mut row) = self.get("sessions", id)? else {
            return Ok(());
        };
        if row["generation"] != generation {
            return Ok(());
        }
        reason["atMillis"] = json!(now_ms());
        if let Some(failure) = row["state"].get("failure") {
            reason["projectionFailure"] = failure.clone();
        }
        if let Some(gaps) = row["state"]
            .get("gaps")
            .filter(|gaps| gaps.as_array().is_some_and(|gaps| !gaps.is_empty()))
        {
            reason["gaps"] = gaps.clone();
        }
        row["lifecycle"] = json!("interrupted");
        row["state"]["current"] = json!(false);
        let history = row["interruptions"].as_array_mut().unwrap();
        history.push(reason);
        if history.len() > 20 {
            history.remove(0);
        }
        self.put("sessions", id, &row)?;
        for mut command in self.all("commands")? {
            if command["sessionId"] == id
                && matches!(command["status"].as_str(), Some("sending" | "accepted"))
            {
                command["status"] = json!("outcomeUnknown");
                self.put("commands", command["id"].as_str().unwrap(), &command)?;
            }
        }
        Ok(())
    }
    pub fn state(
        &self,
        id: &str,
        generation: u64,
        state: Value,
        event: &Value,
        facts: &Value,
    ) -> Result<()> {
        let Some(mut row) = self.get("sessions", id)? else {
            return Ok(());
        };
        if row["generation"] != generation {
            return Ok(());
        }
        row["state"] = state;
        self.put("sessions", id, &row)?;
        let commands_applied: HashSet<&str> = std::iter::once(event)
            .chain(facts.as_array().into_iter().flatten())
            .filter(|fact| {
                matches!(
                    fact["method"].as_str(),
                    Some(
                        "turn/started"
                            | "turn/completed"
                            | "turn/unqueued"
                            | "approval/resolved"
                            | "userInput/settled"
                    )
                )
            })
            .filter_map(|fact| fact["commandId"].as_str())
            .collect();
        if !commands_applied.is_empty() {
            for mut command in self.all("commands")? {
                if command["sessionId"] == id
                    && command["commandId"]
                        .as_str()
                        .is_some_and(|id| commands_applied.contains(id))
                {
                    command["status"] = json!("applied");
                    self.put("commands", command["id"].as_str().unwrap(), &command)?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updating_sessions_preserves_registry_order() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        db.put("sessions", "first", &json!({"id":"first","state":0}))?;
        db.put("sessions", "second", &json!({"id":"second","state":0}))?;
        db.put("sessions", "first", &json!({"id":"first","state":1}))?;
        assert_eq!(
            db.all("sessions")?
                .iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        Ok(())
    }

    #[test]
    fn obsolete_worker_cannot_replace_new_state_or_discharge_its_commands() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        db.put("sessions", "s", &json!({"id":"s","generation":2,"interruptions":[],"state":{"current":true},"lifecycle":"connected"}))?;
        db.put(
            "commands",
            "c",
            &json!({"id":"c","sessionId":"s","commandId":"wire","status":"accepted"}),
        )?;
        db.interrupt("s", 1, json!({"kind":"obsoleteEof"}))?;
        assert_eq!(db.get("sessions", "s")?.unwrap()["lifecycle"], "connected");
        assert_eq!(db.get("commands", "c")?.unwrap()["status"], "accepted");
        db.interrupt("s", 2, json!({"kind":"currentEof"}))?;
        assert_eq!(db.get("sessions", "s")?.unwrap()["state"]["current"], false);
        assert_eq!(
            db.get("commands", "c")?.unwrap()["status"],
            "outcomeUnknown"
        );
        // Only a matching runtime fact for this session reconciles the unknown command.
        db.state(
            "s",
            2,
            json!({"current":true}),
            &Value::Null,
            &json!([{"method":"turn/started","commandId":"wire"}]),
        )?;
        assert_eq!(db.get("commands", "c")?.unwrap()["status"], "applied");
        Ok(())
    }
}
