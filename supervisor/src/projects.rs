//! Reusable context, separate from worker-owned session state.
use crate::{db::Db, session_names};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::path::PathBuf;

pub fn list(db: &Db) -> Result<Vec<Value>> {
    let mut query =
        db.0.prepare("SELECT json_remove(value, '$.intent', '$.requestId') FROM presentation WHERE id LIKE 'project:%' ORDER BY rowid")?;
    let rows = query.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

fn identity(value: &Value) -> Result<&str> {
    let id = value.as_str().context("Project ID required")?;
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id),
        "Use a canonical project or folder ID"
    );
    Ok(id)
}

/// Optional user-written Project text (goal, folder notes): trimmed, bounded, no control
/// characters except line breaks. Empty means absent.
pub fn note_text(value: Option<&Value>, limit: usize, what: &str) -> Result<Option<String>> {
    let text = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(value) => value
            .as_str()
            .with_context(|| format!("{what} must be text"))?,
    }
    .trim()
    .replace("\r\n", "\n");
    ensure!(
        text.chars().count() <= limit && !text.chars().any(|c| c.is_control() && c != '\n'),
        "Use a {} of at most {limit} characters",
        what.to_lowercase()
    );
    Ok((!text.is_empty()).then_some(text))
}
const GOAL_LIMIT: usize = 1000;
const FOLDER_NOTE_LIMIT: usize = 300;

/// Folder fields kept in a Project snapshot; the note is optional.
fn folder_snapshot(folder: &Value, path: &std::path::Path) -> Result<Value> {
    let mut snapshot = json!({"id":folder["id"],"name":session_names::validate(Some(&folder["name"]))?,"path":path});
    if let Some(note) = note_text(folder.get("note"), FOLDER_NOTE_LIMIT, "Folder note")? {
        snapshot["note"] = json!(note);
    }
    Ok(snapshot)
}

pub fn roots(project: &Value) -> Result<Vec<PathBuf>> {
    let folders = project["folders"]
        .as_array()
        .context("Project folders required")?;
    ensure!(
        !folders.is_empty() && folders.len() <= 8,
        "Choose 1 to 8 project folders"
    );
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for folder in folders {
        ensure!(
            folder.as_object().is_some_and(|f| f
                .keys()
                .all(|k| ["id", "name", "path", "note"].contains(&k.as_str()))),
            "Unknown folder field"
        );
        note_text(folder.get("note"), FOLDER_NOTE_LIMIT, "Folder note")?;
        ensure!(ids.insert(identity(&folder["id"])?), "Duplicate folder ID");
        let alias = session_names::validate(Some(&folder["name"]))?;
        ensure!(!alias.is_empty(), "Name each project folder");
        let raw = folder["path"].as_str().context("Folder path required")?;
        ensure!(
            raw.len() <= 4096 && std::path::Path::new(raw).is_absolute(),
            "Use an absolute folder path"
        );
        let path = dunce::canonicalize(raw)
            .with_context(|| format!("Project folder unavailable: {alias}"))?;
        ensure!(path.is_dir(), "Project folder is not a directory: {alias}");
        ensure!(
            !roots
                .iter()
                .any(|other| path.starts_with(other) || other.starts_with(&path)),
            "Project folders must be distinct and cannot contain one another"
        );
        // Resolve symlinks explicitly before storing the snapshot and before every start.
        roots.push(path);
    }
    Ok(roots)
}

fn commit(db: &Db, params: &Value, request_id: &str, folders: Value) -> Result<Value> {
    ensure!(
        !request_id.is_empty()
            && request_id.len() <= 100
            && request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "Invalid request ID"
    );
    ensure!(
        params.as_object().is_some_and(|p| p.keys().all(|k| [
            "id",
            "name",
            "expectedRevision",
            "folders",
            "goal"
        ]
        .contains(&k.as_str()))),
        "Unknown project field"
    );
    let id = identity(&params["id"])?;
    let revision = params["expectedRevision"]
        .as_u64()
        .context("Project revision required")?;
    let key = format!("project:{id}");
    let prior = db.get("presentation", &key)?;
    if let Some(prior) = &prior
        && prior["requestId"] == request_id
    {
        ensure!(prior["intent"] == *params, "Project retry payload changed");
        return Ok(prior.clone());
    }
    ensure!(
        prior
            .as_ref()
            .map_or(0, |v| v["revision"].as_u64().unwrap_or(0))
            == revision,
        "Project changed; reload before editing again"
    );
    if prior.is_none() {
        let count: i64 = db.0.query_row(
            "SELECT count(*) FROM presentation WHERE id LIKE 'project:%'",
            [],
            |row| row.get(0),
        )?;
        ensure!(count < 100, "Saved project limit reached (100)");
    }
    let name = session_names::validate(Some(&params["name"]))?;
    ensure!(!name.is_empty(), "Project name required");
    let mut project = json!({"id":id,"name":name,"folders":folders,"revision":revision.checked_add(1).context("Project revision exhausted")?,"requestId":request_id,"intent":params});
    if let Some(goal) = note_text(params.get("goal"), GOAL_LIMIT, "Project goal")? {
        project["goal"] = json!(goal);
    }
    db.put("presentation", &key, &project)?;
    Ok(project)
}

pub fn selected(db: &Db, params: &Value) -> Result<Option<Value>> {
    let Some(id) = params.get("projectId") else {
        return Ok(None);
    };
    let id = identity(id)?;
    let project = db
        .get("presentation", &format!("project:{id}"))?
        .context("Project not found")?;
    ensure!(
        project["revision"] == params["projectRevision"],
        "Project changed; review its folders before starting"
    );
    let mut snapshot = project;
    snapshot.as_object_mut().unwrap().remove("intent");
    snapshot.as_object_mut().unwrap().remove("requestId");
    Ok(Some(snapshot))
}

/// Next-task folder replacement for an existing Project session (`turn.projectRevision`).
/// Returns the saved snapshot to apply, or `None` for an ordinary turn. The replacement must
/// come from the session's own Project, be newer than what is applied and keep the default
/// folder, because the default folder is the session's working directory and file scope.
pub fn replacement(db: &Db, row: &Value, params: &Value) -> Result<Option<Value>> {
    let Some(revision) = params.get("projectRevision") else {
        return Ok(None);
    };
    let applied = row
        .get("projectContext")
        .context("Only Project sessions can take Project folder changes")?;
    let wanted = revision.as_u64().context("Invalid Project revision")?;
    ensure!(
        wanted > applied["revision"].as_u64().unwrap_or(0),
        "This Project revision is already applied"
    );
    let snapshot = selected(
        db,
        &json!({"projectId":applied["id"],"projectRevision":wanted}),
    )?
    .context("Project not found")?;
    ensure!(
        snapshot["folders"][0]["path"] == applied["folders"][0]["path"],
        "Changing the default folder needs a new session; keep the default folder first to update this one"
    );
    Ok(Some(snapshot))
}

/// Settle a recorded folder change from its journalled turn: a confirmed receipt makes it the
/// applied context, a refusal drops it, and an uncertain outcome keeps the prior context
/// visible while the change stays offered. Safe to call repeatedly.
pub fn settle_pending(db: &Db, session: &str) -> Result<()> {
    let Some(mut row) = db.get("sessions", session)? else {
        return Ok(());
    };
    let Some(pending) = row.get("projectContextPending").cloned() else {
        return Ok(());
    };
    let request = pending["requestId"].as_str().unwrap_or_default();
    let command = db.get("commands", request)?;
    match command.as_ref().and_then(|c| c["status"].as_str()) {
        Some("applied" | "accepted") => {
            row["projectContext"] = pending["project"].clone();
            row["projectContextReceipt"] = json!({"requestId":request,"status":"applied","commandId":command.unwrap()["commandId"],"appliedWith":"turn"});
            row.as_object_mut().unwrap().remove("projectContextPending");
        }
        // Refused, or never journalled because admission failed before dispatch.
        Some("rejected") | None => {
            row.as_object_mut().unwrap().remove("projectContextPending");
        }
        Some("sending") => return Ok(()),
        Some(_) if pending["status"] == "outcomeUnknown" => return Ok(()),
        Some(_) => row["projectContextPending"]["status"] = json!("outcomeUnknown"),
    }
    db.put("sessions", session, &row)
}

/// Model-visible summary sent with a folder change. Muse 1.4.10 keeps describing the
/// session-start folders to the model after `turn/start.workspaceRoots`, so without this the
/// model would not know what was added. It complements, never replaces, the native roots.
pub fn change_note(project: &Value) -> String {
    let mut note = String::from(
        "Lascoria note: the user updated this session's Project folders for this task.",
    );
    describe(project, &mut note);
    // Muse joins input parts without a separator.
    note.push_str("\nUse absolute paths for folders other than the default. Earlier folder lists in this conversation are out of date.\n\n");
    note
}

/// The user's Project goal and folder notes, sent once with the first plain task of a Project
/// session (and again with a folder change), so the model knows how the folders fit together.
/// `None` when the Project has neither.
pub fn brief(project: &Value) -> Option<String> {
    let folders = project["folders"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    if project.get("goal").is_none() && !folders.iter().any(|f| f.get("note").is_some()) {
        return None;
    }
    let mut note = format!(
        "Lascoria note: this session belongs to the Project \"{}\", set up by the user.",
        project["name"].as_str().unwrap_or("Project")
    );
    describe(project, &mut note);
    note.push_str(
        "\nThese notes are the user's own description; they do not grant any permissions.\n\n",
    );
    Some(note)
}

fn describe(project: &Value, note: &mut String) {
    if let Some(goal) = project["goal"].as_str() {
        note.push_str(&format!("\nProject goal: {goal}"));
    }
    note.push_str("\nFolders available, default first:");
    for (index, folder) in project["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        note.push_str(&format!(
            "\n- {}{}: {}",
            folder["name"].as_str().unwrap_or("Folder"),
            if index == 0 { " (default)" } else { "" },
            folder["path"].as_str().unwrap_or_default()
        ));
        if let Some(text) = folder["note"].as_str() {
            note.push_str(&format!(". Note: {}", text.replace('\n', " ")));
        }
    }
}

/// Native roots for a Project snapshot, in order, default folder first.
pub fn root_paths(project: &Value) -> Value {
    json!(
        project["folders"]
            .as_array()
            .map(|folders| folders
                .iter()
                .map(|f| f["path"].clone())
                .collect::<Vec<_>>())
            .unwrap_or_default()
    )
}

// Filesystem probes never hold the shared DB mutex or a Tokio executor thread.
// A stalled/offline mount retains one of two permits until its blocking probe exits.
static PATH_PROBES: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
async fn probe(value: Value, require_same: bool) -> Result<Value> {
    let permit = PATH_PROBES
        .try_acquire()
        .context("Project folder checks busy; retry shortly")?;
    let task = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let paths = roots(&value)?;
        let mut folders = value["folders"].as_array().unwrap().clone();
        for (folder, path) in folders.iter_mut().zip(paths) {
            if require_same {
                ensure!(
                    std::path::Path::new(folder["path"].as_str().unwrap()) == path,
                    "Applied project folder moved; restore the original folder or edit the saved Project for a new session"
                );
            }
            *folder = folder_snapshot(folder, &path)?;
        }
        Ok::<_, anyhow::Error>(json!(folders))
    });
    tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .context("Project folder check timed out; check folder availability before retrying")??
}

pub async fn save_request(db: crate::worker::SharedDb, params: Value, id: String) -> Result<Value> {
    // Exact retry reconciliation is a DB read and must work even if a folder disappeared.
    if let Some(prior) = db.lock().unwrap().get(
        "presentation",
        &format!("project:{}", identity(&params["id"])?),
    )? && prior["requestId"] == id
    {
        ensure!(prior["intent"] == params, "Project retry payload changed");
        return Ok(prior);
    }
    let folders = probe(params.clone(), false).await?;
    commit(&db.lock().unwrap(), &params, &id, folders)
}

pub async fn check_session(row: &Value) -> Result<()> {
    if let Some(project) = row.get("projectContext") {
        probe(project.clone(), true).await?;
    }
    Ok(())
}

#[cfg(test)]
fn save(db: &Db, params: &Value, id: &str) -> Result<Value> {
    let paths = roots(params)?;
    let mut folders = params["folders"].as_array().unwrap().clone();
    for (folder, path) in folders.iter_mut().zip(paths) {
        *folder = folder_snapshot(folder, &path)?;
    }
    commit(db, params, id, json!(folders))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn next_task_replacement_is_scoped_newer_keeps_default_and_settles_from_the_journal() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        for dir in ["app", "api", "docs"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let db = Db::open(&root.join("state.sqlite")).unwrap();
        let folder = |name: &str| json!({"id":uuid::Uuid::new_v4().to_string(),"name":name,"path":dunce::canonicalize(root.join(name.to_lowercase())).unwrap()});
        let (app, api, docs) = (folder("App"), folder("API"), folder("Docs"));
        let mut input = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"P","expectedRevision":0,"folders":[app,api]});
        save(&db, &input, "p1").unwrap();
        let applied = selected(&db, &json!({"projectId":input["id"],"projectRevision":1}))
            .unwrap()
            .unwrap();
        let row = json!({"id":"s","projectContext":applied});
        let turn = |revision: Option<u64>| match revision {
            Some(r) => json!({"sessionId":"s","text":"x","projectRevision":r}),
            None => json!({"sessionId":"s","text":"x"}),
        };
        assert!(replacement(&db, &row, &turn(None)).unwrap().is_none());
        assert!(
            replacement(&db, &row, &turn(Some(1))).is_err(),
            "already applied"
        );
        assert!(
            replacement(&db, &json!({"id":"plain"}), &turn(Some(2))).is_err(),
            "standalone sessions have no Project"
        );
        input["expectedRevision"] = json!(1);
        input["folders"] = json!([app, api, docs]);
        save(&db, &input, "p2").unwrap();
        let next = replacement(&db, &row, &turn(Some(2))).unwrap().unwrap();
        assert_eq!(next["revision"], 2);
        assert_eq!(root_paths(&next).as_array().unwrap().len(), 3);
        let note = change_note(&next);
        assert!(
            note.contains("App (default): ")
                && note.contains(next["folders"][2]["path"].as_str().unwrap())
        );
        assert!(
            replacement(&db, &row, &turn(Some(3))).is_err(),
            "unsaved revision"
        );
        input["expectedRevision"] = json!(2);
        input["folders"] = json!([api, app]);
        save(&db, &input, "p3").unwrap();
        assert!(
            replacement(&db, &row, &turn(Some(2))).is_err(),
            "a superseded revision is refused"
        );
        assert!(
            replacement(&db, &row, &turn(Some(3)))
                .unwrap_err()
                .to_string()
                .contains("default folder")
        );

        // Settlement follows the journalled command, never the reply.
        let pending = |status: &str| {
            let mut row = row.clone();
            row["projectContextPending"] =
                json!({"revision":2,"requestId":"t1","status":status,"project":next});
            db.put("sessions", "s", &row).unwrap();
        };
        pending("requested");
        settle_pending(&db, "s").unwrap();
        assert!(
            db.get("sessions", "s").unwrap().unwrap()["projectContextPending"].is_null(),
            "nothing journalled: dropped"
        );
        pending("requested");
        db.put(
            "commands",
            "t1",
            &json!({"id":"t1","status":"outcomeUnknown","commandId":"c1"}),
        )
        .unwrap();
        settle_pending(&db, "s").unwrap();
        let unknown = db.get("sessions", "s").unwrap().unwrap();
        assert_eq!(unknown["projectContextPending"]["status"], "outcomeUnknown");
        assert_eq!(
            unknown["projectContext"]["revision"], 1,
            "prior context stays"
        );
        db.put(
            "commands",
            "t1",
            &json!({"id":"t1","status":"applied","commandId":"c1"}),
        )
        .unwrap();
        settle_pending(&db, "s").unwrap();
        let settled = db.get("sessions", "s").unwrap().unwrap();
        assert_eq!(settled["projectContext"]["revision"], 2);
        assert_eq!(settled["projectContextReceipt"]["requestId"], "t1");
        assert_eq!(settled["projectContextReceipt"]["commandId"], "c1");
        assert!(settled["projectContextPending"].is_null());
        settle_pending(&db, "s").unwrap();
        assert_eq!(
            db.get("sessions", "s").unwrap().unwrap(),
            settled,
            "idempotent"
        );
        pending("requested");
        db.put("commands", "t1", &json!({"id":"t1","status":"rejected"}))
            .unwrap();
        settle_pending(&db, "s").unwrap();
        let refused = db.get("sessions", "s").unwrap().unwrap();
        assert!(refused["projectContextPending"].is_null());
        assert_eq!(refused["projectContext"]["revision"], 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn path_probe_admission_is_bounded_without_locking_storage() {
        let db = std::sync::Arc::new(std::sync::Mutex::new(
            Db::open(std::path::Path::new(":memory:")).unwrap(),
        ));
        let one = PATH_PROBES.acquire().await.unwrap();
        let two = PATH_PROBES.acquire().await.unwrap();
        assert!(
            check_session(&json!({"projectContext":{"folders":[]}}))
                .await
                .unwrap_err()
                .to_string()
                .contains("busy")
        );
        assert!(list(&db.lock().unwrap()).unwrap().is_empty());
        drop(one);
        drop(two);
        assert!(
            check_session(&json!({"projectContext":{"folders":[]}}))
                .await
                .unwrap_err()
                .to_string()
                .contains("1 to 8")
        );
    }
    #[test]
    fn goal_and_folder_notes_are_bounded_saved_and_briefed() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        let db = Db::open(&root.join("state.sqlite")).unwrap();
        let folder = |name: &str, dir: &str, note: Value| json!({"id":uuid::Uuid::new_v4().to_string(),"name":name,"path":root.join(dir),"note":note});
        let mut input = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Shop","expectedRevision":0,
            "goal":"  Ship checkout v2\r\nwithout breaking the API  ",
            "folders":[folder("App","a",json!("The web client")),folder("API","b",Value::Null)]});
        let saved = save(&db, &input, "goal-1").unwrap();
        assert_eq!(saved["goal"], "Ship checkout v2\nwithout breaking the API");
        assert_eq!(saved["folders"][0]["note"], "The web client");
        assert!(saved["folders"][1].get("note").is_none());
        let text = brief(&saved).unwrap();
        assert!(text.contains("Project \"Shop\""));
        assert!(text.contains("Project goal: Ship checkout v2\nwithout breaking the API"));
        assert!(text.contains("- App (default): ") && text.contains(". Note: The web client"));
        assert!(text.contains("do not grant any permissions") && text.ends_with("\n\n"));
        // The folder-change note carries them too.
        assert!(change_note(&saved).contains("Project goal: Ship checkout v2"));
        // A Project with neither has no brief, and blank text counts as absent.
        input["expectedRevision"] = json!(1);
        input["goal"] = json!("   ");
        input["folders"][0]["note"] = json!("");
        let plain = save(&db, &input, "goal-2").unwrap();
        assert!(plain.get("goal").is_none() && brief(&plain).is_none());
        // Bounds and control characters are refused.
        input["expectedRevision"] = json!(2);
        input["goal"] = json!("x".repeat(1001));
        assert!(save(&db, &input, "goal-3").is_err());
        input["goal"] = json!("bell\u{7}");
        assert!(save(&db, &input, "goal-4").is_err());
        input["goal"] = Value::Null;
        input["folders"][0]["note"] = json!("n".repeat(301));
        assert!(save(&db, &input, "goal-5").is_err());
        input["folders"][0]["note"] = json!(7);
        assert!(save(&db, &input, "goal-6").is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_revisions_paths_and_retry_contract() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(root.join("a")).unwrap();
        std::fs::create_dir_all(root.join("b")).unwrap();
        let path = root.join("state.sqlite");
        let db = Db::open(&path).unwrap();
        let mut input = json!({"id":uuid::Uuid::new_v4().to_string(),"name":" Example ","expectedRevision":0,"folders":[{"id":uuid::Uuid::new_v4().to_string(),"name":"App","path":root.join("a")},{"id":uuid::Uuid::new_v4().to_string(),"name":"API","path":root.join("b")}]});
        let first = save(&db, &input, "create").unwrap();
        assert_eq!(first["name"], "Example");
        let version = db.version();
        assert_eq!(save(&db, &input, "create").unwrap(), first);
        assert_eq!(db.version(), version);
        assert!(save(&db, &input, "stale").is_err());
        input["name"] = json!("Changed");
        assert!(save(&db, &input, "create").is_err());
        input["expectedRevision"] = json!(1);
        save(&db, &input, "edit").unwrap();
        assert!(selected(&db, &json!({"projectId":input["id"],"projectRevision":1})).is_err());
        let snapshot = selected(&db, &json!({"projectId":input["id"],"projectRevision":2}))
            .unwrap()
            .unwrap();
        assert_eq!(snapshot["folders"].as_array().unwrap().len(), 2);
        drop(db);
        let db = Db::open(&path).unwrap();
        assert_eq!(list(&db).unwrap().len(), 1);
        assert_eq!(list(&db).unwrap()[0]["revision"], 2);
        #[cfg(unix)]
        {
            std::fs::create_dir_all(root.join("replacement")).unwrap();
            std::fs::remove_dir(root.join("a")).unwrap();
            std::os::unix::fs::symlink(root.join("replacement"), root.join("a")).unwrap();
            let resolved = roots(&snapshot).unwrap();
            assert_ne!(
                resolved[0],
                std::path::PathBuf::from(snapshot["folders"][0]["path"].as_str().unwrap())
            );
        }
        input["folders"][1]["path"] = input["folders"][0]["path"].clone();
        assert!(roots(&input).is_err());
        input["folders"][1]["path"] = json!(root);
        assert!(roots(&input).is_err());
        input["folders"][1]["path"] = json!(root.join("missing"));
        assert!(roots(&input).is_err());
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
