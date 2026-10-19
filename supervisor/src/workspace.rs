//! Developer-operated task workspaces. Muse remains the agent execution authority.
use crate::{db::now_ms, review, worker::SharedDb};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio};
use tokio::{
    io::AsyncReadExt,
    time::{Duration, timeout},
};

#[cfg(unix)]
struct ProcessGroup(u32);
#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        unsafe {
            libc::kill(-(self.0 as i32), libc::SIGKILL);
        }
    }
}

pub fn idle(db: &SharedDb, row: &Value) -> Result<()> {
    ensure!(row["lifecycle"] != "archived", "Session is archived");
    ensure!(
        row["state"]["current"] == true,
        "Recover the session before changing its workspace"
    );
    ensure!(
        row["state"]["activeTurnId"].is_null(),
        "Wait for Muse to finish or cancel its turn"
    );
    ensure!(
        !db.lock()
            .unwrap()
            .test_running(row["id"].as_str().unwrap_or_default())?,
        "Wait for the test command to finish"
    );
    Ok(())
}

pub async fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut child = lascoria_runtime::command("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            lascoria_runtime::hooks_config(),
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(dunce::simplified(root))
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap().take(1024 * 1024 + 1);
    let mut stderr = child.stderr.take().unwrap().take(8193);
    let result = timeout(Duration::from_secs(8), async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        a?;
        b?;
        ensure!(
            out.len() <= 1024 * 1024 && err.len() <= 8192,
            "Git output exceeds budget"
        );
        let status = child.wait().await?;
        ensure!(
            status.success(),
            "Git operation failed: {}",
            String::from_utf8_lossy(&err)
        );
        Ok(String::from_utf8(out)?)
    })
    .await
    .context("Git operation timed out")?;
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

pub async fn create(source: &Path, target: &Path, session: &str) -> Result<Value> {
    let top = git(source, &["rev-parse", "--show-toplevel"]).await?;
    ensure!(
        std::fs::canonicalize(source)? == std::fs::canonicalize(top.trim())?,
        "Choose the repository root"
    );
    let base = git(source, &["rev-parse", "HEAD"])
        .await?
        .trim()
        .to_string();
    let branch = format!("lascoria/{}", session);
    let target_text = dunce::simplified(target)
        .to_str()
        .context("Workspace path must be UTF-8")?;
    git(
        source,
        &["worktree", "add", "-b", &branch, "--", target_text, &base],
    )
    .await?;
    Ok(json!({"source":source,"path":target,"branch":branch,"base":base}))
}

/// Before any state is written: every Project folder must be its repository's root, so a
/// session never half-starts with some folders isolated and others not.
pub async fn check_roots(folders: &[Value]) -> Result<()> {
    for folder in folders {
        let path = Path::new(
            folder["path"]
                .as_str()
                .context("Project folder path missing")?,
        );
        let name = folder["name"].as_str().unwrap_or("A Project folder");
        let top = git(path, &["rev-parse", "--show-toplevel"])
            .await
            .with_context(|| format!("{name} must be a Git repository root to be isolated"))?;
        ensure!(
            std::fs::canonicalize(path)? == std::fs::canonicalize(top.trim())?,
            "{name} must be a Git repository root to be isolated"
        );
        git(path, &["rev-parse", "--verify", "HEAD"])
            .await
            .with_context(|| format!("{name} needs at least one commit to be isolated"))?;
    }
    Ok(())
}

/// One isolated worktree per Project folder, on the same task branch name in each
/// repository. Every folder must be a repository root. If any folder fails, the worktrees and
/// branches already created for this session are removed again (they hold no commits yet),
/// so a failed start leaves the user's repositories as they were.
pub async fn create_project(folders: &[Value], parent: &Path, session: &str) -> Result<Vec<Value>> {
    let mut made: Vec<Value> = Vec::new();
    for (index, folder) in folders.iter().enumerate() {
        let source = Path::new(
            folder["path"]
                .as_str()
                .context("Project folder path missing")?,
        );
        let target = parent.join(format!("{session}-{}", index + 1));
        match create(source, &target, session).await {
            Ok(mut managed) => {
                managed["folderId"] = folder["id"].clone();
                managed["name"] = folder["name"].clone();
                made.push(managed);
            }
            Err(error) => {
                for managed in &made {
                    let source = Path::new(managed["source"].as_str().unwrap_or_default());
                    let path = managed["path"].as_str().unwrap_or_default();
                    let branch = managed["branch"].as_str().unwrap_or_default();
                    let _ = git(source, &["worktree", "remove", "--force", "--", path]).await;
                    let _ = git(source, &["branch", "-D", "--", branch]).await;
                }
                let name = folder["name"].as_str().unwrap_or("A Project folder");
                return Err(error.context(format!("{name} could not be isolated")));
            }
        }
    }
    Ok(made)
}

/// The view of a session that a workspace operation acts on. Without a folder this is the
/// session itself (its default folder). In a Project session a folder ID selects one of the
/// session's own folders, resolved here rather than taken from the client: its isolated
/// worktree when the session has them, otherwise the folder itself, which then has no
/// commit or discard controls.
pub fn scoped(row: &Value, folder: Option<&str>) -> Result<Value> {
    let Some(id) = folder else {
        return Ok(row.clone());
    };
    let project = row
        .get("projectContext")
        .filter(|p| p.is_object())
        .context("Only Project sessions have folders to choose")?;
    let entry = project["folders"]
        .as_array()
        .and_then(|folders| folders.iter().find(|f| f["id"] == id))
        .context("That folder is no longer part of this session's Project")?;
    let mut view = row.clone();
    match row["managedWorkspaces"].as_array() {
        Some(managed) => {
            let managed = managed
                .iter()
                .find(|m| m["folderId"] == id)
                .context("That folder has no isolated worktree in this session")?;
            view["workspace"] = managed["path"].clone();
            view["managedWorkspace"] = managed.clone();
        }
        None => {
            view["workspace"] = entry["path"].clone();
            view["managedWorkspace"] = Value::Null;
        }
    }
    view["folder"] = json!({"id":id,"name":entry["name"]});
    Ok(view)
}

/// Every worktree a session owns: one for a single-folder isolated task, one per folder for
/// an isolated Project session.
pub fn owned(row: &Value) -> Vec<Value> {
    match row["managedWorkspaces"].as_array() {
        Some(all) => all.clone(),
        None if row["managedWorkspace"].is_object() => vec![row["managedWorkspace"].clone()],
        None => Vec::new(),
    }
}

/// Discard needs the exact content the user saw in every worktree it removes: one
/// fingerprint for a single-folder task, one per folder ID for a Project session.
pub async fn confirm_discard(row: &Value, params: &Value) -> Result<()> {
    ensure!(
        row["managedWorkspace"].is_object() && params["confirmation"] == row["id"],
        "Confirm the current isolated workspace before discarding"
    );
    match row["managedWorkspaces"].as_array() {
        None => ensure!(
            inspect(row).await?["fingerprint"] == params["fingerprint"],
            "Changes moved; refresh before discarding"
        ),
        Some(all) => {
            for managed in all {
                let id = managed["folderId"].as_str().unwrap_or_default();
                let view = scoped(row, Some(id))?;
                ensure!(
                    params["fingerprints"][id].is_string()
                        && inspect(&view).await?["fingerprint"] == params["fingerprints"][id],
                    "Changes moved in {}; refresh before discarding",
                    managed["name"].as_str().unwrap_or("a folder")
                );
            }
        }
    }
    Ok(())
}

// Content identity is independent of whether a file is staged, untracked or deleted from the index.
async fn content_fingerprint(root: &Path) -> Result<String> {
    let root = std::fs::canonicalize(root)?;
    let head = git(&root, &["rev-parse", "HEAD"]).await?;
    let mut names = git(&root, &["ls-tree", "-r", "--name-only", "-z", "HEAD"]).await?;
    names.push_str(
        &git(
            &root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
            ],
        )
        .await?,
    );
    let mut paths: Vec<_> = names.split('\0').filter(|p| !p.is_empty()).collect();
    paths.sort_unstable();
    paths.dedup();
    ensure!(paths.len() <= 2200, "Workspace file count exceeds budget");
    let mut digest = Sha256::new();
    // Stable domain separator: changing branding must not invalidate existing previews/evidence.
    digest.update(b"weftara-workspace-v1");
    digest.update(head.as_bytes());
    let mut total = 0;
    for name in paths {
        digest.update((name.len() as u64).to_be_bytes());
        digest.update(name.as_bytes());
        let path = root.join(name);
        let meta = match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                digest.update(b"missing");
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        ensure!(
            meta.is_file()
                && !meta.file_type().is_symlink()
                && std::fs::canonicalize(&path)?.starts_with(&root),
            "Workspace contains a non-regular or external file"
        );
        let mut bytes = Vec::new();
        tokio::fs::File::open(&path)
            .await?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await?;
        total += bytes.len();
        ensure!(
            bytes.len() <= 1024 * 1024 && total <= 16 * 1024 * 1024,
            "Workspace content exceeds budget"
        );
        digest.update((lascoria_runtime::fingerprint_mode(&meta) & 0o111).to_be_bytes());
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(bytes);
    }
    Ok(format!(
        "sha256:{}",
        digest
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}

pub async fn inspect(row: &Value) -> Result<Value> {
    let root = Path::new(row["workspace"].as_str().context("Workspace missing")?);
    let capture = review::capture(root).await?;
    Ok(
        json!({"fingerprint":content_fingerprint(root).await?, "head":capture["head"], "patch":capture["patch"], "untracked":capture["untracked"], "branch":git(root, &["branch","--show-current"]).await?.trim(),"managed":row["managedWorkspace"]}),
    )
}

pub fn begin(
    db: &SharedDb,
    id: &str,
    operation: &str,
    params: &Value,
    session: &str,
) -> Result<Option<Value>> {
    let db = db.lock().unwrap();
    if let Some(previous) = db.get("commands", id)? {
        crate::db::same_request(&previous, operation, params)?;
        return Ok(Some(previous));
    }
    db.journal_admits()?;
    db.put("commands", id, &json!({"id":id,"operation":operation,"params":params,"sessionId":session,"status":"outcomeUnknown","createdAtMillis":now_ms()}))?;
    Ok(None)
}

pub fn finish(db: &SharedDb, id: &str, result: Result<Value>) -> Result<Value> {
    let db = db.lock().unwrap();
    let mut command = db.get("commands", id)?.context("Command missing")?;
    match result {
        Ok(value) => {
            command["status"] = json!("applied");
            command["result"] = value;
        }
        Err(error) => {
            command["status"] = json!("outcomeUnknown");
            command["error"] = json!({"message":error.to_string()});
        }
    }
    db.put("commands", id, &command)?;
    Ok(command)
}

pub async fn commit(row: &Value, params: &Value) -> Result<Value> {
    ensure!(
        row["managedWorkspace"].is_object(),
        "Commit is available only in isolated task workspaces"
    );
    let root = Path::new(row["workspace"].as_str().unwrap());
    let current = inspect(row).await?;
    ensure!(
        params["fingerprint"].is_string() && current["fingerprint"] == params["fingerprint"],
        "Changes moved; refresh the preview before committing"
    );
    let message = params["message"]
        .as_str()
        .context("Commit message required")?;
    ensure!(
        !message.trim().is_empty() && message.len() <= 4000,
        "Commit message must contain 1..4000 bytes"
    );
    ensure!(
        current["branch"] == row["managedWorkspace"]["branch"],
        "Task branch changed; commit refused"
    );
    ensure!(
        !current["patch"].as_str().unwrap_or("").is_empty()
            || current["untracked"]
                .as_array()
                .is_some_and(|a| !a.is_empty()),
        "No changes to commit"
    );
    git(root, &["add", "-A", "--", "."]).await?;
    // Recheck bytes after staging. An external writer can still race Git; never claim an atomic filesystem snapshot.
    ensure!(
        inspect(row).await?["fingerprint"] == params["fingerprint"],
        "Files changed while staging; inspect the index before retrying"
    );
    let output = git(root, &["commit", "-m", message]).await?;
    Ok(json!({"head":git(root,&["rev-parse","HEAD"]).await?.trim(),"output":output}))
}

pub async fn discard(row: &Value, params: &Value) -> Result<Value> {
    confirm_discard(row, params).await?;
    let mut removed = Vec::new();
    for managed in owned(row) {
        let source = Path::new(managed["source"].as_str().context("Source missing")?);
        let path = managed["path"].as_str().context("Worktree path missing")?;
        ensure!(
            row["managedWorkspaces"].is_array() || managed["path"] == row["workspace"],
            "Managed workspace identity mismatch"
        );
        git(source, &["worktree", "remove", "--force", "--", path]).await?;
        removed.push(json!({"removed":path,"retainedBranch":managed["branch"],"folderId":managed["folderId"]}));
    }
    // Keep the branches, including all commits. Never delete committed history as part of discard.
    Ok(
        if removed.len() == 1 && row["managedWorkspaces"].is_null() {
            removed.pop().unwrap()
        } else {
            json!({"removed":removed})
        },
    )
}

/// T2: the latest finished run of the same test command whose result still describes these
/// files: the folder's content fingerprint did not change during that run and is identical
/// now. Anything outside the folder (installed tools, services, network) is not covered, and
/// the UI says so. Read-only; returns `{"run": null}` when nothing can be reused.
pub async fn reusable(db: &SharedDb, row: &Value, params: &Value) -> Result<Value> {
    let command = params["command"]
        .as_str()
        .context("Test command required")?;
    ensure!(
        command.len() <= 4000,
        "Command must contain at most 4000 bytes"
    );
    let session = row["id"].as_str().context("Session missing")?;
    let candidate = db
        .lock()
        .unwrap()
        .commands_matching(
            "json_extract(value,'$.operation')='workspace/run' AND json_extract(value,'$.sessionId')=?1 \
             AND json_extract(value,'$.status')='applied' AND json_extract(value,'$.params.command')=?2 \
             AND json_extract(value,'$.result.contentUnchanged')=1 \
             AND json_extract(value,'$.result.outcome') IN ('passed','failed')",
            &[&session, &command],
        )?
        .into_iter()
        .max_by_key(|c| c["result"]["completedAtMillis"].as_u64().unwrap_or(0));
    let Some(run) = candidate else {
        return Ok(json!({"run": null}));
    };
    let now = content_fingerprint(Path::new(
        row["workspace"].as_str().context("Workspace missing")?,
    ))
    .await?;
    if run["result"]["endFingerprint"] != json!(now) {
        return Ok(json!({"run": null, "changedSince": run["result"]["completedAtMillis"]}));
    }
    Ok(json!({"run": {
        "id": run["id"],
        "command": command,
        "outcome": run["result"]["outcome"],
        "exitCode": run["result"]["exitCode"],
        "completedAtMillis": run["result"]["completedAtMillis"],
        "fingerprint": now,
        "stdout": run["result"]["stdout"],
        "stderr": run["result"]["stderr"],
    }}))
}

pub async fn run(db: SharedDb, row: Value, id: String, params: Value) -> Result<Value> {
    let command = params["command"]
        .as_str()
        .context("Test command required")?;
    ensure!(
        !command.trim().is_empty() && command.len() <= 4000,
        "Command must contain 1..4000 bytes"
    );
    let seconds = params
        .get("timeoutSeconds")
        .map(|v| v.as_u64().context("Deadline must be an integer"))
        .transpose()?
        .unwrap_or(120);
    ensure!(
        (1..=120).contains(&seconds),
        "Deadline must be 1..120 seconds"
    );
    let before = content_fingerprint(Path::new(row["workspace"].as_str().unwrap())).await?;
    #[cfg(unix)]
    let mut child = {
        let mut c = lascoria_runtime::command("/bin/sh");
        c.args(["-c", command]);
        c
    };
    #[cfg(windows)]
    let mut child = {
        let mut c = lascoria_runtime::command(std::env::current_exe()?);
        c.args(["--workspace-job", command]);
        c
    };
    child
        .current_dir(row["workspace"].as_str().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    child.stdin(Stdio::piped());
    // Each platform owns the complete test process tree, including detached descendants.
    #[cfg(unix)]
    child.process_group(0);
    let mut child = child.spawn()?;
    #[cfg(unix)]
    let group = ProcessGroup(child.id().context("Test process ID missing")?);
    #[cfg(windows)]
    let group = lascoria_runtime::process::ProcessTree::new(&mut child)?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    {
        let db = db.lock().unwrap();
        let mut record = db.get("commands", &id)?.context("Command missing")?;
        record["status"] = json!("running");
        record["result"] = json!({"command":command,"startedAtMillis":now_ms(),"fingerprint":before,"stdout":"","stderr":"","provenance":"developerExecuted"});
        db.put("commands", &id, &record)?;
    }
    let result = db.lock().unwrap().get("commands", &id)?.unwrap();
    tokio::spawn(async move {
        let readers = async {
            let a = stream(db.clone(), id.clone(), "stdout", out);
            let b = stream(db.clone(), id.clone(), "stderr", err);
            let (_, _, status) =
                tokio::try_join!(a, b, async { Ok::<_, anyhow::Error>(child.wait().await?) })?;
            Ok::<_, anyhow::Error>(status)
        };
        let outcome = timeout(Duration::from_secs(seconds), readers).await;
        // Clean up descendants even if the shell exited while a detached child kept its pipes open.
        drop(group);
        let _ = child.wait().await;
        let after = content_fingerprint(Path::new(row["workspace"].as_str().unwrap())).await;
        let db = db.lock().unwrap();
        if let Ok(Some(mut record)) = db.get("commands", &id) {
            record["status"] = json!("applied");
            record["result"]["completedAtMillis"] = json!(now_ms());
            match outcome {
                Ok(Ok(status)) => {
                    record["result"]["exitCode"] = json!(status.code());
                    record["result"]["outcome"] =
                        json!(if status.success() { "passed" } else { "failed" });
                }
                Ok(Err(error)) => {
                    record["result"]["outcome"] = json!("failed");
                    record["result"]["error"] = json!(error.to_string());
                }
                Err(_) => {
                    record["result"]["outcome"] = json!("timedOut");
                }
            }
            record["result"]["contentUnchanged"] =
                json!(after.as_ref().is_ok_and(|a| *a == before));
            record["result"]["endFingerprint"] = after.map(Value::String).unwrap_or(Value::Null);
            let _ = db.put("commands", &id, &record);
        }
    });
    Ok(result)
}

async fn stream(
    db: SharedDb,
    id: String,
    field: &str,
    mut input: impl tokio::io::AsyncRead + Unpin,
) -> Result<()> {
    let mut buffer = [0; 4096];
    let mut bytes = Vec::new();
    loop {
        let count = input.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
        ensure!(
            bytes.len() <= 65536,
            "Test output exceeds 64 KiB per stream"
        );
        let db = db.lock().unwrap();
        let mut record = db.get("commands", &id)?.context("Test record missing")?;
        record["result"][field] = json!(String::from_utf8_lossy(&bytes));
        db.put("commands", &id, &record)?;
    }
    Ok(())
}

/// Opens `path` without following a final link and confirms, from the open handle, that the
/// file is a regular file inside `root` (canonical).
fn open_contained(root: &Path, path: &Path) -> Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).context("File is unavailable")?;
    let real = lascoria_runtime::platform::opened_path(&file)?;
    ensure!(
        real.starts_with(root) && file.metadata()?.is_file(),
        "File must remain inside the repository"
    );
    Ok(file)
}

pub async fn files(row: &Value, params: &Value) -> Result<Value> {
    let root = std::fs::canonicalize(row["workspace"].as_str().context("Workspace missing")?)?;
    if let Some(path) = params["path"].as_str() {
        ensure!(
            !path.is_empty()
                && !Path::new(path).is_absolute()
                && Path::new(path)
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
            "Use a repository-relative file path"
        );
        let file = std::fs::canonicalize(root.join(path))?;
        ensure!(
            file.starts_with(&root)
                && !std::fs::symlink_metadata(root.join(path))?
                    .file_type()
                    .is_symlink(),
            "File must remain inside the repository"
        );
        // Only Git-visible files can be supplied as context. Ignored secrets are not browsable.
        let listed = git(
            &root,
            &[
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                path,
            ],
        )
        .await?;
        ensure!(
            listed.split('\0').any(|p| p == path),
            "File is not Git-visible"
        );
        // Open first, then check where the opened file really is: a directory swapped for a
        // link after the checks above cannot redirect the read outside the repository (F3).
        let opened = open_contained(&root, &root.join(path))?;
        let mut input = tokio::fs::File::from_std(opened).take(65537);
        let mut bytes = Vec::new();
        input.read_to_end(&mut bytes).await?;
        ensure!(
            bytes.len() <= 65536 && !bytes.contains(&0),
            "File is binary or exceeds 64 KiB"
        );
        return Ok(json!({"path":path,"text":String::from_utf8(bytes)?}));
    }
    let names = git(
        &root,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
    )
    .await?;
    let query = params["query"].as_str().unwrap_or("").to_lowercase();
    let mut paths: Vec<_> = names
        .split('\0')
        .filter(|p| !p.is_empty() && p.to_lowercase().contains(&query))
        .collect();
    paths.sort_unstable();
    paths.dedup();
    let truncated = paths.len() > 200;
    paths.truncate(200);
    Ok(json!({"paths":paths,"truncated":truncated}))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn reads_are_checked_against_the_opened_file_not_the_checked_path() -> Result<()> {
        let base = std::env::temp_dir().join(format!("lascoria-f3-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("src"))?;
        std::fs::create_dir_all(&outside)?;
        std::fs::write(root.join("src/ok.txt"), "inside")?;
        std::fs::write(outside.join("ok.txt"), "secret")?;
        let root = std::fs::canonicalize(&root)?;
        let result = (|| {
            assert!(open_contained(&root, &root.join("src/ok.txt")).is_ok());
            // The race F3 describes, made permanent: an intermediate directory is now a link.
            std::fs::rename(root.join("src"), root.join("src-old"))?;
            std::os::unix::fs::symlink(&outside, root.join("src"))?;
            let error = open_contained(&root, &root.join("src/ok.txt")).unwrap_err();
            assert!(
                error.to_string().contains("inside the repository"),
                "{error}"
            );
            // A final-component link is refused outright.
            std::os::unix::fs::symlink(outside.join("ok.txt"), root.join("link.txt"))?;
            assert!(open_contained(&root, &root.join("link.txt")).is_err());
            Ok(())
        })();
        let _ = std::fs::remove_dir_all(&base);
        result
    }

    async fn repo(path: &Path, file: &str) -> Result<()> {
        std::fs::create_dir_all(path)?;
        git(path, &["init", "-q"]).await?;
        std::fs::write(path.join(file), "one\n")?;
        git(path, &["add", "."]).await?;
        git(
            path,
            &[
                "-c",
                "user.name=F",
                "-c",
                "user.email=f@example.test",
                "commit",
                "-qm",
                "init",
            ],
        )
        .await?;
        Ok(())
    }

    #[tokio::test]
    async fn project_worktrees_are_per_folder_scoped_by_id_and_rolled_back_on_failure() -> Result<()>
    {
        let base = std::fs::canonicalize(std::env::temp_dir())?
            .join(format!("lascoria-pw-{}", uuid::Uuid::new_v4()));
        let (app, api, plain) = (base.join("app"), base.join("api"), base.join("plain"));
        repo(&app, "app.txt").await?;
        repo(&api, "api.txt").await?;
        std::fs::create_dir_all(&plain)?;
        let parent = base.join("worktrees");
        std::fs::create_dir_all(&parent)?;
        let result = async {
            // A folder that is not a repository: nothing is left behind in the others.
            let bad = [
                json!({"id":"a","name":"App","path":app}),
                json!({"id":"p","name":"Plain","path":plain}),
            ];
            let error = create_project(&bad, &parent, "s1").await.unwrap_err();
            assert!(format!("{error:#}").contains("Plain could not be isolated"), "{error:#}");
            assert!(!parent.join("s1-1").exists(), "the App worktree was removed again");
            assert!(git(&app, &["branch", "--list", "lascoria/s1"]).await?.trim().is_empty());

            let folders = [
                json!({"id":"a","name":"App","path":app}),
                json!({"id":"b","name":"API","path":api}),
            ];
            let made = create_project(&folders, &parent, "s2").await?;
            assert_eq!(made.len(), 2);
            assert_eq!(made[1]["folderId"], "b");
            let row = json!({"id":"s2","workspace":made[0]["path"],"managedWorkspace":made[0],"managedWorkspaces":made,"projectContext":{"folders":folders}});
            // Edits in one worktree do not show in the other or in the original checkout.
            std::fs::write(parent.join("s2-2").join("api.txt"), "two\n")?;
            let api_view = scoped(&row, Some("b"))?;
            assert_eq!(api_view["managedWorkspace"]["source"], json!(api));
            let api_changes = inspect(&api_view).await?;
            assert!(api_changes["patch"].as_str().unwrap().contains("api.txt"));
            assert!(inspect(&scoped(&row, Some("a"))?).await?["patch"].as_str().unwrap().is_empty());
            assert!(git(&api, &["status", "--porcelain"]).await?.trim().is_empty());
            assert!(scoped(&row, Some("elsewhere")).is_err());
            // Committing in API commits on API's task branch only.
            let committed = commit(
                &api_view,
                &json!({"fingerprint":api_changes["fingerprint"],"message":"API change"}),
            )
            .await?;
            assert!(committed["head"].is_string());
            assert_eq!(
                git(&api, &["log", "-1", "--format=%s", "lascoria/s2"]).await?.trim(),
                "API change"
            );
            assert_eq!(git(&app, &["log", "-1", "--format=%s", "lascoria/s2"]).await?.trim(), "init");
            // Discard needs every folder's current fingerprint and keeps both branches.
            let mut fingerprints = serde_json::Map::new();
            for id in ["a", "b"] {
                fingerprints.insert(id.into(), inspect(&scoped(&row, Some(id))?).await?["fingerprint"].clone());
            }
            let mut stale = fingerprints.clone();
            stale.insert("a".into(), json!("sha256:old"));
            assert!(discard(&row, &json!({"confirmation":"s2","fingerprints":stale})).await.is_err());
            let removed = discard(&row, &json!({"confirmation":"s2","fingerprints":fingerprints})).await?;
            assert_eq!(removed["removed"].as_array().unwrap().len(), 2);
            assert!(!parent.join("s2-1").exists() && !parent.join("s2-2").exists());
            assert_eq!(git(&api, &["log", "-1", "--format=%s", "lascoria/s2"]).await?.trim(), "API change");
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&base);
        result
    }
}
