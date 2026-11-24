//! Developer-authored task handoffs and bounded local Git overlap observations.
use crate::{git, review, worker::SharedDb, workspace};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::Semaphore;

pub(crate) const HANDOFFS: &str = "task-handoffs-v1";
const MAX_HANDOFFS: usize = 64;
const MAX_NOTE: usize = 2_000;
const MAX_EXCERPT: usize = 4_000;
const MAX_FOLDERS: usize = 12;
const MAX_PATHS: usize = 256;
const MAX_OVERLAPS: usize = 32;
static OVERLAP_SCAN: Semaphore = Semaphore::const_new(1);
static OVERLAP_WORKERS: Semaphore = Semaphore::const_new(4);

fn list(db: &crate::db::Db) -> Result<Vec<Value>> {
    Ok(db
        .get("presentation", HANDOFFS)?
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default())
}

fn task(db: &crate::db::Db, id: &str, turn: &str) -> Result<Value> {
    let row = db
        .get("sessions", id)?
        .context("Session is no longer available")?;
    ensure!(
        row["lifecycle"] != "archived" && row["workspaceDiscarded"] != true,
        "Choose an open task session"
    );
    ensure!(
        row["state"]["turns"]
            .as_array()
            .is_some_and(|turns| turns.iter().any(|r| r["turnId"] == turn)),
        "Task is no longer available in this session"
    );
    Ok(row)
}

fn endpoints(db: &crate::db::Db, params: &Value) -> Result<Value> {
    let source = &params["source"];
    let target = &params["target"];
    let source_id = source["sessionId"]
        .as_str()
        .context("Choose a source session")?;
    let target_id = target["sessionId"]
        .as_str()
        .context("Choose a receiving session")?;
    ensure!(
        source_id != target_id,
        "Choose a different receiving session"
    );
    let row = task(
        db,
        source_id,
        source["turnId"].as_str().context("Select a source task")?,
    )?;
    task(
        db,
        target_id,
        target["turnId"]
            .as_str()
            .context("Select a receiving task")?,
    )?;
    workspace::scoped(&row, source["folderId"].as_str())
}

fn no_cycle(edges: &[Value], source: &Value, target: &Value) -> bool {
    // Match task identities rather than folders, since a task can touch several folders.
    let key = |v: &Value| (v["sessionId"].to_string(), v["turnId"].to_string());
    let source = key(source);
    let mut pending = vec![key(target)];
    let mut seen = BTreeSet::new();
    while let Some(next) = pending.pop() {
        if next == source {
            return false;
        }
        if seen.insert(next.clone()) {
            pending.extend(
                edges
                    .iter()
                    .filter(|e| key(&e["source"]) == next)
                    .map(|e| key(&e["target"])),
            );
        }
    }
    true
}

fn clipped(s: &str, max: usize) -> (&str, bool) {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], end != s.len())
}

async fn preview(db: &SharedDb, params: &Value) -> Result<Value> {
    for name in ["source", "target"] {
        let endpoint = &params[name];
        ensure!(
            endpoint.as_object().is_some_and(|value| value.len() <= 3
                && value
                    .iter()
                    .all(|(key, value)| ["sessionId", "turnId", "folderId"]
                        .contains(&key.as_str())
                        && value
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s.len() <= 128))),
            "Invalid handoff task identity"
        );
    }
    let selection = &params["selection"];
    ensure!(
        match selection["kind"].as_str() {
            Some("diff") =>
                *selection == json!({"kind":"diff","id":selection["id"]})
                    && selection["id"].as_str().is_some_and(|s| s.len() <= 128),
            Some("test") => *selection == json!({"kind":"test"}),
            Some("decision") => *selection == json!({"kind":"decision","note":selection["note"]}),
            _ => false,
        },
        "Invalid handoff evidence"
    );
    let (row, record) = {
        let db = db.lock().unwrap();
        let row = endpoints(&db, params)?;
        let source = &params["source"];
        let selection = &params["selection"];
        let record = match selection["kind"].as_str() {
            Some("diff") => {
                let artifact = db
                    .get(
                        "artifacts",
                        selection["id"].as_str().context("Choose a captured diff")?,
                    )?
                    .context("Capture is no longer available")?;
                ensure!(
                    artifact["sessionId"] == source["sessionId"]
                        && artifact["taskId"] == source["turnId"]
                        && artifact["folder"]["id"] == source["folderId"],
                    "Choose a capture from the selected task and folder"
                );
                artifact
            }
            Some("test") => db
                .latest_folder_command(
                    "workspace/run",
                    source["sessionId"].as_str().unwrap(),
                    source["folderId"].as_str(),
                )?
                .context("Run a test in the source folder first")?,
            Some("decision") => Value::Null,
            _ => anyhow::bail!("Choose a diff, test or decision"),
        };
        (row, record)
    };
    workspace::check_trusted_root(&row)?;
    let root = Path::new(row["workspace"].as_str().context("Workspace required")?);
    let file_revision = workspace::content_fingerprint(root).await?;
    let (body, truncated) = match params["selection"]["kind"].as_str() {
        Some("diff") => {
            ensure!(
                review::capture(root).await?["fingerprint"] == record["fingerprint"],
                "The captured diff has changed; capture it again"
            );
            let patch = record["patch"]
                .as_str()
                .context("Capture has no text diff")?;
            ensure!(!patch.is_empty(), "Capture has no tracked diff to share");
            let excerpt = clipped(patch, MAX_EXCERPT);
            (
                format!(
                    "Captured diff excerpt ({}):\n{}",
                    record["head"].as_str().unwrap_or_default(),
                    excerpt.0
                ),
                excerpt.1,
            )
        }
        Some("test") => {
            let result = &record["result"];
            ensure!(
                record["status"] == "applied"
                    && matches!(result["outcome"].as_str(), Some("passed" | "failed"))
                    && result["contentUnchanged"] == true
                    && result["endFilesFingerprint"] == workspace::files_fingerprint(root).await?,
                "Run a test on the current source files before sharing its result"
            );
            let command = record["params"]["command"]
                .as_str()
                .context("Test command missing")?;
            (
                format!(
                    "Workspace test: {}\nOutcome: {} (exit {})",
                    command,
                    result["outcome"].as_str().unwrap(),
                    result["exitCode"]
                ),
                false,
            )
        }
        _ => {
            let note = params["selection"]["note"]
                .as_str()
                .context("Enter a decision")?;
            ensure!(
                !note.trim().is_empty() && note.len() <= MAX_NOTE,
                "Use a decision of 1 to 2,000 bytes"
            );
            (format!("Developer decision:\n{note}"), false)
        }
    };
    ensure!(
        workspace::content_fingerprint(root).await? == file_revision,
        "Source changed during review. Try again."
    );
    Ok(json!({"body":body,"revision":file_revision,"recordId":record["id"],"truncated":truncated}))
}

pub async fn handoff(db: &SharedDb, operation: &str, params: &Value, id: &str) -> Result<Value> {
    if operation == "handoff/links" {
        let links = list(&db.lock().unwrap())?
            .into_iter()
            .map(|p| {
                json!({
                    "id":p["id"],"source":p["source"],"target":p["target"]
                })
            })
            .collect::<Vec<_>>();
        return Ok(json!({"links":links}));
    }
    if operation == "handoff/list" {
        let identity = &params["task"];
        let session = identity["sessionId"]
            .as_str()
            .context("Task session required")?;
        let turn = identity["turnId"]
            .as_str()
            .context("Task identity required")?;
        let guard = db.lock().unwrap();
        task(&guard, session, turn)?;
        let handoffs = list(&guard)?
            .into_iter()
            .filter(|value| {
                ["source", "target"].iter().any(|role| {
                    value[role]["sessionId"] == session && value[role]["turnId"] == turn
                })
            })
            .collect::<Vec<_>>();
        return Ok(json!({"handoffs":handoffs}));
    }
    if operation == "handoff/preview" {
        return preview(db, params).await;
    }
    if operation == "handoff/check" {
        let packet = list(&db.lock().unwrap())?
            .into_iter()
            .find(|p| p["id"] == params["handoffId"])
            .context("Handoff is no longer available")?;
        let current = preview(db, &packet)
            .await
            .is_ok_and(|v| v == packet["evidence"]);
        return Ok(json!({"current":current,"handoff":packet}));
    }
    ensure!(operation == "handoff/save", "Unsupported handoff operation");
    ensure!(
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b)),
        "Invalid handoff request ID"
    );
    let request = json!({"source":params["source"],"target":params["target"],"selection":params["selection"],"evidence":params["evidence"]});
    let replay = |stored: Value| -> Result<Value> {
        ensure!(
            ["source", "target", "selection", "evidence"]
                .iter()
                .all(|k| stored[k] == request[k]),
            "Handoff ID was already used for different evidence"
        );
        Ok(stored)
    };
    if let Some(stored) = list(&db.lock().unwrap())?
        .into_iter()
        .find(|p| p["id"] == id)
    {
        return replay(stored);
    }
    ensure!(
        preview(db, &request).await? == request["evidence"],
        "Source changed after preview. Review the new evidence first."
    );
    let db = db.lock().unwrap();
    endpoints(&db, &request)?;
    let mut edges = list(&db)?;
    if let Some(stored) = edges.iter().find(|p| p["id"] == id) {
        return replay(stored.clone());
    }
    ensure!(
        edges.len() < MAX_HANDOFFS,
        "This workspace has reached its 64 saved handoffs"
    );
    ensure!(
        no_cycle(&edges, &request["source"], &request["target"]),
        "This handoff would make the tasks depend on one another"
    );
    let mut packet = request.clone();
    packet["id"] = json!(id);
    packet["createdAtMillis"] = json!(crate::db::now_ms());
    edges.insert(0, packet.clone());
    db.put("presentation", HANDOFFS, &json!(edges))?;
    Ok(packet)
}

struct Folder {
    task: Value,
    root: PathBuf,
    base: String,
}

async fn changed_paths(folder: &Folder) -> Result<(PathBuf, BTreeSet<String>)> {
    let _permit = OVERLAP_WORKERS.acquire().await?;
    let root = &folder.root;
    ensure!(dunce::canonicalize(root)? == *root, "Worktree moved");
    let common = workspace::git(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .await?;
    let common = dunce::canonicalize(common.trim())?;
    let mut paths = BTreeSet::new();
    for args in [
        vec![
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--name-only",
            "-z",
            &folder.base,
            "HEAD",
            "--",
        ],
        vec![
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--name-only",
            "-z",
            "HEAD",
            "--",
        ],
        vec!["ls-files", "-z", "--others", "--exclude-standard"],
    ] {
        for path in String::from_utf8(git::run(root, &args, Duration::from_secs(2), true).await?)?
            .split('\0')
            .filter(|p| !p.is_empty())
        {
            ensure!(
                path.len() <= 1024,
                "A changed path exceeds the overlap budget"
            );
            paths.insert(path.to_owned());
            ensure!(
                paths.len() <= MAX_PATHS,
                "The worktree exceeds the overlap path budget"
            );
        }
    }
    Ok((common, paths))
}

pub async fn overlaps(db: &SharedDb) -> Result<Value> {
    let _permit = OVERLAP_SCAN
        .try_acquire()
        .context("An overlap check is already running")?;
    let (folders, mut incomplete) = {
        // Read compact scope metadata only. Growing transcript histories are never parsed for a scan.
        let rows = db.lock().unwrap().overlap_scopes()?;
        let mut folders = Vec::new();
        let mut incomplete = false;
        for row in rows {
            let managed = row["managedWorkspaces"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![row["managedWorkspace"].clone()]);
            for w in managed {
                if folders.len() == MAX_FOLDERS {
                    incomplete = true;
                    break;
                }
                let (Some(path), Some(base)) = (w["path"].as_str(), w["base"].as_str()) else {
                    continue;
                };
                if base.len() != 40 || !base.bytes().all(|b| b.is_ascii_hexdigit()) {
                    incomplete = true;
                    continue;
                }
                folders.push(Folder{
                    task:json!({"sessionId":row["id"],"folderId":w["folderId"],"turnId":row["turnId"]}),
                    root:PathBuf::from(path),
                    base:base.to_owned(),
                });
            }
        }
        (folders, incomplete)
    };
    let mut index: BTreeMap<(PathBuf, String), Vec<Value>> = BTreeMap::new();
    let mut scans = tokio::task::JoinSet::new();
    for folder in folders {
        scans.spawn(async move { (folder.task.clone(), changed_paths(&folder).await) });
    }
    while let Some(result) = scans.join_next().await {
        match result? {
            (owner, Ok((common, paths))) => {
                for path in paths {
                    index
                        .entry((common.clone(), path))
                        .or_default()
                        .push(owner.clone());
                }
            }
            (_, Err(_)) => incomplete = true,
        }
    }
    let mut matches = Vec::new();
    for ((_, path), mut owners) in index {
        owners.sort_by_cached_key(Value::to_string);
        if owners
            .iter()
            .all(|owner| owner["sessionId"] == owners[0]["sessionId"])
        {
            continue;
        }
        if matches.len() == MAX_OVERLAPS {
            incomplete = true;
            break;
        }
        matches.push(json!({"path":path,"owners":owners}));
    }
    Ok(json!({"matches":matches,"incomplete":incomplete,"observedAtMillis":crate::db::now_ms()}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn overlap_matches_shared_repository_identity_only_and_omits_archived_worktrees()
    -> Result<()> {
        let directory = dunce::canonicalize(std::env::temp_dir())?
            .join(format!("lascoria-overlap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory)?;
        let result = async {
            let database = Arc::new(Mutex::new(Db::open(&directory.join("state.sqlite"))?));
            let repo = directory.join("repo");
            let unrelated = directory.join("separate");
            for source in [&repo, &unrelated] {
                std::fs::create_dir(source)?;
                workspace::git(source, &["init", "-q", "-b", "main"]).await?;
                workspace::git(source, &["config", "user.name", "Fixture"]).await?;
                workspace::git(source, &["config", "user.email", "fixture@example.invalid"])
                    .await?;
                std::fs::write(source.join("shared.txt"), "original\n")?;
                workspace::git(source, &["add", "."]).await?;
                workspace::git(source, &["commit", "-qm", "initial"]).await?;
            }
            for (id, source) in [("a", &repo), ("b", &repo), ("other", &unrelated)] {
                let target = directory.join(id);
                let managed = workspace::create(source, &target, id).await?;
                std::fs::write(target.join("shared.txt"), format!("change {id}\n"))?;
                database.lock().unwrap().put(
                    "sessions",
                    id,
                    &json!({
                        "id":id,"lifecycle":"connected","managedWorkspace":managed,
                        "state":{"turns":[{"turnId":format!("turn-{id}")}]}
                    }),
                )?;
            }
            let observed = overlaps(&database).await?;
            assert_eq!(observed["incomplete"], false);
            assert_eq!(observed["matches"].as_array().unwrap().len(), 1);
            assert_eq!(observed["matches"][0]["path"], "shared.txt");
            let owners = observed["matches"][0]["owners"].as_array().unwrap();
            assert_eq!(
                owners
                    .iter()
                    .map(|owner| owner["sessionId"].as_str().unwrap())
                    .collect::<BTreeSet<_>>(),
                BTreeSet::from(["a", "b"])
            );
            {
                let db = database.lock().unwrap();
                let mut row = db.get("sessions", "b")?.unwrap();
                row["lifecycle"] = json!("archived");
                db.put("sessions", "b", &row)?;
            }
            assert_eq!(overlaps(&database).await?["matches"], json!([]));
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let _ = std::fs::remove_dir_all(directory);
        result
    }
}
