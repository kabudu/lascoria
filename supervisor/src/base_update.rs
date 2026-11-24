//! A PR base update stays inside its isolated task worktree and uses Git's merge metadata.
use crate::{delivery, git, staging::Rejected, worker::SharedDb, workspace};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn root(row: &Value) -> Result<&Path> {
    ensure!(
        row["managedWorkspace"].is_object(),
        "PR updates require an isolated task worktree"
    );
    workspace::check_trusted_root(row)?;
    Ok(Path::new(
        row["workspace"].as_str().context("Worktree missing")?,
    ))
}

async fn read(root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8(
        git::run(root, args, Duration::from_secs(5), true).await?,
    )?)
}

async fn run(root: &Path, args: &[&str]) -> Result<()> {
    let mut command = vec![
        "-c",
        "rerere.enabled=false",
        "-c",
        "merge.autoStash=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "submodule.recurse=false",
    ];
    command.extend_from_slice(args);
    git::run(root, &command, Duration::from_secs(12), false).await?;
    Ok(())
}

async fn git_path(root: &Path, file: &str) -> Result<PathBuf> {
    let name = read(
        root,
        &["rev-parse", "--path-format=absolute", "--git-path", file],
    )
    .await?;
    let path = PathBuf::from(name.trim_end_matches(['\r', '\n']));
    ensure!(
        path.is_absolute(),
        "Git returned an invalid administrative path"
    );
    Ok(path)
}

fn valid_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

async fn merge_head(root: &Path) -> Result<Option<String>> {
    let path = git_path(root, "MERGE_HEAD").await?;
    match tokio::fs::symlink_metadata(&path).await {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(meta) => {
            ensure!(
                meta.is_file() && meta.len() <= 128,
                "Unsupported pending merge"
            );
            let data = tokio::fs::read_to_string(path).await?;
            let sha = data.trim();
            ensure!(valid_sha(sha), "Unsupported pending merge");
            Ok(Some(sha.to_owned()))
        }
        Err(error) => Err(error.into()),
    }
}

async fn guards(root: &Path) -> Result<()> {
    for flag in [
        "rebase-merge",
        "rebase-apply",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "sequencer",
        "MERGE_AUTOSTASH",
    ] {
        ensure!(
            !git_path(root, flag).await?.try_exists()?,
            "Finish the existing Git operation first"
        );
    }
    // An attributes entry can select a configured external custom merge driver.
    // Ask for the full set of keys with a command that succeeds even for an empty config.
    let names = read(root, &["config", "--null", "--name-only", "--list"]).await?;
    ensure!(
        !names
            .split('\0')
            .any(|key| key.starts_with("merge.") && key.ends_with(".driver")),
        "This repository configures a custom merge driver. Use your Git client for this update."
    );
    ensure!(
        !names.split('\0').any(|key| key == "core.worktree"),
        "This repository overrides its Git worktree. Use your Git client."
    );
    Ok(())
}

async fn branch_head(root: &Path, row: &Value) -> Result<String> {
    ensure!(
        read(root, &["branch", "--show-current"]).await?.trim()
            == row["managedWorkspace"]["branch"]
                .as_str()
                .unwrap_or_default(),
        "The worktree is no longer on its task branch"
    );
    Ok(read(root, &["rev-parse", "HEAD"]).await?.trim().to_owned())
}

async fn clean(root: &Path) -> Result<()> {
    ensure!(
        merge_head(root).await?.is_none(),
        "Finish or abort the pending merge first"
    );
    ensure!(
        read(
            root,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"]
        )
        .await?
        .is_empty(),
        "Commit or move your local changes before updating from the PR base"
    );
    Ok(())
}

fn paths(value: &str) -> Result<Vec<&str>> {
    let paths = value
        .split('\0')
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>();
    ensure!(
        paths.len() <= 128 && paths.iter().all(|name| name.len() <= 512),
        "Too many affected paths; use your Git client"
    );
    Ok(paths)
}

async fn merge_revision(root: &Path, head: &str, incoming: &str) -> Result<String> {
    let index = read(root, &["ls-files", "--stage", "-z"]).await?;
    let files = workspace::content_fingerprint(root).await?;
    let mut hash = Sha256::new();
    for value in [head, incoming, &files, &index] {
        hash.update((value.len() as u64).to_be_bytes());
        hash.update(value.as_bytes());
    }
    Ok(format!(
        "sha256:{}",
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

pub async fn has_merge(row: &Value) -> Result<bool> {
    if !row["managedWorkspace"].is_object() {
        return Ok(false);
    }
    Ok(merge_head(root(row)?).await?.is_some())
}

/// A managed base update invalidates validation until this exact new revision passes.
pub async fn needs_check(db: &SharedDb, row: &Value, folder: Option<&str>) -> Result<bool> {
    let session = row["id"].as_str().context("Session required")?;
    let (merge, test, push) = {
        let db = db.lock().unwrap();
        (
            db.base_update_receipt(session, folder, true)?,
            db.latest_folder_command("workspace/run", session, folder)?,
            db.latest_folder_command("workspace/push", session, folder)?,
        )
    };
    let Some(merge) = merge else { return Ok(false) };
    if let (Some(push), Some(head)) = (
        push.as_ref(),
        merge["result"]["head"]
            .as_str()
            .filter(|head| valid_sha(head)),
    ) && push["status"] == "applied"
        && push["result"]["head"].as_str().is_some_and(valid_sha)
        && git::run(
            root(row)?,
            &[
                "merge-base",
                "--is-ancestor",
                head,
                push["result"]["head"].as_str().unwrap(),
            ],
            Duration::from_secs(5),
            true,
        )
        .await
        .is_ok()
    {
        return Ok(false);
    }
    // A lost result after Git committed remains a reason to recheck.
    let Some(test) = test.filter(|test| {
        test["status"] == "applied"
            && test["result"]["outcome"] == "passed"
            && test["result"]["contentUnchanged"] == true
            && test["result"]["startedAtMillis"].as_i64() > merge["createdAtMillis"].as_i64()
    }) else {
        return Ok(true);
    };
    let fingerprint = workspace::content_fingerprint(root(row)?).await?;
    Ok(test["result"]["endFingerprint"] != fingerprint)
}

pub async fn preview(row: &Value, params: &Value) -> Result<Value> {
    let root = root(row)?;
    guards(root).await?;
    clean(root).await?;
    let mut target = delivery::base_target(row, params, true).await?;
    let head = target["head"].as_str().unwrap();
    let base = target["baseHead"].as_str().unwrap();
    let common = read(root, &["merge-base", head, base]).await?;
    ensure!(
        common.trim() != base,
        "This task already contains the observed base"
    );
    let changed = read(
        root,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "-z",
            common.trim(),
            base,
            "--",
        ],
    )
    .await?;
    let commits = read(
        root,
        &[
            "log",
            "-n21",
            "--format=%h %s",
            base,
            &format!("^{head}"),
            "--",
        ],
    )
    .await?;
    let commits = commits.lines().collect::<Vec<_>>();
    target["paths"] = json!(paths(&changed)?);
    target["commits"] = json!(
        commits
            .iter()
            .take(20)
            .map(|s| s.chars().take(250).collect::<String>())
            .collect::<Vec<_>>()
    );
    target["moreCommits"] = json!(commits.len() > 20);
    ensure!(
        serde_json::to_vec(&target)?.len() <= 48_000,
        "This review exceeds the confirmation budget. Use your Git client."
    );
    Ok(target)
}

pub async fn status(db: &SharedDb, row: &Value, folder: Option<&str>) -> Result<Value> {
    let root = root(row)?;
    let Some(incoming) = merge_head(root).await? else {
        return Ok(Value::Null);
    };
    let head = branch_head(root, row).await?;
    let command = db.lock().unwrap().base_update_receipt(
        row["id"].as_str().context("Session required")?,
        folder,
        false,
    )?;
    let owned = command.as_ref().is_some_and(|command| {
        command["operation"] == "workspace/baseApply"
            && command["params"]["preview"]["head"] == head
            && command["params"]["preview"]["baseHead"] == incoming
            && command["status"] != "rejected"
    });
    let unmerged = read(
        root,
        &[
            "diff",
            "--no-renames",
            "--name-only",
            "--diff-filter=U",
            "-z",
            "--",
        ],
    )
    .await?;
    let unstaged = read(root, &["diff", "--no-renames", "--name-only", "-z", "--"]).await?;
    let conflicts = paths(&unmerged)?;
    let staged_patch = if owned && conflicts.is_empty() {
        read(
            root,
            &[
                "diff",
                "--cached",
                "--no-ext-diff",
                "--no-textconv",
                "--no-renames",
                "HEAD",
                "--",
            ],
        )
        .await
        .ok()
        .filter(|patch| patch.len() <= 16_384)
    } else {
        None
    };
    Ok(json!({
        "owned":owned, "head":head,"baseHead":incoming,
        "baseBranch":command.as_ref().map(|v| &v["params"]["preview"]["baseBranch"]),
        "conflicts":conflicts,"unstaged":paths(&unstaged)?,"stagedPatch":staged_patch,
        "revision":if owned {Some(merge_revision(root, &head, &incoming).await?)}else{None},
        "staged":if owned {paths(&read(root,&["diff","--cached","--no-renames","--name-only","-z","HEAD","--"]).await?)?.iter().map(|s|s.to_string()).collect::<Vec<_>>()}else{Vec::new()}
    }))
}

pub async fn apply(db: &SharedDb, row: &Value, params: &Value) -> Result<Value> {
    let root = root(row)?;
    let reviewed = &params["preview"];
    // Re-observe the GitHub identity and base. Preview did the bounded fetch already.
    let allowed = async {
        guards(root).await?;
        let current = delivery::base_target(row, reviewed, false).await?;
        ensure!(
            current
                .as_object()
                .unwrap()
                .iter()
                .all(|(key, value)| *value == reviewed[key]),
            "The pull request or base changed. Review a new preview."
        );
        clean(root).await?;
        ensure!(
            branch_head(root, row).await? == reviewed["head"],
            "The task branch changed"
        );
        Ok::<_, anyhow::Error>(())
    }
    .await;
    allowed.map_err(|error| Rejected(error.to_string()))?;
    let sha = reviewed["baseHead"]
        .as_str()
        .context("Missing reviewed base")?;
    let result = run(
        root,
        &[
            "merge",
            "--no-ff",
            "--no-commit",
            "--no-edit",
            "--no-autostash",
            "--no-overwrite-ignore",
            "-s",
            "ort",
            "--",
            sha,
        ],
    )
    .await;
    let pending = status(db, row, params["folderId"].as_str()).await?;
    if pending["owned"] == true {
        return Ok(
            json!({"head":pending["head"],"baseHead":pending["baseHead"],
            "conflicts":pending["conflicts"].as_array().map(Vec::len),"mergePending":true}),
        );
    }
    result?;
    anyhow::bail!("No pending merge was recorded. Refresh the workspace before retrying.")
}

pub async fn change(db: &SharedDb, row: &Value, params: &Value, operation: &str) -> Result<Value> {
    let root = root(row)?;
    let pending = async {
        guards(root).await?;
        let pending = status(db, row, params["folderId"].as_str()).await?;
        ensure!(
            pending["owned"] == true
                && pending["revision"].is_string()
                && pending["revision"] == params["revision"],
            "The pending update changed. Refresh and review it again."
        );
        Ok::<_, anyhow::Error>(pending)
    }
    .await
    .map_err(|error| Rejected(error.to_string()))?;
    match operation {
        "workspace/baseAbort" => run(root, &["merge", "--abort"]).await?,
        "workspace/baseStage" => {
            let chosen = params["path"].as_str().context("Choose a conflict file")?;
            ensure!(
                pending["conflicts"]
                    .as_array()
                    .is_some_and(|files| files.iter().any(|v| v == chosen)),
                "The selected file is not a current conflict"
            );
            // Restrict Git to the selected conflict and reject unresolved marker lines.
            // A developer can use their Git client for a deliberate marker or whitespace edit.
            let checked = git::run_with(
                root,
                &[
                    "diff",
                    "--check",
                    "--no-ext-diff",
                    "--no-textconv",
                    "HEAD",
                    "--",
                    chosen,
                ],
                Duration::from_secs(5),
                git::Options {
                    read_only: true,
                    literal_pathspecs: true,
                    ..git::Options::default()
                },
            )
            .await;
            checked.map_err(|_| {
                Rejected(
                    "Remove conflict markers or whitespace errors before staging this file.".into(),
                )
            })?;
            git::run_with(
                root,
                &["add", "-u", "--", chosen],
                Duration::from_secs(8),
                git::Options {
                    literal_pathspecs: true,
                    ..git::Options::default()
                },
            )
            .await?;
        }
        "workspace/baseFinish" => {
            ensure!(
                pending["unstaged"].as_array().is_some_and(Vec::is_empty)
                    && pending["conflicts"].as_array().is_some_and(Vec::is_empty),
                "Resolve and stage the conflict files before committing"
            );
            let message = format!(
                "Merge PR base {}",
                pending["baseBranch"]
                    .as_str()
                    .context("Missing base branch")?
            );
            run(
                root,
                &["commit", "--no-edit", "--no-gpg-sign", "-m", &message],
            )
            .await?;
        }
        _ => anyhow::bail!("Unsupported base update action"),
    }
    Ok(
        json!({"head":branch_head(root,row).await?,"mergePending":merge_head(root).await?.is_some()}),
    )
}
