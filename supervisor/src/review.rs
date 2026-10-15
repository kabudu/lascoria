//! Presentation and revision-bound user attestations, separate from execution authority.
use crate::{db::now_ms, worker::SharedDb};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::{
    io::AsyncReadExt,
    time::{Duration, timeout},
};
use uuid::Uuid;

async fn git(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    let mut child = lascoria_runtime::command("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            lascoria_runtime::hooks_config(),
        ])
        .arg("-C")
        .arg(dunce::simplified(root))
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let result = timeout(Duration::from_secs(5), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut out_reader = stdout.take(1024 * 1024 + 1);
        let mut err_reader = stderr.take(8193);
        let (a, b) = tokio::join!(
            out_reader.read_to_end(&mut out),
            err_reader.read_to_end(&mut err)
        );
        a?;
        b?;
        ensure!(
            out.len() <= 1024 * 1024 && err.len() <= 8192,
            "Git diagnostic output exceeds budget"
        );
        let status = child.wait().await?;
        ensure!(
            status.success(),
            "Git inspection failed: {}",
            String::from_utf8_lossy(&err)
        );
        Ok::<_, anyhow::Error>(out)
    })
    .await
    .context("Git inspection deadline exceeded")?;
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub async fn capture(root: &Path) -> Result<Value> {
    let top = String::from_utf8(git(root, &["rev-parse", "--show-toplevel"]).await?)?;
    ensure!(
        tokio::fs::canonicalize(root).await? == tokio::fs::canonicalize(top.trim()).await?,
        "Capture requires the repository root workspace"
    );
    let hidden = git(root, &["ls-files", "-v", "-z"]).await?;
    ensure!(
        hidden
            .split(|b| *b == 0)
            .filter(|row| !row.is_empty())
            .all(|row| row[0].is_ascii_uppercase() && row[0] != b'S'),
        "Capture refuses assume-unchanged or skip-worktree files"
    );
    let head = String::from_utf8(git(root, &["rev-parse", "HEAD"]).await?)?
        .trim()
        .to_string();
    let patch = git(
        root,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--binary",
            "HEAD",
            "--",
        ],
    )
    .await?;
    let tracked = git(root, &["ls-files", "--cached", "-z"]).await?;
    let names = git(root, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    let mut digest = Sha256::new();
    digest.update(b"constellation-capture-v1");
    digest.update((head.len() as u64).to_be_bytes());
    digest.update(head.as_bytes());
    digest.update((patch.len() as u64).to_be_bytes());
    digest.update(&patch);
    let mut tracked_bytes = 0usize;
    let mut tracked_count = 0usize;
    for name in tracked.split(|b| *b == 0).filter(|name| !name.is_empty()) {
        tracked_count += 1;
        ensure!(
            tracked_count <= 2000,
            "Tracked file count exceeds capture budget"
        );
        let name = std::str::from_utf8(name)?;
        let path = root.join(name);
        digest.update((name.len() as u64).to_be_bytes());
        digest.update(name.as_bytes());
        let meta = match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                digest.update(b"missing");
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Cannot fingerprint non-regular tracked file {name}"
        );
        let canonical = tokio::fs::canonicalize(&path).await?;
        ensure!(
            canonical.starts_with(tokio::fs::canonicalize(root).await?),
            "Tracked file outside workspace"
        );
        ensure!(
            meta.len() <= 1024 * 1024,
            "Tracked file exceeds 1 MiB fingerprint budget"
        );
        let mut content = Vec::new();
        tokio::fs::File::open(canonical)
            .await?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut content)
            .await?;
        ensure!(
            content.len() <= 1024 * 1024,
            "Tracked file grew beyond capture budget"
        );
        tracked_bytes += content.len();
        ensure!(
            tracked_bytes <= 16 * 1024 * 1024,
            "Tracked content exceeds 16 MiB fingerprint budget"
        );
        digest.update(b"present");
        digest.update(lascoria_runtime::fingerprint_mode(&meta).to_be_bytes());
        digest.update((content.len() as u64).to_be_bytes());
        digest.update(&content);
    }
    let mut untracked = Vec::new();
    let mut bytes = patch.len();
    for name in names
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
    {
        ensure!(
            untracked.len() < 200,
            "Untracked file count exceeds capture budget"
        );
        let name = std::str::from_utf8(name)?;
        let path = root.join(name);
        // No symlinks or special files, including ancestors that resolve outside the repository.
        let meta = tokio::fs::symlink_metadata(&path).await?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Cannot capture non-regular file {name}"
        );
        let canonical = tokio::fs::canonicalize(&path).await?;
        ensure!(
            canonical.starts_with(tokio::fs::canonicalize(root).await?),
            "File outside workspace"
        );
        ensure!(
            meta.len() <= 1024 * 1024,
            "Untracked file exceeds capture budget"
        );
        let mut content = Vec::new();
        tokio::fs::File::open(&canonical)
            .await?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut content)
            .await?;
        ensure!(
            content.len() <= 1024 * 1024,
            "Untracked file grew beyond capture budget"
        );
        bytes += content.len();
        ensure!(bytes <= 4 * 1024 * 1024, "Capture exceeds 4 MiB budget");
        digest.update((name.len() as u64).to_be_bytes());
        digest.update(name.as_bytes());
        digest.update(lascoria_runtime::fingerprint_mode(&meta).to_be_bytes());
        digest.update((content.len() as u64).to_be_bytes());
        digest.update(&content);
        untracked.push(json!({"path": name, "bytes":content.len(), "sha256":hex(&Sha256::digest(&content)), "text":String::from_utf8(content).ok()}));
    }
    Ok(
        json!({"head":head,"base":head,"fingerprint":format!("sha256:{}",hex(&digest.finalize())),"patch":String::from_utf8(patch)?,"untracked":untracked,"capturedAtMillis":now_ms(),"environment":format!("{} {}",std::env::consts::OS,std::env::consts::ARCH)}),
    )
}

pub async fn handle(
    db: SharedDb,
    operation: &str,
    params: &Value,
    request_id: &str,
) -> Result<Value> {
    if operation == "drafts/get" {
        let database = db.lock().unwrap();
        let mut drafts = serde_json::Map::new();
        for session in database.all("sessions")? {
            let id = session["id"].as_str().context("Invalid session")?;
            if let Some(draft) = database.get("presentation", &format!("draft:{id}"))? {
                drafts.insert(id.to_owned(), draft);
            }
        }
        return Ok(json!({"drafts": drafts}));
    }
    if operation == "drafts/save" {
        let id = params["sessionId"].as_str().context("Session required")?;
        let text = params["text"].as_str().context("Draft text required")?;
        ensure!(
            text.len() <= 64000 && text.chars().count() <= 16000,
            "Draft exceeds 16000 characters"
        );
        let database = db.lock().unwrap();
        ensure!(database.get("sessions", id)?.is_some(), "Unknown session");
        let key = format!("draft:{id}");
        let prior = database
            .get("presentation", &key)?
            .unwrap_or(json!({"revision":0,"text":""}));
        if prior["requestId"] == request_id {
            ensure!(
                prior["text"] == text && prior["expectedRevision"] == params["expectedRevision"],
                "Draft retry changed"
            );
            return Ok(prior);
        }
        ensure!(
            params["expectedRevision"] == prior["revision"],
            "Draft changed in another window; retain your text and reload"
        );
        let row = json!({"text":text,"revision":prior["revision"].as_u64().unwrap_or(0)+1,"requestId":request_id,"expectedRevision":params["expectedRevision"]});
        database.put("presentation", &key, &row)?;
        return Ok(row);
    }
    if operation == "presentation/get" {
        return Ok(db
            .lock()
            .unwrap()
            .get("presentation", "ui")?
            .unwrap_or(json!({"schemaVersion":1,"revision":0,"value":{}})));
    }
    if operation == "presentation/save" {
        ensure!(
            params["value"].is_object() && params["value"].to_string().len() <= 48000,
            "Invalid presentation data"
        );
        let db = db.lock().unwrap();
        let prior = db
            .get("presentation", "ui")?
            .unwrap_or(json!({"revision":0}));
        // A lost acknowledgement may retry the same CAS write after it committed.
        if prior["requestId"] == request_id {
            ensure!(
                prior["value"] == params["value"]
                    && prior["expectedRevision"] == params["expectedRevision"],
                "Presentation retry payload changed"
            );
            return Ok(prior);
        }
        ensure!(
            params["expectedRevision"] == prior["revision"],
            "Presentation changed; refresh before saving"
        );
        let row = json!({"schemaVersion":1,"revision":prior["revision"].as_u64().unwrap()+1,"value":params["value"],"requestId":request_id,"expectedRevision":params["expectedRevision"]});
        db.put("presentation", "ui", &row)?;
        return Ok(row);
    }
    let session_id = params["sessionId"].as_str().context("Session required")?;
    let session = db
        .lock()
        .unwrap()
        .get("sessions", session_id)?
        .context("Unknown session")?;
    let root = Path::new(
        session["workspace"]
            .as_str()
            .context("Workspace required")?,
    );
    if operation == "artifact/capture" {
        let key = format!("capture_{request_id}");
        if let Some(prior) = db.lock().unwrap().get("artifacts", &key)? {
            ensure!(
                prior["sessionId"] == session_id && prior["taskId"] == params["taskId"],
                "Capture ID reused with different target"
            );
            return Ok(prior);
        }
        ensure!(
            db.lock().unwrap().count("artifacts")? < 100,
            "Artifact retention limit reached"
        );
        let task = params["taskId"]
            .as_str()
            .context("Producing task required")?;
        ensure!(
            session["state"]["turns"]
                .as_array()
                .is_some_and(|turns| turns.iter().any(|t| t["turnId"] == task)),
            "Unknown producing turn"
        );
        let mut row = capture(root).await?;
        ensure!(
            capture(root).await?["fingerprint"] == row["fingerprint"],
            "Repository changed during capture; try again"
        );
        row["id"] = json!(key);
        row["sessionId"] = json!(session_id);
        row["taskId"] = json!(task);
        row["provenance"] = json!("userAsserted");
        row["revision"] = json!(1);
        db.lock().unwrap().put("artifacts", &key, &row)?;
        return Ok(row);
    }
    if operation == "review/list" {
        let offset = params["offset"].as_u64().unwrap_or(0) as usize;
        ensure!(offset <= 500, "Invalid evidence offset");
        let db = db.lock().unwrap();
        let artifacts = db.artifact_metadata(session_id)?;
        let mut evidence = db.evidence_page(session_id, params["artifactId"].as_str(), offset)?;
        let more = evidence.len() > 100;
        evidence.truncate(100);
        return Ok(
            json!({"artifacts":artifacts,"evidence":evidence,"nextOffset":if more {Some(offset+100)}else{None}}),
        );
    }
    let artifact_id = params["artifactId"].as_str().context("Artifact required")?;
    let artifact = db
        .lock()
        .unwrap()
        .get("artifacts", artifact_id)?
        .context("Unknown artifact")?;
    ensure!(
        artifact["sessionId"] == session_id,
        "Artifact belongs to another session"
    );
    if operation == "artifact/read" {
        return Ok(artifact);
    }
    if operation == "artifact/check" {
        let current = capture(root).await?;
        return Ok(
            json!({"artifactId":artifact_id,"fresh":current["fingerprint"] == artifact["fingerprint"],"fingerprint":current["fingerprint"],"checkedAtMillis":now_ms()}),
        );
    }
    ensure!(
        operation == "evidence/record",
        "Unsupported review operation"
    );
    let key = format!("evidence_{request_id}");
    if let Some(prior) = db.lock().unwrap().get("evidence", &key)? {
        ensure!(
            prior["params"] == *params,
            "Evidence ID reused with different payload"
        );
        return Ok(prior);
    }
    ensure!(
        params["fingerprint"] == artifact["fingerprint"],
        "Inspected revision does not match artifact"
    );
    let current = capture(root).await?;
    ensure!(
        current["fingerprint"] == artifact["fingerprint"],
        "Artifact changed; capture and inspect the new revision"
    );
    ensure!(
        ["test", "review", "acceptance"].contains(&params["kind"].as_str().unwrap_or("")),
        "Evidence kind invalid"
    );
    ensure!(
        [
            "passed",
            "failed",
            "approved",
            "changesRequested",
            "accepted",
            "rejected"
        ]
        .contains(&params["outcome"].as_str().unwrap_or("")),
        "Outcome invalid"
    );
    for key in ["author", "notes", "command", "environment"] {
        ensure!(
            params[key]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 8000),
            "Evidence {key} required and bounded"
        );
    }
    ensure!(
        params["exitCode"].is_null() || params["exitCode"].as_i64().is_some(),
        "Exit code must be an integer or null"
    );
    if params["kind"] == "test" {
        ensure!(
            params["exitCode"].as_i64().is_some(),
            "Test requires an attested exit code"
        );
    }
    let outcomes: &[&str] = match params["kind"].as_str() {
        Some("test") => &["passed", "failed"],
        Some("review") => &["approved", "changesRequested"],
        _ => &["accepted", "rejected"],
    };
    ensure!(
        outcomes.contains(&params["outcome"].as_str().unwrap_or("")),
        "Outcome does not match evidence kind"
    );
    if params["kind"] == "test" {
        ensure!(
            (params["exitCode"] == 0) == (params["outcome"] == "passed"),
            "Test outcome does not match exit code"
        );
    }
    let source_id = params["sourceItemId"]
        .as_str()
        .context("Native source item required")?;
    let source_session_id = params["sourceSessionId"].as_str().unwrap_or(session_id);
    let source_session = db
        .lock()
        .unwrap()
        .get("sessions", source_session_id)?
        .context("Unknown evidence source session")?;
    ensure!(
        source_session["workspace"] == session["workspace"],
        "Evidence source belongs to another workspace"
    );
    ensure!(
        source_session["state"]["current"] == true,
        "Evidence source state unavailable"
    );
    let source = source_session["state"]["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["itemId"] == source_id))
        .context("Source outside current window; refresh transcript")?;
    ensure!(
        source["revision"] == params["sourceRevision"] && source["status"] != "inProgress",
        "Source item changed or remains provisional"
    );
    ensure!(
        source.to_string().len() <= 128 * 1024,
        "Evidence source exceeds retention budget; use its output reference"
    );
    let row = json!({"id":key,"schemaVersion":1,"sessionId":session_id,"artifactId":artifact_id,"fingerprint":artifact["fingerprint"],"source":source,"sourceProvenance":source_session["state"]["itemProvenance"][source_id],"params":params,"provenance":"userAttested","recordedAtMillis":now_ms(),"recordId":Uuid::now_v7().to_string()});
    let db = db.lock().unwrap();
    ensure!(
        db.count("evidence")? < 500,
        "Evidence retention limit reached"
    );
    db.put("evidence", &key, &row)?;
    Ok(row)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};
    struct Fixture(std::path::PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[tokio::test]
    async fn fingerprint_reads_real_content_and_refuses_hidden_index_and_symlinks() -> Result<()> {
        let fixture = Fixture(std::env::temp_dir().join(format!("sch-capture-{}", Uuid::new_v4())));
        let root = &fixture.0;
        std::fs::create_dir(root)?;
        git(root, &["init", "-q"]).await?;
        let path = root.join("file.txt");
        std::fs::write(&path, b"abc\n")?;
        git(root, &["add", "."]).await?;
        git(
            root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "Initial",
            ],
        )
        .await?;
        std::fs::create_dir(root.join("nested"))?;
        assert!(
            capture(&root.join("nested"))
                .await
                .unwrap_err()
                .to_string()
                .contains("repository root")
        );
        let original = capture(root).await?;
        let time = std::fs::metadata(&path)?.modified()?;
        std::fs::write(&path, b"abd\n")?;
        std::fs::File::open(&path)?.set_times(std::fs::FileTimes::new().set_modified(time))?;
        assert_ne!(capture(root).await?["fingerprint"], original["fingerprint"]);
        git(root, &["update-index", "--assume-unchanged", "file.txt"]).await?;
        assert!(
            capture(root)
                .await
                .unwrap_err()
                .to_string()
                .contains("assume-unchanged")
        );
        git(root, &["update-index", "--no-assume-unchanged", "file.txt"]).await?;
        let new_file = root.join("new.txt");
        std::fs::write(&new_file, b"new")?;
        std::fs::set_permissions(&new_file, std::fs::Permissions::from_mode(0o600))?;
        let before_mode = capture(root).await?;
        std::fs::set_permissions(&new_file, std::fs::Permissions::from_mode(0o700))?;
        assert_ne!(
            capture(root).await?["fingerprint"],
            before_mode["fingerprint"]
        );
        symlink(&path, root.join("link"))?;
        assert!(
            capture(root)
                .await
                .unwrap_err()
                .to_string()
                .contains("non-regular")
        );
        Ok(())
    }
}
