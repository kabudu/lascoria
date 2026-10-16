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
                .all(|k| ["id", "name", "path"].contains(&k.as_str()))),
            "Unknown folder field"
        );
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
            "folders"
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
    let project = json!({"id":id,"name":name,"folders":folders,"revision":revision.checked_add(1).context("Project revision exhausted")?,"requestId":request_id,"intent":params});
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
            *folder = json!({"id":folder["id"],"name":session_names::validate(Some(&folder["name"]))?,"path":path});
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
        folder["path"] = json!(path);
    }
    commit(db, params, id, json!(folders))
}

#[cfg(test)]
mod tests {
    use super::*;
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
