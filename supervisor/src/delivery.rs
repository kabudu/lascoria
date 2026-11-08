//! Review to delivery for one isolated task worktree: whether the current files are validated,
//! what is committed, where the task branch would be pushed, which commits would leave this
//! machine and whether a pull request already exists.
//!
//! Status is read-only. Push and pull-request creation are explicit, revision-bound commands
//! that run in the background with bounded deadlines. Each first checks what the remote
//! already has, so a retry after a lost acknowledgement never pushes or opens a duplicate.
//! Git and the GitHub CLI use the user's own credential helpers and sign-in; Lascoria never
//! reads, stores or returns a credential, and every URL or message is stripped of user
//! information before it leaves this module.
use crate::{
    db::now_ms,
    git,
    staging::Rejected,
    worker::SharedDb,
    workspace::{self, files_fingerprint},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::LazyLock,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Semaphore,
    time::{Duration, timeout},
};

/// Local Git reads.
const LOCAL: Duration = Duration::from_secs(10);
/// A remote query (`ls-remote`, `gh pr list`).
const QUERY: Duration = Duration::from_secs(20);
/// `git push` and `gh pr create`.
const SEND: Duration = Duration::from_secs(60);
/// Outgoing commits listed in full; the total is always counted.
const MAX_COMMITS: usize = 50;
const MAX_REMOTES: usize = 20;
/// Remote queries from status refreshes, across every window and session.
static REMOTE_QUERIES: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(2));

fn reject(message: impl Into<String>) -> anyhow::Error {
    Rejected(message.into()).into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Removes user information (a user name, password or token) from every URL in `text`, so
/// neither a remote's configured URL nor an error that repeats it can expose a credential.
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("://") {
        let (head, tail) = rest.split_at(at + 3);
        out.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || c == '/' || c == '\'' || c == '"')
            .unwrap_or(tail.len());
        let authority = &tail[..end];
        out.push_str(
            authority
                .rsplit_once('@')
                .map_or(authority, |(_, host)| host),
        );
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

/// `owner/name` for a github.com remote in any of its usual URL forms.
pub fn github_repository(url: &str) -> Option<String> {
    let url = redact(url);
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("ssh://github.com/"))
        .or_else(|| url.strip_prefix("ssh://github.com:22/"))
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("github.com:"))?;
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let valid = |s: &str| {
        !s.is_empty()
            && s.len() <= 100
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && s != "."
            && s != ".."
    };
    (valid(owner) && valid(name)).then(|| format!("{owner}/{name}"))
}

fn host(url: &str) -> String {
    let url = redact(url);
    let rest = url.split_once("://").map_or(url.as_str(), |(_, r)| r);
    let rest = rest.rsplit_once('@').map_or(rest, |(_, r)| r);
    rest.split(['/', ':'])
        .next()
        .unwrap_or_default()
        .chars()
        .take(255)
        .collect()
}

async fn read(root: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8(git::run(root, args, LOCAL, true).await?)?)
}

async fn optional(root: &Path, args: &[&str]) -> Option<String> {
    read(root, args)
        .await
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
}

/// Network Git: never prompts on a terminal, and SSH fails instead of asking for a passphrase,
/// unless the user configured their own SSH command. Credential helpers still apply.
async fn network(root: &Path, args: &[&str], deadline: Duration) -> Result<String> {
    let custom_ssh = std::env::var_os("GIT_SSH_COMMAND").is_some()
        || std::env::var_os("GIT_SSH").is_some()
        || optional(root, &["config", "--get", "core.sshCommand"])
            .await
            .is_some();
    let mut full = Vec::new();
    if !custom_ssh {
        full.extend(["-c", "core.sshCommand=ssh -o BatchMode=yes"]);
    }
    full.extend_from_slice(args);
    git::run(root, &full, deadline, false)
        .await
        .map(|out| String::from_utf8_lossy(&out).into_owned())
        .map_err(|e| anyhow::anyhow!(redact(&format!("{e:#}"))))
}

struct Remote {
    name: String,
    /// Where a push goes (the push URL when one is configured).
    url: String,
    /// The fetch URL, which names the hosted repository.
    fetch: String,
}

async fn remotes(root: &Path) -> Result<Vec<Remote>> {
    let mut all = Vec::new();
    for name in read(root, &["remote"])
        .await?
        .lines()
        .filter(|n| !n.is_empty())
    {
        ensure!(
            all.len() < MAX_REMOTES,
            "This repository has too many remotes"
        );
        let url = read(root, &["remote", "get-url", "--push", "--", name])
            .await?
            .trim()
            .to_owned();
        let fetch = read(root, &["remote", "get-url", "--", name])
            .await?
            .trim()
            .to_owned();
        all.push(Remote {
            name: name.to_owned(),
            url,
            fetch,
        });
    }
    Ok(all)
}

/// The remote a task branch goes to: one configured for the branch, else `origin`, else the
/// only remote. With several and none preferred the user chooses.
fn preferred<'a>(all: &'a [Remote], configured: Option<&str>) -> Option<&'a Remote> {
    configured
        .and_then(|name| all.iter().find(|r| r.name == name))
        .or_else(|| all.iter().find(|r| r.name == "origin"))
        .or_else(|| (all.len() == 1).then(|| &all[0]))
}

fn root_of(row: &Value) -> Result<PathBuf> {
    ensure!(
        row["managedWorkspace"].is_object(),
        "Delivery is available in isolated task worktrees. Use your Git client for this checkout"
    );
    Ok(PathBuf::from(
        row["workspace"].as_str().context("Workspace missing")?,
    ))
}

/// The local state one delivery action is bound to: the worktree, task branch, commit and
/// destination. Remote state is rechecked by the action itself.
fn revision(root: &Path, branch: &str, head: &str, remote: &str, url: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"lascoria-delivery-v1");
    for part in [
        root.to_string_lossy().as_bytes(),
        branch.as_bytes(),
        head.as_bytes(),
        remote.as_bytes(),
        url.as_bytes(),
    ] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("sha256:{}", hex(&digest.finalize()))
}

struct Local {
    root: PathBuf,
    branch: String,
    head: String,
    base: String,
    remotes: Vec<Remote>,
    remote: Option<usize>,
}

async fn local(row: &Value, chosen: Option<&str>) -> Result<Local> {
    let root = root_of(row)?;
    let branch = read(&root, &["branch", "--show-current"])
        .await?
        .trim()
        .to_owned();
    let expected = row["managedWorkspace"]["branch"]
        .as_str()
        .unwrap_or_default();
    if branch != expected {
        return Err(reject(format!(
            "This worktree is on {}, not its task branch {expected}. Switch back with your Git client to deliver from here",
            if branch.is_empty() {
                "a detached commit"
            } else {
                &branch
            }
        )));
    }
    let head = read(&root, &["rev-parse", "HEAD"]).await?.trim().to_owned();
    let base = row["managedWorkspace"]["base"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let remotes = remotes(&root).await?;
    let configured = optional(
        &root,
        &["config", "--get", &format!("branch.{branch}.remote")],
    )
    .await;
    let remote = match chosen {
        Some(name) => Some(remotes.iter().position(|r| r.name == name).ok_or_else(|| {
            reject(format!(
                "The remote {name} is no longer configured. Nothing was changed"
            ))
        })?),
        None => preferred(&remotes, configured.as_deref())
            .and_then(|r| remotes.iter().position(|x| std::ptr::eq(x, r))),
    };
    Ok(Local {
        root,
        branch,
        head,
        base,
        remotes,
        remote,
    })
}

/// The remote branch's commit, `None` when the branch does not exist there.
/// Asks the push destination itself, which is where a push would land.
async fn remote_head(root: &Path, remote: &Remote, branch: &str) -> Result<Option<String>> {
    let out = network(
        root,
        &[
            "ls-remote",
            "--heads",
            "--",
            &remote.url,
            &format!("refs/heads/{branch}"),
        ],
        QUERY,
    )
    .await
    .with_context(|| format!("Could not reach {}", remote.name))?;
    Ok(out
        .lines()
        .find_map(|line| {
            line.split_once('\t')
                .filter(|(_, r)| *r == format!("refs/heads/{branch}"))
        })
        .map(|(sha, _)| sha.to_owned()))
}

async fn has_commit(root: &Path, sha: &str) -> bool {
    read(root, &["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .await
        .is_ok()
}

async fn is_ancestor(root: &Path, ancestor: &str, head: &str) -> bool {
    git::run(
        root,
        &["merge-base", "--is-ancestor", ancestor, head],
        LOCAL,
        true,
    )
    .await
    .is_ok()
}

/// Commits on HEAD that `exclude` lacks: what a push would send.
async fn outgoing(root: &Path, exclude: &str) -> Result<(usize, Vec<Value>)> {
    let range = format!("^{exclude}");
    let total: usize = read(root, &["rev-list", "--count", "HEAD", &range, "--"])
        .await?
        .trim()
        .parse()?;
    let limit = format!("-n{MAX_COMMITS}");
    let log = read(
        root,
        &[
            "log",
            &limit,
            "--format=%H%x1f%s%x1f%an%x1f%ct%x1e",
            "HEAD",
            &range,
            "--",
        ],
    )
    .await?;
    let commits = log
        .split('\x1e')
        .map(str::trim)
        .filter(|r| !r.is_empty())
        .filter_map(|r| {
            let mut f = r.split('\x1f');
            Some(json!({
                "sha": f.next()?,
                "subject": f.next()?.chars().take(300).collect::<String>(),
                "author": f.next()?.chars().take(200).collect::<String>(),
                "committedAtMillis": f.next()?.parse::<u64>().ok()? * 1000,
            }))
        })
        .collect();
    Ok((total, commits))
}

/// Path to the GitHub CLI, or `None`. `SCH_GH_BIN` selects a controlled provider in tests. A
/// desktop app's background service may not inherit a shell `PATH`, so the usual install
/// locations are checked too.
fn gh_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SCH_GH_BIN") {
        return Some(PathBuf::from(path));
    }
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(windows) {
        for var in ["ProgramFiles", "LOCALAPPDATA"] {
            if let Some(base) = std::env::var_os(var) {
                dirs.push(PathBuf::from(&base).join("GitHub CLI"));
                dirs.push(PathBuf::from(base).join("Programs").join("GitHub CLI"));
            }
        }
    } else {
        dirs.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/home/linuxbrew/.linuxbrew/bin",
            ]
            .map(PathBuf::from),
        );
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// Runs the GitHub CLI with its own stored sign-in and no prompts. Output is bounded and
/// returned without credentials.
async fn gh(
    root: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    deadline: Duration,
) -> Result<String> {
    let program = gh_path().context("The GitHub CLI (gh) is not installed")?;
    let mut command = lascoria_runtime::command(program);
    command
        .args(args)
        .current_dir(root)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GH_SPINNER_DISABLED", "1")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let run = async {
        let mut child = command.spawn().context("The GitHub CLI could not start")?;
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap().take(256 * 1024 + 1);
        let mut stderr = child.stderr.take().unwrap().take(8193);
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let write = async {
            if let (Some(mut stdin), Some(bytes)) = (stdin, input) {
                stdin.write_all(bytes).await?;
                stdin.shutdown().await?;
            }
            Ok::<_, std::io::Error>(())
        };
        let (a, b, c) = tokio::join!(
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
            write
        );
        a?;
        b?;
        c?;
        let status = child.wait().await?;
        ensure!(out.len() <= 256 * 1024, "GitHub CLI output exceeds budget");
        ensure!(
            status.success(),
            "{}",
            redact(String::from_utf8_lossy(&err).trim())
                .chars()
                .take(2000)
                .collect::<String>()
        );
        Ok(String::from_utf8_lossy(&out).into_owned())
    };
    timeout(deadline, run)
        .await
        .context("The GitHub CLI did not answer in time")?
}

/// Open pull requests from the task branch, newest first.
async fn open_pull_requests(root: &Path, repository: &str, branch: &str) -> Result<Vec<Value>> {
    let out = gh(
        root,
        &[
            "pr",
            "list",
            "--repo",
            repository,
            "--head",
            branch,
            "--state",
            "open",
            "--limit",
            "5",
            "--json",
            "number,url,state,isDraft,title,headRefName,headRefOid,baseRefName",
        ],
        None,
        QUERY,
    )
    .await?;
    let list: Vec<Value> = serde_json::from_str(&out).context("Unexpected GitHub CLI output")?;
    Ok(list
        .into_iter()
        .filter(|pr| pr["headRefName"] == branch)
        .map(|pr| {
            json!({
                "number": pr["number"], "url": redact(pr["url"].as_str().unwrap_or_default()),
                "state": pr["state"], "isDraft": pr["isDraft"], "title": pr["title"],
                "headSha": pr["headRefOid"], "base": pr["baseRefName"],
            })
        })
        .collect())
}

/// The latest finished or running test command in this folder, and whether its result still
/// describes the files as they are now. Old runs without a file fingerprint are not current.
fn validation(
    db: &SharedDb,
    row: &Value,
    folder: Option<&str>,
    files: Option<&str>,
) -> Result<Value> {
    let session = row["id"].as_str().unwrap_or_default();
    let runs = db.lock().unwrap().commands_matching(
        "json_extract(value,'$.operation')='workspace/run' AND json_extract(value,'$.sessionId')=?1",
        &[&session],
    )?;
    let Some(run) = runs
        .into_iter()
        .filter(|r| r["params"]["folderId"].as_str() == folder)
        .max_by_key(|r| r["createdAtMillis"].as_u64().unwrap_or(0))
    else {
        return Ok(json!({"state": "missing"}));
    };
    let result = &run["result"];
    let summary = json!({
        "id": run["id"], "command": run["params"]["command"], "outcome": result["outcome"],
        "exitCode": result["exitCode"], "completedAtMillis": result["completedAtMillis"],
        "stdout": result["stdout"], "stderr": result["stderr"],
    });
    let state = if run["status"] == "running" {
        "running"
    } else if run["status"] != "applied"
        || !["passed", "failed"].contains(&result["outcome"].as_str().unwrap_or(""))
    {
        "incomplete"
    } else if result["contentUnchanged"] != true || result["endFilesFingerprint"].is_null() {
        "unverified"
    } else if files.is_some_and(|f| result["endFilesFingerprint"] == f) {
        if result["outcome"] == "passed" {
            "passed"
        } else {
            "failed"
        }
    } else {
        "stale"
    };
    Ok(json!({"state": state, "run": summary}))
}

/// The latest push and pull-request commands for this folder.
fn last_actions(db: &SharedDb, row: &Value, folder: Option<&str>) -> Result<Value> {
    let session = row["id"].as_str().unwrap_or_default();
    let all = db.lock().unwrap().commands_matching(
        "json_extract(value,'$.operation') IN ('workspace/push','workspace/pullRequest') AND json_extract(value,'$.sessionId')=?1",
        &[&session],
    )?;
    let latest = |operation: &str| {
        all.iter()
            .filter(|c| c["operation"] == operation && c["params"]["folderId"].as_str() == folder)
            .max_by_key(|c| c["createdAtMillis"].as_u64().unwrap_or(0))
            .map(|c| json!({"id": c["id"], "status": c["status"], "result": c["result"], "error": c["error"], "createdAtMillis": c["createdAtMillis"]}))
            .unwrap_or(Value::Null)
    };
    Ok(json!({"push": latest("workspace/push"), "pullRequest": latest("workspace/pullRequest")}))
}

/// Read-only delivery state. With `remote: true` it also asks the remote (and GitHub) what
/// they hold, within bounded deadlines; failures are reported, not hidden.
pub async fn status(db: &SharedDb, row: &Value, params: &Value) -> Result<Value> {
    let folder = params["folderId"].as_str();
    let local = local(row, params["remote"].as_str()).await?;
    let root = &local.root;
    let porcelain = read(
        root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )
    .await?;
    let (mut staged, mut unstaged, mut untracked, mut conflicts) = (0, 0, 0, 0);
    for entry in porcelain.split('\0').filter(|e| e.len() > 3) {
        let (x, y) = (entry.as_bytes()[0], entry.as_bytes()[1]);
        if x == b'?' {
            untracked += 1;
        } else if x == b'U' || y == b'U' || (x == b'A' && y == b'A') || (x == b'D' && y == b'D') {
            conflicts += 1;
        } else {
            staged += usize::from(x != b' ');
            unstaged += usize::from(y != b' ');
        }
    }
    let files = files_fingerprint(root).await.ok();
    let remote = local.remote.map(|i| &local.remotes[i]);
    let tracking = match remote {
        Some(r) => {
            optional(
                root,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/remotes/{}/{}", r.name, local.branch),
                ],
            )
            .await
        }
        None => None,
    };
    let mut checked = json!({"checked": false});
    let mut exclude = tracking.clone().unwrap_or_else(|| local.base.clone());
    let mut pull_request = Value::Null;
    let repository =
        remote.and_then(|r| github_repository(&r.fetch).or_else(|| github_repository(&r.url)));
    if let (Some(r), true) = (remote, params["checkRemote"] == true) {
        let _permit = REMOTE_QUERIES.acquire().await?;
        checked = match remote_head(root, r, &local.branch).await {
            Ok(Some(sha)) => {
                let known = has_commit(root, &sha).await;
                if known {
                    exclude = sha.clone();
                }
                json!({"checked": true, "head": sha, "known": known,
                       "behind": known && !is_ancestor(root, &sha, &local.head).await})
            }
            Ok(None) => json!({"checked": true, "head": null}),
            Err(e) => json!({"checked": false, "error": redact(&format!("{e:#}"))}),
        };
        // Only ask GitHub when it could answer: the CLI is installed and the branch is pushed.
        if let (Some(repository), true, true) = (
            &repository,
            gh_path().is_some(),
            checked["head"].is_string(),
        ) {
            pull_request = match open_pull_requests(root, repository, &local.branch).await {
                Ok(list) => json!({"checked": true, "open": list}),
                Err(e) => json!({"checked": false, "error": redact(&format!("{e:#}"))}),
            };
        }
    }
    let (total, commits) = if has_commit(root, &exclude).await {
        outgoing(root, &exclude).await?
    } else {
        outgoing(root, &local.base).await?
    };
    // What a pull request would contain: every commit since the task branch began.
    let (branch_total, branch_commits) = outgoing(root, &local.base).await?;
    let base_branch = match remote {
        Some(r) => optional(
            root,
            &[
                "symbolic-ref",
                "--quiet",
                "--short",
                &format!("refs/remotes/{}/HEAD", r.name),
            ],
        )
        .await
        .and_then(|s| s.split_once('/').map(|(_, b)| b.to_owned())),
        None => None,
    };
    let source_branch = match row["managedWorkspace"]["source"].as_str() {
        Some(source) => optional(Path::new(source), &["branch", "--show-current"]).await,
        None => None,
    };
    let last_subject = optional(root, &["log", "-1", "--format=%s", "HEAD"]).await;
    Ok(json!({
        "revision": remote.map(|r| revision(root, &local.branch, &local.head, &r.name, &r.url)),
        "branch": local.branch,
        "head": local.head,
        "base": local.base,
        "changes": {"staged": staged, "unstaged": unstaged, "untracked": untracked, "conflicts": conflicts},
        "clean": staged + unstaged + untracked + conflicts == 0,
        "filesFingerprint": files,
        "validation": validation(db, row, folder, files.as_deref())?,
        "remotes": local.remotes.iter().map(|r| json!({"name": r.name, "url": redact(&r.url), "host": host(&r.url)})).collect::<Vec<_>>(),
        "remote": remote.map(|r| json!({"name": r.name, "url": redact(&r.url), "host": host(&r.url)})),
        "trackingHead": tracking,
        "remoteBranch": checked,
        "outgoing": {"total": total, "commits": commits, "since": exclude},
        "branchCommits": {"total": branch_total, "commits": branch_commits},
        "hosting": match (&repository, remote) {
            (Some(repo), _) => json!({"kind": "github", "repository": repo, "cli": gh_path().is_some()}),
            (None, Some(r)) => json!({"kind": "other", "host": host(&r.url)}),
            (None, None) => Value::Null,
        },
        "pullRequest": pull_request,
        "suggestedBase": base_branch.or(source_branch),
        "suggestedTitle": last_subject,
        "last": last_actions(db, row, folder)?,
        "checkedAtMillis": now_ms(),
    }))
}

async fn bound(row: &Value, params: &Value) -> Result<(Local, usize)> {
    let local = local(row, params["remote"].as_str()).await?;
    let index = local
        .remote
        .ok_or_else(|| reject("Choose a remote first. Nothing was changed"))?;
    let r = &local.remotes[index];
    if params["revision"].as_str()
        != Some(&revision(
            &local.root,
            &local.branch,
            &local.head,
            &r.name,
            &r.url,
        ))
        || params["head"].as_str() != Some(&local.head)
    {
        return Err(reject(
            "The task branch or its destination changed since you reviewed it. Nothing was changed; review it again",
        ));
    }
    Ok((local, index))
}

/// Pushes exactly the reviewed commit to the task branch on the reviewed remote, without
/// force. Rechecks the remote first: already there is success, and a remote branch with
/// commits this branch lacks is refused.
pub async fn push(row: &Value, params: &Value) -> Result<Value> {
    let (local, index) = bound(row, params).await?;
    let r = &local.remotes[index];
    let root = &local.root;
    let target = format!("refs/heads/{}", local.branch);
    let receipt = |already: bool| {
        json!({"remote": r.name, "url": redact(&r.url), "branch": local.branch, "head": local.head,
               "alreadyPushed": already, "pushedAtMillis": now_ms()})
    };
    let before = remote_head(root, r, &local.branch)
        .await
        .map_err(|e| reject(format!("{e:#}. Nothing was pushed")))?;
    match &before {
        Some(sha) if *sha == local.head => return Ok(receipt(true)),
        Some(sha)
            if !(has_commit(root, sha).await && is_ancestor(root, sha, &local.head).await) =>
        {
            return Err(reject(format!(
                "{} on {} has commits this task branch does not have. Nothing was pushed. Use your Git client to reconcile them",
                local.branch, r.name
            )));
        }
        _ => {}
    }
    if before.is_none() && local.head == local.base {
        return Err(reject(
            "This task branch has no commits to push. Nothing was pushed",
        ));
    }
    let refspec = format!("{}:{target}", local.head);
    let pushed = network(
        root,
        &["push", "--porcelain", "--", &r.name, &refspec],
        SEND,
    )
    .await;
    // Whatever push reported, the remote decides what happened.
    match (remote_head(root, r, &local.branch).await, pushed) {
        (Ok(Some(sha)), _) if sha == local.head => Ok(receipt(false)),
        (Ok(_), Err(e)) if e.to_string().contains("rejected") => Err(reject(format!(
            "{} refused the push: {e:#}. Nothing was pushed",
            r.name
        ))),
        (Ok(after), Err(e)) if after == before => Err(reject(format!(
            "The push did not reach {}: {e:#}. Nothing was pushed",
            r.name
        ))),
        (Ok(_), Ok(_)) => anyhow::bail!(
            "{} accepted the push but its branch does not show this commit. Check the remote before trying again",
            r.name
        ),
        (Ok(_), Err(e)) => anyhow::bail!(
            "The remote branch changed during the push ({e:#}). Check the remote before trying again"
        ),
        (Err(e), _) => {
            anyhow::bail!("Could not confirm the push: {e:#}. Check the remote before trying again")
        }
    }
}

/// Opens a pull request from the pushed task branch, unless one is already open.
pub async fn pull_request(row: &Value, params: &Value) -> Result<Value> {
    let (local, index) = bound(row, params).await?;
    let r = &local.remotes[index];
    let root = &local.root;
    let repository = github_repository(&r.fetch)
        .or_else(|| github_repository(&r.url))
        .ok_or_else(|| {
            reject(format!(
                "{} is not a GitHub repository. Open the pull request on {}",
                r.name,
                host(&r.url)
            ))
        })?;
    if gh_path().is_none() {
        return Err(reject(
            "Install the GitHub CLI (gh) and sign in with gh auth login to open pull requests here. Nothing was changed",
        ));
    }
    let title = params["title"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    let body = params["body"].as_str().unwrap_or_default();
    let base = params["base"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if title.is_empty() || title.len() > 256 || body.len() > 16000 {
        return Err(reject(
            "A pull request needs a title of up to 256 bytes and a description of up to 16,000. Nothing was changed",
        ));
    }
    if base.is_empty()
        || base == local.branch
        || read(root, &["check-ref-format", "--branch", &base])
            .await
            .is_err()
    {
        return Err(reject(
            "Choose a valid base branch other than the task branch. Nothing was changed",
        ));
    }
    let remote = remote_head(root, r, &local.branch)
        .await
        .map_err(|e| reject(format!("{e:#}. Nothing was changed")))?;
    if remote.as_deref() != Some(&local.head) {
        return Err(reject(format!(
            "Push this commit to {} first. Nothing was changed",
            r.name
        )));
    }
    let existing = open_pull_requests(root, &repository, &local.branch)
        .await
        .map_err(|e| {
            reject(format!(
                "Could not check GitHub for an existing pull request: {e:#}. Nothing was changed"
            ))
        })?;
    if let Some(pr) = existing.into_iter().next() {
        return Ok(json!({"repository": repository, "pullRequest": pr, "existing": true}));
    }
    let mut args = vec![
        "pr",
        "create",
        "--repo",
        &repository,
        "--head",
        &local.branch,
        "--base",
        &base,
        "--title",
        &title,
        "--body-file",
        "-",
    ];
    if params["draft"] != false {
        args.push("--draft");
    }
    let created = gh(root, &args, Some(body.as_bytes()), SEND).await;
    match (
        open_pull_requests(root, &repository, &local.branch).await,
        created,
    ) {
        (Ok(list), created) if !list.is_empty() => Ok(json!({
            "repository": repository, "pullRequest": list[0], "existing": false, "reconciled": created.is_err(),
        })),
        (Ok(_), Err(e)) => Err(reject(format!(
            "GitHub did not open the pull request: {e:#}"
        ))),
        (Ok(_), Ok(_)) => anyhow::bail!(
            "GitHub reported a new pull request that is not listed yet. Check GitHub before trying again"
        ),
        (Err(e), _) => anyhow::bail!(
            "Could not confirm the pull request: {e:#}. Check GitHub before trying again"
        ),
    }
}

/// Admits one background delivery action per session; the caller has journaled it.
pub fn spawn(
    db: SharedDb,
    row: Value,
    id: String,
    operation: String,
    params: Value,
) -> Result<Value> {
    {
        let db = db.lock().unwrap();
        let mut record = db.get("commands", &id)?.context("Command missing")?;
        record["status"] = json!("running");
        record["result"] = json!({"startedAtMillis": now_ms()});
        db.put("commands", &id, &record)?;
    }
    let result = db
        .lock()
        .unwrap()
        .get("commands", &id)?
        .context("Command missing")?;
    tokio::spawn(async move {
        let outcome = if operation == "workspace/push" {
            push(&row, &params).await
        } else {
            pull_request(&row, &params).await
        };
        let _ = workspace::finish(&db, &id, outcome);
    });
    Ok(result)
}

pub fn running(db: &SharedDb, session: &str) -> Result<bool> {
    Ok(!db.lock().unwrap().commands_matching(
        "json_extract(value,'$.operation') IN ('workspace/push','workspace/pullRequest') AND json_extract(value,'$.sessionId')=?1 AND json_extract(value,'$.status')='running'",
        &[&session],
    )?.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn git(root: &Path, args: &[&str]) -> String {
        String::from_utf8(git::run(root, args, LOCAL, false).await.unwrap()).unwrap()
    }

    async fn commit(root: &Path, file: &str, text: &str, message: &str) {
        std::fs::write(root.join(file), text).unwrap();
        git(root, &["add", "--", file]).await;
        git(
            root,
            &[
                "-c",
                "user.name=F",
                "-c",
                "user.email=f@example.invalid",
                "commit",
                "-qm",
                message,
            ],
        )
        .await;
    }

    /// A source repository with a bare remote, and an isolated task worktree on its branch.
    async fn setup() -> (Fixture, Value, PathBuf) {
        let fixture =
            Fixture(std::env::temp_dir().join(format!("sch-delivery-{}", Uuid::new_v4())));
        let (source, bare, tree) = (
            fixture.0.join("source"),
            fixture.0.join("remote.git"),
            fixture.0.join("tree"),
        );
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare"]).await;
        git(&source, &["init", "-q", "-b", "main"]).await;
        commit(&source, "a.txt", "a\n", "init").await;
        let bare_text = bare.to_str().unwrap();
        git(&source, &["remote", "add", "origin", bare_text]).await;
        git(&source, &["push", "-q", "origin", "main"]).await;
        let managed = workspace::create(&source, &tree, "s1").await.unwrap();
        let row = json!({"id": "s1", "workspace": tree, "managedWorkspace": managed});
        (fixture, row, bare)
    }

    fn db(fixture: &Fixture) -> SharedDb {
        std::sync::Arc::new(std::sync::Mutex::new(
            crate::db::Db::open(&fixture.0.join("db.sqlite")).unwrap(),
        ))
    }

    #[test]
    fn credentials_never_leave_urls_or_messages() {
        assert_eq!(
            redact("https://user:ghp_secret@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            redact("fatal: unable to access 'https://tok@example.com/x/': 403"),
            "fatal: unable to access 'https://example.com/x/': 403"
        );
        assert_eq!(redact("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(
            github_repository("https://x:y@github.com/o/r.git").as_deref(),
            Some("o/r")
        );
        assert_eq!(
            github_repository("git@github.com:owner/name").as_deref(),
            Some("owner/name")
        );
        assert_eq!(
            github_repository("ssh://git@github.com/o/r.git").as_deref(),
            Some("o/r")
        );
        assert_eq!(github_repository("https://gitlab.com/o/r.git"), None);
        assert_eq!(github_repository("https://github.com/o/../r"), None);
        assert_eq!(
            host("https://u:p@gitlab.example.com:8443/o/r"),
            "gitlab.example.com"
        );
    }

    #[tokio::test]
    async fn push_sends_exactly_the_reviewed_commit_once_and_never_overwrites() {
        let (fixture, row, bare) = setup().await;
        let db = db(&fixture);
        let tree = PathBuf::from(row["workspace"].as_str().unwrap());
        let view = status(&db, &row, &json!({"checkRemote": true}))
            .await
            .unwrap();
        assert_eq!(view["outgoing"]["total"], 0);
        assert_eq!(view["remoteBranch"]["head"], Value::Null);
        assert_eq!(view["remote"]["name"], "origin");
        // Nothing to push yet.
        let params =
            |v: &Value| json!({"revision": v["revision"], "head": v["head"], "remote": "origin"});
        let refused = push(&row, &params(&view)).await.unwrap_err();
        assert!(refused.downcast_ref::<Rejected>().is_some(), "{refused}");

        commit(&tree, "b.txt", "b\n", "Add b").await;
        commit(&tree, "c.txt", "c\n", "Add c").await;
        let view = status(&db, &row, &json!({"checkRemote": true}))
            .await
            .unwrap();
        assert_eq!(view["outgoing"]["total"], 2);
        assert_eq!(view["outgoing"]["commits"][0]["subject"], "Add c");
        assert_eq!(view["suggestedTitle"], "Add c");
        // A commit made after review is not pushed under the earlier review.
        let reviewed = params(&view);
        commit(&tree, "d.txt", "d\n", "Add d").await;
        let stale = push(&row, &reviewed).await.unwrap_err();
        assert!(
            stale.downcast_ref::<Rejected>().is_some()
                && stale.to_string().contains("changed since"),
            "{stale}"
        );
        assert!(
            git(&bare, &["branch", "--list", "lascoria/*"])
                .await
                .is_empty()
        );

        let view = status(&db, &row, &json!({})).await.unwrap();
        let sent = push(&row, &params(&view)).await.unwrap();
        assert_eq!(sent["alreadyPushed"], false);
        let head = view["head"].as_str().unwrap();
        assert_eq!(git(&bare, &["rev-parse", "lascoria/s1"]).await.trim(), head);
        // A retry after a lost acknowledgement is a confirmed no-op.
        assert_eq!(
            push(&row, &params(&view)).await.unwrap()["alreadyPushed"],
            true
        );
        let view = status(&db, &row, &json!({"checkRemote": true}))
            .await
            .unwrap();
        assert_eq!(view["outgoing"]["total"], 0);
        assert_eq!(view["remoteBranch"]["head"], head);

        // Someone else adds to the remote branch: Lascoria refuses rather than overwrite.
        let other = fixture.0.join("other");
        git(
            &fixture.0,
            &[
                "clone",
                "-q",
                "-b",
                "lascoria/s1",
                bare.to_str().unwrap(),
                other.to_str().unwrap(),
            ],
        )
        .await;
        commit(&other, "e.txt", "e\n", "Remote edit").await;
        git(&other, &["push", "-q", "origin", "lascoria/s1"]).await;
        commit(&tree, "f.txt", "f\n", "Local edit").await;
        let view = status(&db, &row, &json!({"checkRemote": true}))
            .await
            .unwrap();
        assert_eq!(view["remoteBranch"]["known"], false);
        let diverged = push(&row, &params(&view)).await.unwrap_err();
        assert!(
            diverged.downcast_ref::<Rejected>().is_some()
                && diverged.to_string().contains("does not have"),
            "{diverged}"
        );
        assert_ne!(
            git(&bare, &["rev-parse", "lascoria/s1"]).await.trim(),
            view["head"].as_str().unwrap()
        );
    }

    #[tokio::test]
    async fn unreachable_remotes_are_reported_without_credentials_and_change_nothing() {
        let (fixture, row, _) = setup().await;
        let db = db(&fixture);
        let tree = PathBuf::from(row["workspace"].as_str().unwrap());
        git(
            &tree,
            &[
                "remote",
                "set-url",
                "origin",
                "https://user:s3cret@127.0.0.1:9/none.git",
            ],
        )
        .await;
        commit(&tree, "b.txt", "b\n", "Add b").await;
        let view = status(&db, &row, &json!({"checkRemote": true}))
            .await
            .unwrap();
        let text = view.to_string();
        assert!(
            !text.contains("s3cret") && !text.contains("user:"),
            "{text}"
        );
        assert_eq!(view["remote"]["url"], "https://127.0.0.1:9/none.git");
        assert!(view["remoteBranch"]["error"].is_string());
        let error = push(
            &row,
            &json!({"revision": view["revision"], "head": view["head"], "remote": "origin"}),
        )
        .await
        .unwrap_err();
        assert!(error.downcast_ref::<Rejected>().is_some(), "{error}");
        assert!(!format!("{error:#}").contains("s3cret"));
    }

    #[tokio::test]
    async fn validation_is_current_only_for_the_exact_files_it_ran_on() {
        let (fixture, row, _) = setup().await;
        let db = db(&fixture);
        let tree = PathBuf::from(row["workspace"].as_str().unwrap());
        std::fs::write(tree.join("b.txt"), "b\n").unwrap();
        assert_eq!(
            status(&db, &row, &json!({})).await.unwrap()["validation"]["state"],
            "missing"
        );
        let files = files_fingerprint(&tree).await.unwrap();
        let record = |id: &str, outcome: &str, end: &str, at: u64| {
            json!({"id": id, "operation": "workspace/run", "sessionId": "s1",
            "params": {"sessionId": "s1", "command": "npm test"}, "status": "applied", "createdAtMillis": at,
            "result": {"outcome": outcome, "exitCode": if outcome == "passed" {0} else {1}, "contentUnchanged": true, "endFilesFingerprint": end}})
        };
        db.lock()
            .unwrap()
            .put("commands", "r1", &record("r1", "failed", &files, 1))
            .unwrap();
        assert_eq!(
            status(&db, &row, &json!({})).await.unwrap()["validation"]["state"],
            "failed"
        );
        db.lock()
            .unwrap()
            .put("commands", "r2", &record("r2", "passed", &files, 2))
            .unwrap();
        let view = status(&db, &row, &json!({})).await.unwrap();
        assert_eq!(view["validation"]["state"], "passed");
        assert_eq!(view["changes"]["untracked"], 1);
        // Committing the tested files keeps the result current; editing them does not.
        commit(&tree, "b.txt", "b\n", "Add b").await;
        let view = status(&db, &row, &json!({})).await.unwrap();
        assert_eq!(
            (
                view["validation"]["state"].as_str(),
                view["clean"].as_bool()
            ),
            (Some("passed"), Some(true))
        );
        std::fs::write(tree.join("b.txt"), "b2\n").unwrap();
        assert_eq!(
            status(&db, &row, &json!({})).await.unwrap()["validation"]["state"],
            "stale"
        );
        // A run from before file fingerprints existed is never presented as current.
        let mut legacy = record("r3", "passed", "", 3);
        legacy["result"]
            .as_object_mut()
            .unwrap()
            .remove("endFilesFingerprint");
        db.lock().unwrap().put("commands", "r3", &legacy).unwrap();
        assert_eq!(
            status(&db, &row, &json!({})).await.unwrap()["validation"]["state"],
            "unverified"
        );
    }

    /// A controlled GitHub CLI: open pull requests live in a JSON file next to it. `create`
    /// can be told to fail after creating, as a lost acknowledgement would look.
    #[cfg(unix)]
    fn fake_gh(dir: &Path, fail_after_create: bool) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let state = dir.join("prs.json");
        std::fs::write(&state, "[]").unwrap();
        let script = dir.join("gh");
        std::fs::write(&script, format!(
            "#!/bin/sh\nstate='{}'\necho \"$*\" >> '{}'\ncase \"$1 $2\" in\n\
             'pr list') cat \"$state\" ;;\n\
             'pr create') body=$(cat); printf '[{{\"number\":7,\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\",\"isDraft\":true,\"title\":\"t\",\"headRefName\":\"lascoria/s1\",\"headRefOid\":\"x\",\"baseRefName\":\"main\"}}]' > \"$state\"; {}\n\
             echo https://github.com/o/r/pull/7 ;;\nesac\n",
            state.display(), dir.join("calls.log").display(),
            if fail_after_create { "echo 'connection reset' >&2; exit 1" } else { ":" },
        )).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pull_requests_are_opened_once_and_lost_acknowledgements_reconcile() {
        // SCH_GH_BIN is process-wide; this is the only test that sets it.
        let (fixture, row, bare) = setup().await;
        let db = db(&fixture);
        let tree = PathBuf::from(row["workspace"].as_str().unwrap());
        // The fetch URL names the GitHub repository (the controlled CLI stands in for
        // github.com); pushes go to the bare repository through the push URL.
        git(
            &tree,
            &["config", "remote.origin.pushurl", bare.to_str().unwrap()],
        )
        .await;
        git(
            &tree,
            &["config", "remote.origin.url", "https://github.com/o/r.git"],
        )
        .await;
        let gh = fake_gh(&fixture.0, true);
        unsafe { std::env::set_var("SCH_GH_BIN", &gh) };
        commit(&tree, "b.txt", "b\n", "Add b").await;
        let view = status(&db, &row, &json!({})).await.unwrap();
        assert_eq!(view["hosting"]["repository"], "o/r", "{view}");
        let params = json!({"revision": view["revision"], "head": view["head"], "remote": "origin",
                            "title": "Add b", "body": "Body", "base": "main"});
        let early = pull_request(&row, &params).await.unwrap_err();
        assert!(early.to_string().contains("Push this commit"), "{early}");
        push(&row, &params).await.unwrap();
        // gh reports failure after creating it: the follow-up listing finds and records it.
        let opened = pull_request(&row, &params).await.unwrap();
        assert_eq!(
            (opened["existing"].as_bool(), opened["reconciled"].as_bool()),
            (Some(false), Some(true))
        );
        assert_eq!(
            opened["pullRequest"]["url"],
            "https://github.com/o/r/pull/7"
        );
        // A retry finds the open pull request instead of creating another.
        assert_eq!(pull_request(&row, &params).await.unwrap()["existing"], true);
        let calls = std::fs::read_to_string(fixture.0.join("calls.log")).unwrap();
        assert_eq!(calls.matches("pr create").count(), 1, "{calls}");
        assert!(
            calls.contains("--draft") && calls.contains("--base main"),
            "{calls}"
        );
        let view = status(&db, &row, &json!({"checkRemote": true}))
            .await
            .unwrap();
        assert_eq!(view["pullRequest"]["open"][0]["number"], 7);
        unsafe { std::env::remove_var("SCH_GH_BIN") };
    }
}
