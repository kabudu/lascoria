//! Developer-operated task workspaces. Muse remains the agent execution authority.
use crate::{db::now_ms, review, worker::SharedDb};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::os::unix::fs::PermissionsExt;
use std::{path::Path, process::Stdio};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{Duration, timeout},
};

struct ProcessGroup(u32);
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
            .all("commands")?
            .iter()
            .any(|c| c["sessionId"] == row["id"]
                && c["operation"] == "workspace/run"
                && c["status"] == "running"),
        "Wait for the test command to finish"
    );
    Ok(())
}

pub async fn git(root: &Path, args: &[&str]) -> Result<String> {
    let mut child = Command::new("git")
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(root)
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
    let target_text = target.to_str().context("Workspace path must be UTF-8")?;
    git(
        source,
        &["worktree", "add", "-b", &branch, "--", target_text, &base],
    )
    .await?;
    Ok(json!({"source":source,"path":target,"branch":branch,"base":base}))
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
        digest.update((meta.permissions().mode() & 0o111).to_be_bytes());
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
        ensure!(
            previous["operation"] == operation && previous["params"] == *params,
            "Request ID reused with different payload"
        );
        return Ok(Some(previous));
    }
    ensure!(
        db.count("commands")? < 2000,
        "Command journal limit reached"
    );
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
    let managed = &row["managedWorkspace"];
    ensure!(
        managed.is_object(),
        "Only harness-created worktrees can be discarded"
    );
    ensure!(
        params["confirmation"] == row["id"],
        "Discard must confirm the exact session ID"
    );
    ensure!(
        params["fingerprint"].is_string()
            && inspect(row).await?["fingerprint"] == params["fingerprint"],
        "Changes moved; refresh before discarding"
    );
    let source = Path::new(managed["source"].as_str().context("Source missing")?);
    let path = row["workspace"].as_str().unwrap();
    ensure!(
        managed["path"] == path,
        "Managed workspace identity mismatch"
    );
    git(source, &["worktree", "remove", "--force", "--", path]).await?;
    // Keep the branch, including all commits. Never delete committed history as part of discard.
    Ok(json!({"removed":path,"retainedBranch":managed["branch"]}))
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
    let mut child = Command::new("/bin/sh");
    child
        .args(["-c", command])
        .current_dir(row["workspace"].as_str().unwrap())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A separate process group lets deadlines terminate test descendants too.
    child.process_group(0);
    let mut child = child.spawn()?;
    let pid = child.id().context("Test process ID missing")?;
    let group = ProcessGroup(pid);
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
        let mut input = tokio::fs::File::open(file).await?.take(65537);
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
