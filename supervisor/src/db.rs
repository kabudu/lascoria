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

/// Highest journal schema this supervisor reads. Newer databases and backups are refused, never downgraded.
pub const SCHEMA_VERSION: u32 = 4;
/// Full command records retained for review. Older terminal records can be compacted to tombstones.
pub const JOURNAL_LIMIT: usize = 2000;
/// Tombstones keep request identity forever; this hard bound keeps the journal finite.
pub const JOURNAL_ROW_LIMIT: usize = 20_000;

/// Exact retry identity. A compacted record keeps the request ID but never its payload,
/// so a retry is refused rather than replayed.
pub fn same_request(previous: &Value, operation: &str, params: &Value) -> Result<()> {
    ensure!(
        previous["compacted"] != true,
        "This request belongs to compacted history; refresh status instead of retrying"
    );
    ensure!(
        previous["operation"] == operation && previous["params"] == *params,
        "Request ID reused with different payload"
    );
    Ok(())
}

pub struct Db(pub Connection, String);
impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let db = Connection::open(path)?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        ensure!(
            version <= SCHEMA_VERSION,
            "This Lascoria data was written by a newer version (schema {version}); install that version or restore an older backup"
        );
        db.execute_batch(
            "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS presentation(id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        db.execute_batch("PRAGMA user_version=4;")?;
        Ok(Self(db, uuid::Uuid::new_v4().to_string()))
    }
    /// Inspect only auth-failure IDs and command timestamps, never materialize retained transcripts.
    pub fn auth_failed_since(&self, epoch: u64) -> Result<bool> {
        let mut failed_query = self.0.prepare("SELECT json_extract(t.value, '$.commandId') FROM sessions s, json_each(s.value, '$.state.turns') t WHERE json_extract(t.value, '$.error.kind') = 'authRequired'")?;
        let failed: std::collections::HashSet<String> = failed_query
            .query_map([], |row| row.get::<_, Option<String>>(0))?
            .filter_map(|row| row.transpose())
            .collect::<rusqlite::Result<_>>()?;
        if failed.is_empty() {
            return Ok(false);
        }
        let mut commands = self.0.prepare("SELECT json_extract(value, '$.commandId') FROM commands WHERE json_extract(value, '$.createdAtMillis') >= ?1")?;
        for id in commands.query_map([i64::try_from(epoch)?], |row| {
            row.get::<_, Option<String>>(0)
        })? {
            if id?.is_some_and(|id| failed.contains(&id)) {
                return Ok(true);
            }
        }
        Ok(false)
    }
    /// One admission rule for every journal writer, with an action the user can take.
    pub fn journal_admits(&self) -> Result<()> {
        let (rows, full): (i64, i64) = self.0.query_row(
            "SELECT count(*), count(*) FILTER (WHERE json_extract(value,'$.compacted') IS NULL) FROM commands",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        ensure!(
            (full as usize) < JOURNAL_LIMIT && (rows as usize) < JOURNAL_ROW_LIMIT,
            "Command history is full ({JOURNAL_LIMIT} entries). Open Data & backups to back up and compact older history"
        );
        Ok(())
    }
    pub fn version(&self) -> String {
        format!("{}:{}", self.1, self.0.total_changes())
    }
    pub fn put(&self, table: &str, id: &str, value: &Value) -> Result<()> {
        if ![
            "sessions",
            "commands",
            "presentation",
            "artifacts",
            "evidence",
            "decisions",
        ]
        .contains(&table)
        {
            bail!("Invalid table");
        }
        self.0.execute(
            &format!("INSERT INTO {table} VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value"),
            params![id, value.to_string()],
        )?;
        Ok(())
    }
    pub fn get(&self, table: &str, id: &str) -> Result<Option<Value>> {
        ensure!(
            [
                "sessions",
                "commands",
                "presentation",
                "artifacts",
                "evidence",
                "decisions"
            ]
            .contains(&table),
            "Invalid table"
        );
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
        if ![
            "sessions",
            "commands",
            "presentation",
            "artifacts",
            "evidence",
            "decisions",
        ]
        .contains(&table)
        {
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
    pub fn count(&self, table: &str) -> Result<usize> {
        ensure!(
            [
                "sessions",
                "commands",
                "presentation",
                "artifacts",
                "evidence",
                "decisions"
            ]
            .contains(&table),
            "Invalid table"
        );
        Ok(self
            .0
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get::<_, i64>(0)
            })? as usize)
    }
    /// The newest command records, newest first. Status runs about once a second and the
    /// journal can hold up to `JOURNAL_ROW_LIMIT` rows, so only these rows are read and parsed.
    pub fn recent_commands(&self, limit: usize) -> Result<Vec<Value>> {
        let mut statement = self
            .0
            .prepare("SELECT value FROM commands ORDER BY rowid DESC LIMIT ?1")?;
        let rows = statement.query_map([limit as i64], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    /// Command records selected by SQLite, so callers on hot paths (every state update, every
    /// worker interruption) never parse the whole journal, which can hold 20,000 rows.
    pub fn commands_matching(
        &self,
        predicate: &str,
        params: &[&dyn rusqlite::ToSql],
    ) -> Result<Vec<Value>> {
        let mut statement = self.0.prepare(&format!(
            "SELECT value FROM commands WHERE {predicate} ORDER BY rowid"
        ))?;
        let rows = statement.query_map(params, |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }
    /// Whether a developer test command is still running for this session.
    pub fn test_running(&self, session: &str) -> Result<bool> {
        Ok(self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM commands WHERE json_extract(value,'$.sessionId')=?1
               AND json_extract(value,'$.operation')='workspace/run'
               AND json_extract(value,'$.status')='running')",
            [session],
            |row| row.get(0),
        )?)
    }
    pub fn artifact_metadata(&self, session: &str) -> Result<Vec<Value>> {
        let mut statement=self.0.prepare("SELECT json_remove(value,'$.patch','$.untracked') FROM artifacts WHERE json_extract(value,'$.sessionId')=?1 ORDER BY rowid")?;
        let mut values = Vec::new();
        for row in statement.query_map([session], |row| row.get::<_, String>(0))? {
            values.push(serde_json::from_str(&row?)?);
        }
        Ok(values)
    }
    pub fn evidence_page(
        &self,
        session: &str,
        artifact: Option<&str>,
        offset: usize,
    ) -> Result<Vec<Value>> {
        let mut statement=self.0.prepare("SELECT value FROM evidence WHERE json_extract(value,'$.sessionId')=?1 AND (?2 IS NULL OR json_extract(value,'$.artifactId')=?2) ORDER BY rowid DESC LIMIT 101 OFFSET ?3")?;
        let mut values = Vec::new();
        for row in statement.query_map(params![session, artifact, offset as i64], |row| {
            row.get::<_, String>(0)
        })? {
            values.push(serde_json::from_str(&row?)?);
        }
        Ok(values)
    }
    pub fn interrupt(&self, id: &str, generation: u64, mut reason: Value) -> Result<()> {
        let Some(mut row) = self.get("sessions", id)? else {
            return Ok(());
        };
        if row["generation"] != generation || row["lifecycle"] == "archived" {
            return Ok(());
        }
        reason["atMillis"] = json!(now_ms());
        if let Some(shutdown) = row["state"].get("shutdown") {
            reason["shutdown"] = shutdown.clone();
        }
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
        for mut command in self.commands_matching(
            "json_extract(value,'$.sessionId')=?1 AND json_extract(value,'$.status') IN ('sending','accepted')",
            &[&id],
        )? {
            command["status"] = json!("outcomeUnknown");
            self.put("commands", command["id"].as_str().unwrap(), &command)?;
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
        if row["generation"] != generation || row["lifecycle"] == "archived" {
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
            let applied = json!(commands_applied).to_string();
            for mut command in self.commands_matching(
                "json_extract(value,'$.sessionId')=?1 AND json_extract(value,'$.commandId') IN (SELECT value FROM json_each(?2))",
                &[&id, &applied.as_str()],
            )? {
                command["status"] = json!("applied");
                self.put("commands", command["id"].as_str().unwrap(), &command)?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_three_upgrade_preserves_sessions_and_adds_decision_identities() -> Result<()> {
        let path =
            std::env::temp_dir().join(format!("lascoria-schema4-{}.sqlite", uuid::Uuid::new_v4()));
        {
            let db = Db::open(&path)?;
            db.put(
                "sessions",
                "old-session",
                &json!({"id":"old-session","label":"retained fixture"}),
            )?;
            db.0.execute_batch("DROP TABLE decisions; PRAGMA user_version=3;")?;
        }
        {
            let db = Db::open(&path)?;
            assert_eq!(
                db.0.query_row("PRAGMA user_version", [], |row| row.get::<_, u32>(0))?,
                SCHEMA_VERSION
            );
            assert_eq!(
                db.get("sessions", "old-session")?.unwrap()["label"],
                "retained fixture"
            );
            db.put(
                "decisions",
                "paid-once",
                &json!({"id":"paid-once","status":"unknown"}),
            )?;
        }
        {
            let db = Db::open(&path)?;
            assert_eq!(
                db.get("decisions", "paid-once")?.unwrap()["status"],
                "unknown"
            );
        }
        std::fs::remove_file(path)?;
        Ok(())
    }

    #[test]
    fn status_reads_only_the_newest_commands_in_journal_order() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        for n in 0..JOURNAL_ROW_LIMIT {
            let record = if n % 10 == 0 {
                json!({"id":format!("c{n}"),"operation":"turn","status":"applied","sessionId":"s"})
            } else {
                json!({"id":format!("c{n}"),"operation":"turn","compacted":true})
            };
            db.put("commands", &format!("c{n}"), &record)?;
        }
        // Updating a record in place (compaction, outcome) keeps its position.
        db.put(
            "commands",
            "c19990",
            &json!({"id":"c19990","compacted":true}),
        )?;
        let expected: Vec<Value> = db.all("commands")?.into_iter().rev().take(100).collect();
        let recent = db.recent_commands(100)?;
        assert_eq!(recent, expected);
        assert_eq!(recent[0]["id"], "c19999");
        assert_eq!(recent[9]["compacted"], true);
        assert!(db.recent_commands(0)?.is_empty());

        assert!(!db.test_running("s")?);
        db.put(
            "commands",
            "run",
            &json!({"id":"run","operation":"workspace/run","status":"running","sessionId":"s"}),
        )?;
        assert!(db.test_running("s")?);
        assert!(!db.test_running("other")?);
        Ok(())
    }

    #[test]
    fn evidence_pages_filter_before_offset_and_omit_capture_bytes() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        db.put(
            "artifacts",
            "a",
            &json!({"id":"a","sessionId":"s","patch":"large","untracked":["large"]}),
        )?;
        db.put(
            "evidence",
            "old",
            &json!({"id":"old","sessionId":"s","artifactId":"a"}),
        )?;
        for index in 0..102 {
            db.put(
                "evidence",
                &format!("other{index}"),
                &json!({"id":index,"sessionId":"s","artifactId":"b"}),
            )?;
        }
        assert_eq!(db.evidence_page("s", None, 0)?.len(), 101);
        assert_eq!(db.evidence_page("s", Some("a"), 0)?[0]["id"], "old");
        assert!(db.evidence_page("s", Some("a"), 100)?.is_empty());
        assert!(db.artifact_metadata("s")?[0].get("patch").is_none());
        Ok(())
    }

    #[test]
    fn archived_session_ignores_late_worker_frames() -> Result<()> {
        let db = Db::open(Path::new(":memory:"))?;
        let archived = json!({"id":"s","generation":1,"lifecycle":"archived","interruptions":[],"state":{"current":false,"items":[{"text":"retained"}]}});
        db.put("sessions", "s", &archived)?;
        db.interrupt("s", 1, json!({"kind":"lateEof"}))?;
        db.state("s", 1, json!({"current":true}), &Value::Null, &json!([]))?;
        assert_eq!(db.get("sessions", "s")?.unwrap(), archived);
        Ok(())
    }

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
        // Neighbours the filtered journal queries must leave alone.
        for (id, record) in [
            (
                "other-session",
                json!({"id":"other-session","sessionId":"t","commandId":"wire","status":"accepted"}),
            ),
            (
                "sending",
                json!({"id":"sending","sessionId":"s","commandId":"w2","status":"sending"}),
            ),
            (
                "settled",
                json!({"id":"settled","sessionId":"s","commandId":"w3","status":"rejected"}),
            ),
        ] {
            db.put("commands", id, &record)?;
        }
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
        let status =
            |id| -> Result<Value> { Ok(db.get("commands", id)?.unwrap()["status"].clone()) };
        assert_eq!(status("other-session")?, "accepted");
        assert_eq!(status("sending")?, "outcomeUnknown");
        assert_eq!(status("settled")?, "rejected");
        Ok(())
    }
}
