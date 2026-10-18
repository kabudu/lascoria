//! Privacy-safe support report (R7).
//!
//! The report is built from an explicit allowlist of counts, states and short identifiers.
//! It never copies text from sessions: no task or transcript text, file paths, folder or
//! session names, account identity, keys, tokens, error messages or provider output. Session
//! IDs are replaced by "session 1", "session 2" and so on. The user sees the exact text before
//! saving; saving writes that previewed text and nothing else.

use crate::data;
use crate::db::{self, Db};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

/// The last preview, so a save writes exactly what the user saw. Previews expire.
static PREVIEW: Mutex<Option<(String, u128, String)>> = Mutex::new(None);
const PREVIEW_TTL_MS: u128 = 10 * 60_000;
const REPORT_LIMIT: usize = 256 * 1024;

/// A short machine identifier (operation names, statuses, kinds) or `"other"`. Anything that
/// could carry free text, a path or a secret fails this test.
fn token(value: &Value) -> String {
    match value.as_str() {
        Some(text)
            if !text.is_empty()
                && text.len() <= 48
                && text
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '/' || c == '_') =>
        {
            text.to_owned()
        }
        Some(_) => "other".into(),
        None => "none".into(),
    }
}

fn count(map: &mut BTreeMap<String, u64>, key: String) {
    *map.entry(key).or_default() += 1;
}

fn len(value: &Value) -> usize {
    value.as_array().map_or(0, Vec::len)
}

fn sessions(db: &Db) -> Result<Value> {
    let mut rows = db.all("sessions")?;
    rows.sort_by_key(|row| row["createdAtMillis"].as_u64().unwrap_or(0));
    let mut lifecycles = BTreeMap::new();
    let detail: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(n, row)| {
            count(&mut lifecycles, token(&row["lifecycle"]));
            let state = &row["state"];
            let mut terminals = BTreeMap::new();
            for turn in state["turns"].as_array().into_iter().flatten() {
                count(&mut terminals, token(&turn["terminal"]));
            }
            let mut interruptions = BTreeMap::new();
            for reason in row["interruptions"].as_array().into_iter().flatten() {
                count(&mut interruptions, token(&reason["kind"]));
            }
            json!({
                "session": format!("session {}", n + 1),
                "lifecycle": token(&row["lifecycle"]),
                "generation": row["generation"].as_u64().unwrap_or(0),
                "attempts": row["attempts"].as_u64().unwrap_or(0),
                "current": state["current"] == true,
                "durability": token(&row["durability"]),
                "project": row.get("projectContext").is_some_and(|v| !v.is_null()),
                "managedWorkspace": row.get("managedWorkspace").is_some_and(|v| !v.is_null()),
                "retainedItems": len(&state["items"]),
                "totalItems": state["totalItems"].as_u64().unwrap_or(0),
                "turnOutcomes": terminals,
                "activeTurn": state["activeTurnId"].is_string(),
                "waitingApprovals": len(&state["approvals"]),
                "waitingQuestions": len(&state["userInputs"]),
                "streamGaps": len(&state["gaps"]),
                "projectionUnavailable": state.get("failure").is_some_and(|v| !v.is_null()),
                "interruptionKinds": interruptions,
            })
        })
        .collect();
    Ok(json!({"count": rows.len(), "byLifecycle": lifecycles, "sessions": detail}))
}

fn commands(db: &Db) -> Result<Value> {
    let mut by_operation: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let recent = db.recent_commands(100)?;
    for command in &recent {
        count(
            by_operation
                .entry(token(&command["operation"]))
                .or_default(),
            token(&command["status"]),
        );
    }
    Ok(json!({"window": recent.len(), "byOperation": by_operation}))
}

/// Builds the report. `extra` carries values the caller owns (features, request metrics and
/// the account route), each reduced to counts or identifiers here.
pub fn build(db: &Db, root: &Path, extra: &Value) -> Result<Value> {
    let summary = data::summary(db, root)?;
    let mut metrics = Map::new();
    for (key, value) in extra["metrics"].as_object().into_iter().flatten() {
        if value.is_number() {
            metrics.insert(key.clone(), value.clone());
        }
    }
    let features: Vec<String> = extra["features"]
        .as_array()
        .into_iter()
        .flatten()
        .map(token)
        .collect();
    let account = &extra["account"];
    Ok(json!({
        "report": "Lascoria support report",
        "schema": 1,
        "generatedAtMs": db::now_ms() as u64,
        "lascoria": {"supervisor": env!("CARGO_PKG_VERSION"), "journalSchema": db::SCHEMA_VERSION},
        "platform": {"os": std::env::consts::OS, "arch": std::env::consts::ARCH},
        "features": features,
        "account": {
            "managed": account["managed"] == true,
            "route": token(&account["mode"]),
            "signedIn": account["authenticated"] == true,
            "reconnectRequired": account["reconnectRequired"] == true,
            "keyStorageAvailable": account["keyStorageAvailable"].as_bool(),
        },
        "sessions": sessions(db)?,
        "recentCommands": commands(db)?,
        "data": {
            "sessions": summary["sessions"],
            "archivedSessions": summary["archivedSessions"],
            "journalEntries": summary["journalEntries"],
            "journalRows": summary["journalRows"],
            "databaseBytes": summary["databaseBytes"],
            "backups": len(&summary["backups"]),
            "restorePending": !summary["pendingRestore"].is_null(),
        },
        "requests": metrics,
        "notIncluded": "Task and transcript text, file and folder paths, session and project names, account identity, API keys and tokens, error messages, model and tool output, and attachments. Lascoria keeps no log files; worker error output stays in memory only.",
    }))
}

/// Builds the report and remembers its exact text for `save`.
pub fn preview(db: &Db, root: &Path, extra: &Value, id: &str) -> Result<Value> {
    let report = build(db, root, extra)?;
    let text = serde_json::to_string_pretty(&report)? + "\n";
    ensure!(
        text.len() <= REPORT_LIMIT,
        "Support report is unexpectedly large"
    );
    *PREVIEW.lock().unwrap() = Some((id.to_owned(), db::now_ms(), text.clone()));
    Ok(json!({"reportId": id, "text": text}))
}

/// Writes the previewed text, unchanged, to a file the user chose (private, atomic).
pub fn save(root: &Path, params: &Value) -> Result<Value> {
    let id = params["reportId"]
        .as_str()
        .context("Preview the report first")?;
    let path = params["path"].as_str().context("Destination required")?;
    ensure!(
        Path::new(path)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json")),
        "Save the support report as a .json file"
    );
    let text = match &*PREVIEW.lock().unwrap() {
        Some((previewed, at, text))
            if previewed == id && db::now_ms().saturating_sub(*at) < PREVIEW_TTL_MS =>
        {
            text.clone()
        }
        _ => anyhow::bail!("This preview has expired; preview the report again"),
    };
    let (parent, destination) = data::destination(root, path)?;
    data::publish(
        &parent,
        &destination,
        |output| Ok(output.write_all(text.as_bytes())?),
        |written| {
            ensure!(
                std::fs::read(written)? == text.as_bytes(),
                "Support report was not written completely"
            );
            Ok(())
        },
    )?;
    Ok(json!({"path": destination, "bytes": text.len()}))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn report_keeps_counts_and_states_but_no_private_text() -> Result<()> {
        let dir =
            Dir(std::env::temp_dir().join(format!("lascoria-support-{}", uuid::Uuid::new_v4())));
        let root = dir.0.join("state");
        std::fs::create_dir_all(&root)?;
        let db = Db::open(&root.join("state.sqlite"))?;
        let secret = "PRIVATE-MARKER-alpha";
        db.put(
            "sessions",
            "c5f1d1a0-secret-session-id",
            &json!({
                "id": "c5f1d1a0-secret-session-id",
                "workspace": format!("/Users/alice/{secret}/repo"),
                "generation": 3,
                "lifecycle": "interrupted",
                "createdAtMillis": 1,
                "initialName": format!("Client {secret}"),
                "interruptions": [
                    {"kind": "projectionUnavailable", "message": format!("failed at /Users/alice/{secret}")},
                    {"kind": format!("weird kind with {secret}")},
                ],
                "state": {
                    "current": false,
                    "items": [{"itemId": "i", "kind": "userMessage", "text": format!("Deploy with {secret}")}],
                    "turns": [{"turnId": "t", "terminal": "completed"}, {"turnId": "u", "terminal": "failed"}],
                    "approvals": [{"summary": secret}],
                    "userInputs": [],
                    "failure": format!("stderr: {secret}"),
                }
            }),
        )?;
        db.put(
            "commands",
            "cmd-1",
            &json!({"id": "cmd-1", "operation": "turn", "status": "applied", "sessionId": "c5f1d1a0-secret-session-id", "createdAtMillis": 2, "params": {"text": secret}}),
        )?;
        let extra = json!({
            "features": ["usage", secret],
            "metrics": {"requests": 7, "requestP95Ms": 1.5, "note": secret},
            "account": {"managed": true, "mode": "subscription", "authenticated": true, "subscription": {"label": secret}},
        });
        let preview = preview(&db, &root, &extra, "report-1")?;
        let text = preview["text"].as_str().unwrap();
        for private in [secret, "alice", "c5f1d1a0", "Deploy", "Client"] {
            assert!(!text.contains(private), "{private} leaked into {text}");
        }
        let report: Value = serde_json::from_str(text)?;
        let session = &report["sessions"]["sessions"][0];
        assert_eq!(session["session"], "session 1");
        assert_eq!(session["generation"], 3);
        assert_eq!(session["turnOutcomes"]["failed"], 1);
        assert_eq!(session["interruptionKinds"]["projectionUnavailable"], 1);
        assert_eq!(session["interruptionKinds"]["other"], 1);
        assert_eq!(session["waitingApprovals"], 1);
        assert_eq!(session["projectionUnavailable"], true);
        assert_eq!(
            report["recentCommands"]["byOperation"]["turn"]["applied"],
            1
        );
        assert_eq!(report["features"], json!(["usage", "other"]));
        assert_eq!(report["requests"]["requests"], 7);
        assert!(report["requests"].get("note").is_none());
        assert_eq!(report["account"]["route"], "subscription");

        // Saving writes exactly the previewed text, privately, outside the state folder only.
        let out = dir.0.join("out");
        std::fs::create_dir_all(&out)?;
        let file = out.join("report.json");
        assert!(save(&root, &json!({"reportId": "other", "path": file})).is_err());
        assert!(
            save(
                &root,
                &json!({"reportId": "report-1", "path": out.join("report.txt")})
            )
            .is_err()
        );
        assert!(
            save(
                &root,
                &json!({"reportId": "report-1", "path": root.join("inside.json")})
            )
            .is_err()
        );
        save(&root, &json!({"reportId": "report-1", "path": file}))?;
        assert_eq!(std::fs::read_to_string(&file)?, text);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&file)?.permissions().mode() & 0o777,
                0o600
            );
        }
        Ok(())
    }
}
