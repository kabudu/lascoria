//! Selective staging in isolated task worktrees: file and hunk staging, unstaging and a commit
//! of exactly the previewed index. Rust owns every mutation; the client only names paths and
//! hunk IDs from a view bound to one repository revision (HEAD, index entries and working-tree
//! content). Anything that changed since that view is refused, never merged or replayed.
use crate::{git, workspace};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use tokio::time::Duration;

/// Changed paths (staged, unstaged and new together) and hunks a view may hold.
const MAX_FILES: usize = 500;
const MAX_HUNKS_PER_FILE: usize = 500;
/// Selected files and hunks in one request.
const MAX_SELECTION: usize = 500;
const STEP: Duration = Duration::from_secs(8);
/// Deadline for a whole view or mutation, across all of its Git steps.
const DEADLINE: Duration = Duration::from_secs(30);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

async fn read(root: &Path, args: &[&str]) -> Result<Vec<u8>> {
    git::run_with(
        root,
        args,
        STEP,
        git::Options {
            read_only: true,
            ..git::Options::default()
        },
    )
    .await
}

/// Settings that change how a diff is printed. Pinned so a hunk applies exactly as shown.
const DIFF: &[&str] = &[
    "-c",
    "core.quotePath=true",
    "-c",
    "diff.noprefix=false",
    "-c",
    "diff.mnemonicPrefix=false",
    "-c",
    "diff.relative=false",
    "-c",
    "diff.suppressBlankEmpty=false",
    "-c",
    "color.diff=false",
];

async fn diff(root: &Path, cached: bool) -> Result<Vec<u8>> {
    let mut args: Vec<&str> = DIFF.to_vec();
    args.extend([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--binary",
        "--full-index",
        "-U3",
    ]);
    if cached {
        args.extend(["--cached", "HEAD"]);
    }
    args.push("--");
    read(root, &args)
        .await
        .context("Changes exceed the 1 MiB diff budget or could not be read")
}

#[derive(Debug, Clone)]
struct Hunk {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
struct Section {
    path: String,
    header: Vec<u8>,
    hunks: Vec<Hunk>,
    /// Why only the whole file can be staged, when hunks cannot be.
    whole_only: Option<&'static str>,
    change: &'static str,
}

/// Git's C-style quoting (core.quotePath=true) for a path in a diff header.
fn unquote(text: &str) -> Result<Vec<u8>> {
    let inner = text
        .strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .context("Malformed quoted path")?;
    let bytes = inner.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'\\' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let next = *bytes.get(i + 1).context("Malformed quoted path")?;
        i += 2;
        out.push(match next {
            b'n' => b'\n',
            b't' => b'\t',
            b'r' => b'\r',
            b'a' => 7,
            b'b' => 8,
            b'f' => 12,
            b'v' => 11,
            b'"' => b'"',
            b'\\' => b'\\',
            b'0'..=b'3' => {
                let digits = bytes.get(i - 1..i + 2).context("Malformed quoted path")?;
                ensure!(
                    digits.iter().all(|d| (b'0'..=b'7').contains(d)),
                    "Malformed quoted path"
                );
                i += 2;
                (digits[0] - b'0') * 64 + (digits[1] - b'0') * 8 + (digits[2] - b'0')
            }
            _ => bail!("Malformed quoted path"),
        });
    }
    Ok(out)
}

/// The one path named by `diff --git a/P b/P`. Rename detection is off, so both sides match;
/// that makes even an unquoted path containing ` b/` unambiguous.
fn header_path(line: &str) -> Result<String> {
    let rest = line
        .strip_prefix("diff --git ")
        .context("Malformed diff header")?;
    let path = if rest.starts_with('"') {
        let split = rest
            .find("\" \"b/")
            .or_else(|| rest.find("\" b/"))
            .context("Malformed diff header")?;
        let (a, b) = (&rest[..=split], rest[split + 2..].trim_start());
        let a = if a.starts_with('"') {
            unquote(a)?
        } else {
            a.as_bytes().to_vec()
        };
        let b = if b.starts_with('"') {
            unquote(b)?
        } else {
            b.as_bytes().to_vec()
        };
        ensure!(
            a.strip_prefix(b"a/") == b.strip_prefix(b"b/") && a.starts_with(b"a/"),
            "Malformed diff header"
        );
        a[2..].to_vec()
    } else {
        ensure!(
            rest.len() >= 5 && (rest.len() - 5) % 2 == 0,
            "Malformed diff header"
        );
        let n = (rest.len() - 5) / 2;
        ensure!(
            rest.is_char_boundary(2 + n)
                && rest.starts_with("a/")
                && rest[2 + n..].starts_with(" b/")
                && rest[2..2 + n] == rest[5 + n..],
            "Malformed diff header"
        );
        rest.as_bytes()[2..2 + n].to_vec()
    };
    String::from_utf8(path).context("Lascoria stages only UTF-8 paths")
}

fn parse(patch: &[u8], side: &str) -> Result<Vec<Section>> {
    let mut sections: Vec<Section> = Vec::new();
    let mut hunk: Option<Vec<u8>> = None;
    let finish_hunk = |section: &mut Section, hunk: Option<Vec<u8>>| -> Result<()> {
        if let Some(bytes) = hunk {
            ensure!(
                section.hunks.len() < MAX_HUNKS_PER_FILE,
                "{} has more than {MAX_HUNKS_PER_FILE} hunks; stage it with your Git client",
                section.path
            );
            let mut digest = Sha256::new();
            digest.update(b"lascoria-hunk-v1");
            digest.update(side.as_bytes());
            digest.update((section.path.len() as u64).to_be_bytes());
            digest.update(section.path.as_bytes());
            digest.update(&bytes);
            section.hunks.push(Hunk {
                id: hex(&digest.finalize()[..12]),
                bytes,
            });
        }
        Ok(())
    };
    for line in patch.split_inclusive(|b| *b == b'\n') {
        if line.starts_with(b"diff --git ") {
            if let Some(section) = sections.last_mut() {
                finish_hunk(section, hunk.take())?;
            }
            let text = std::str::from_utf8(line)
                .context("Malformed diff header")?
                .trim_end_matches('\n');
            sections.push(Section {
                path: header_path(text)?,
                header: line.to_vec(),
                hunks: Vec::new(),
                whole_only: None,
                change: "modified",
            });
            continue;
        }
        let section = sections.last_mut().context("Malformed diff")?;
        if let Some(bytes) = hunk.as_mut() {
            if line.starts_with(b"@@ ") {
                finish_hunk(section, hunk.take())?;
                hunk = Some(line.to_vec());
            } else {
                ensure!(
                    matches!(line.first(), Some(b' ' | b'+' | b'-' | b'\\')),
                    "Malformed diff hunk in {}",
                    section.path
                );
                bytes.extend_from_slice(line);
            }
            continue;
        }
        if line.starts_with(b"@@ ") {
            hunk = Some(line.to_vec());
            continue;
        }
        let reason = if line.starts_with(b"new file mode") {
            section.change = "added";
            Some("New files are staged whole")
        } else if line.starts_with(b"deleted file mode") {
            section.change = "deleted";
            Some("Deletions are staged whole")
        } else if line.starts_with(b"old mode") || line.starts_with(b"new mode") {
            Some("Permission changes are staged with the whole file")
        } else if line.starts_with(b"GIT binary patch") || line.starts_with(b"Binary files") {
            section.change = if section.change == "modified" {
                "binary"
            } else {
                section.change
            };
            Some("Binary files are staged whole")
        } else if line.starts_with(b"index ") && line.trim_ascii_end().ends_with(b" 160000") {
            Some("Submodule changes are staged whole")
        } else {
            None
        };
        if let Some(reason) = reason {
            // The first reason found wins; later ones (a binary new file) do not override it.
            section.whole_only.get_or_insert(reason);
        }
        section.header.extend_from_slice(line);
    }
    if let Some(section) = sections.last_mut() {
        finish_hunk(section, hunk.take())?;
    }
    // A path appears once per side with rename detection off; two sections (a type change)
    // are staged whole.
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut repeated = Vec::new();
    for (index, section) in sections.iter().enumerate() {
        match seen.get(&section.path) {
            Some(first) => repeated.push(*first),
            None => {
                seen.insert(section.path.clone(), index);
            }
        }
    }
    for first in repeated {
        sections[first].whole_only = Some("Type changes are staged whole");
    }
    let mut unique = BTreeSet::new();
    sections.retain(|s| unique.insert(s.path.clone()));
    for section in &mut sections {
        if section.whole_only.is_none() && section.hunks.is_empty() {
            section.whole_only = Some("This change has no text hunks");
        }
    }
    Ok(sections)
}

/// One consistent view of an isolated worktree, and the revision that binds it.
struct View {
    revision: String,
    head: String,
    branch: String,
    index: Vec<u8>,
    staged: Vec<Section>,
    unstaged: Vec<Section>,
    untracked: Vec<String>,
    conflicts: Vec<String>,
    staged_patch: Vec<u8>,
    content: String,
}

/// Binds the worktree itself as well as its content: two Project folders with identical
/// files must never accept each other's views.
fn revision(root: &Path, head: &str, index: &[u8], content: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"lascoria-staging-v1");
    let root = root.to_string_lossy();
    for part in [root.as_bytes(), head.as_bytes(), index, content.as_bytes()] {
        digest.update((part.len() as u64).to_be_bytes());
        digest.update(part);
    }
    format!("sha256:{}", hex(&digest.finalize()))
}

fn names(bytes: &[u8]) -> Result<Vec<String>> {
    bytes
        .split(|b| *b == 0)
        .filter(|n| !n.is_empty())
        .map(|n| String::from_utf8(n.to_vec()).context("Lascoria stages only UTF-8 paths"))
        .collect()
}

/// Index entries as `mode oid stage\tpath`, null-delimited, exactly as Git reports them.
async fn index_entries(root: &Path, index: Option<&Path>) -> Result<Vec<u8>> {
    git::run_with(
        root,
        &["ls-files", "--stage", "-z"],
        STEP,
        git::Options {
            read_only: true,
            index_file: index,
            ..git::Options::default()
        },
    )
    .await
}

async fn view(root: &Path) -> Result<View> {
    let top = String::from_utf8(read(root, &["rev-parse", "--show-toplevel"]).await?)?;
    let canonical = std::fs::canonicalize(root)?;
    ensure!(
        canonical == std::fs::canonicalize(top.trim())?,
        "Staging requires the repository root"
    );
    let hidden = read(root, &["ls-files", "-v", "-z"]).await?;
    ensure!(
        hidden
            .split(|b| *b == 0)
            .filter(|row| !row.is_empty())
            .all(|row| row[0].is_ascii_uppercase() && row[0] != b'S'),
        "Staging refuses assume-unchanged or skip-worktree files, which hide their changes"
    );
    let head = String::from_utf8(read(root, &["rev-parse", "--verify", "HEAD"]).await?)?
        .trim()
        .to_string();
    let branch = String::from_utf8(read(root, &["branch", "--show-current"]).await?)?
        .trim()
        .to_string();
    let index = index_entries(root, None).await?;
    // Content also checks that every Git-visible file is regular and inside the repository.
    let content = workspace::content_fingerprint(root).await?;
    let revision = revision(&canonical, &head, &index, &content);
    let mut conflicts = BTreeSet::new();
    for entry in index.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let text = std::str::from_utf8(entry).context("Lascoria stages only UTF-8 paths")?;
        let (meta, path) = text.split_once('\t').context("Malformed index entry")?;
        if !meta.ends_with(" 0") {
            conflicts.insert(path.to_owned());
        }
    }
    let untracked =
        names(&read(root, &["ls-files", "--others", "--exclude-standard", "-z"]).await?)?;
    let mut view = View {
        revision,
        head,
        branch,
        index,
        staged: Vec::new(),
        unstaged: Vec::new(),
        untracked,
        conflicts: conflicts.into_iter().collect(),
        staged_patch: Vec::new(),
        content,
    };
    if !view.conflicts.is_empty() {
        return Ok(view);
    }
    view.staged_patch = diff(root, true).await?;
    view.staged = parse(&view.staged_patch, "staged")?;
    view.unstaged = parse(&diff(root, false).await?, "unstaged")?;
    let mut all: BTreeSet<&str> = view.untracked.iter().map(String::as_str).collect();
    all.extend(view.staged.iter().map(|s| s.path.as_str()));
    all.extend(view.unstaged.iter().map(|s| s.path.as_str()));
    ensure!(
        all.len() <= MAX_FILES,
        "More than {MAX_FILES} changed files; stage them with your Git client"
    );
    Ok(view)
}

fn side_json(sections: &[Section]) -> Vec<Value> {
    sections
        .iter()
        .map(|s| {
            json!({
                "path": s.path,
                "change": s.change,
                "wholeOnly": s.whole_only,
                "hunks": if s.whole_only.is_some() { Vec::new() } else {
                    s.hunks.iter().map(|h| json!({
                        "id": h.id,
                        "text": String::from_utf8_lossy(&h.bytes),
                    })).collect::<Vec<_>>()
                },
            })
        })
        .collect()
}

fn require_isolated(row: &Value) -> Result<PathBuf> {
    ensure!(
        row["managedWorkspace"].is_object(),
        "Staging is available only in isolated task worktrees. Use your Git client for this checkout"
    );
    Ok(PathBuf::from(
        row["workspace"].as_str().context("Workspace missing")?,
    ))
}

/// Read-only: what is staged, what is not, and the revision a later action must name.
pub async fn changes(row: &Value) -> Result<Value> {
    let root = require_isolated(row)?;
    tokio::time::timeout(DEADLINE, async {
        let view = view(&root).await?;
        Ok(json!({
            "revision": view.revision,
            "head": view.head,
            "branch": view.branch,
            "conflicts": view.conflicts,
            "staged": side_json(&view.staged),
            "unstaged": side_json(&view.unstaged),
            "untracked": view.untracked,
            "stagedPatch": String::from_utf8_lossy(&view.staged_patch),
            "limits": {"files": MAX_FILES, "hunksPerFile": MAX_HUNKS_PER_FILE, "diffBytes": 1024 * 1024},
        }))
    })
    .await
    .context("Reading changes timed out")?
}

/// A refusal before anything was changed. The command records it as rejected, not unknown.
#[derive(Debug)]
pub struct Rejected(pub String);
impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Rejected {}

fn reject(message: impl Into<String>) -> anyhow::Error {
    Rejected(message.into()).into()
}

/// Git's own lock on the index, held while Lascoria prepares and publishes a new index. Any
/// Git process honouring the lock waits or fails; the lock is removed unless published.
struct IndexLock {
    lock: PathBuf,
    temp: PathBuf,
    published: bool,
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.temp);
        if !self.published {
            let _ = std::fs::remove_file(&self.lock);
        }
    }
}

async fn index_path(root: &Path) -> Result<PathBuf> {
    let text = String::from_utf8(read(root, &["rev-parse", "--git-path", "index"]).await?)?;
    let path = root.join(text.trim_end_matches(['\n', '\r']));
    // dunce: Git on Windows does not accept verbatim `\\?\` paths in GIT_INDEX_FILE.
    let parent = dunce::canonicalize(path.parent().context("Index path")?)?;
    Ok(parent.join(path.file_name().context("Index path")?))
}

fn lock_index(index: &Path) -> Result<IndexLock> {
    let lock = index.with_file_name(format!(
        "{}.lock",
        index.file_name().unwrap().to_string_lossy()
    ));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
    {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(reject(
                "Another Git process is updating this worktree's index. Try again when it finishes",
            ));
        }
        Err(e) => return Err(e.into()),
    }
    let temp = index.with_file_name(format!("index.lascoria-{}", uuid::Uuid::new_v4()));
    let guard = IndexLock {
        lock,
        temp,
        published: false,
    };
    ensure!(index.is_file(), "This worktree has no index to stage into");
    std::fs::copy(index, &guard.temp)?;
    Ok(guard)
}

fn publish(mut guard: IndexLock, index: &Path) -> Result<()> {
    // Same protocol as Git: the complete new index replaces the lock, then the index.
    std::fs::File::open(&guard.temp)?.sync_all()?;
    std::fs::rename(&guard.temp, &guard.lock)?;
    std::fs::rename(&guard.lock, index)?;
    guard.published = true;
    Ok(())
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Action {
    Stage,
    Unstage,
}

struct Selection {
    action: Action,
    files: Vec<String>,
    hunks: BTreeMap<String, BTreeSet<String>>,
}

fn selection(params: &Value) -> Result<Selection> {
    let action = match params["action"].as_str() {
        Some("stage") => Action::Stage,
        Some("unstage") => Action::Unstage,
        _ => return Err(reject("Choose stage or unstage")),
    };
    let files: Vec<String> = match &params["files"] {
        Value::Null => Vec::new(),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                v.as_str()
                    .map(str::to_owned)
                    .context("File paths must be text")
            })
            .collect::<Result<_>>()?,
        _ => return Err(reject("Files must be a list")),
    };
    let mut hunks: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut count = files.len();
    match &params["hunks"] {
        Value::Null => {}
        Value::Array(items) => {
            for item in items {
                let (Some(path), Some(id)) = (item["path"].as_str(), item["id"].as_str()) else {
                    return Err(reject("Each hunk needs a path and an ID"));
                };
                count += 1;
                if !hunks
                    .entry(path.to_owned())
                    .or_default()
                    .insert(id.to_owned())
                {
                    return Err(reject("A hunk was selected twice"));
                }
            }
        }
        _ => return Err(reject("Hunks must be a list")),
    }
    if count == 0 {
        return Err(reject("Select at least one file or hunk"));
    }
    if count > MAX_SELECTION {
        return Err(reject(format!(
            "Select at most {MAX_SELECTION} files and hunks at once"
        )));
    }
    let unique: BTreeSet<_> = files.iter().collect();
    if unique.len() != files.len() {
        return Err(reject("A file was selected twice"));
    }
    if files.iter().any(|f| hunks.contains_key(f)) {
        return Err(reject(
            "Select either a whole file or some of its hunks, not both",
        ));
    }
    Ok(Selection {
        action,
        files,
        hunks,
    })
}

/// Patch bytes for the selected hunks: each file's header, then its chosen hunks in their
/// original order. Skipping hunks never changes the preimage they apply to.
fn hunk_patch(
    sections: &[Section],
    wanted: &BTreeMap<String, BTreeSet<String>>,
) -> Result<Vec<u8>> {
    let mut patch = Vec::new();
    for (path, ids) in wanted {
        let section = sections
            .iter()
            .find(|s| &s.path == path)
            .ok_or_else(|| reject(format!("{path} has no such change any more; refresh")))?;
        if let Some(reason) = section.whole_only {
            return Err(reject(format!("{path}: {reason}")));
        }
        let chosen: Vec<_> = section
            .hunks
            .iter()
            .filter(|h| ids.contains(&h.id))
            .collect();
        if chosen.len() != ids.len() {
            return Err(reject(format!(
                "A selected hunk in {path} changed; refresh and select again"
            )));
        }
        patch.extend_from_slice(&section.header);
        for hunk in chosen {
            patch.extend_from_slice(&hunk.bytes);
        }
    }
    Ok(patch)
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex(&Sha256::digest(bytes)))
}

/// Stage or unstage selected whole files and hunks, atomically: every change is prepared in
/// a private copy of the index under Git's index lock and published only if all succeed.
pub async fn stage(row: &Value, params: &Value) -> Result<Value> {
    let root = require_isolated(row)?;
    let wanted = selection(params)?;
    let expected = params["revision"]
        .as_str()
        .ok_or_else(|| reject("Refresh the changes view before staging"))?
        .to_owned();
    tokio::time::timeout(DEADLINE, async move {
        let index = index_path(&root).await?;
        let guard = lock_index(&index)?;
        // Read under the lock: nothing that honours Git's lock can change the index now.
        let view = view(&root).await?;
        if view.revision != expected {
            return Err(reject(
                "Files or the index changed since this view was loaded. Nothing was staged; review the refreshed changes",
            ));
        }
        if row["managedWorkspace"]["branch"] != json!(view.branch) {
            return Err(reject("The task branch changed; nothing was staged"));
        }
        if !view.conflicts.is_empty() {
            return Err(reject(
                "Resolve merge conflicts with your Git client before staging here",
            ));
        }
        let (sections, eligible): (&[Section], BTreeSet<&str>) = match wanted.action {
            Action::Stage => (
                &view.unstaged,
                view.unstaged
                    .iter()
                    .map(|s| s.path.as_str())
                    .chain(view.untracked.iter().map(String::as_str))
                    .collect(),
            ),
            Action::Unstage => (
                &view.staged,
                view.staged.iter().map(|s| s.path.as_str()).collect(),
            ),
        };
        for file in &wanted.files {
            if !eligible.contains(file.as_str()) {
                return Err(reject(format!(
                    "{file} has nothing to {}; refresh",
                    if wanted.action == Action::Stage { "stage" } else { "unstage" }
                )));
            }
        }
        let patch = hunk_patch(sections, &wanted.hunks)?;
        if !patch.is_empty() {
            let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
            if wanted.action == Action::Unstage {
                args.push("--reverse");
            }
            args.push("-");
            git::run_with(
                &root,
                &args,
                STEP,
                git::Options {
                    index_file: Some(&guard.temp),
                    literal_pathspecs: true,
                    input: Some(&patch),
                    ..git::Options::default()
                },
            )
            .await
            .map_err(|e| reject(format!("Git could not apply the selected hunks; nothing was staged ({e})")))?;
        }
        if !wanted.files.is_empty() {
            let mut list = Vec::new();
            for file in &wanted.files {
                list.extend_from_slice(file.as_bytes());
                list.push(0);
            }
            let args: &[&str] = match wanted.action {
                Action::Stage => &["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"],
                Action::Unstage => &[
                    "restore",
                    "--staged",
                    "--source=HEAD",
                    "--pathspec-from-file=-",
                    "--pathspec-file-nul",
                ],
            };
            git::run_with(
                &root,
                args,
                STEP,
                git::Options {
                    index_file: Some(&guard.temp),
                    literal_pathspecs: true,
                    input: Some(&list),
                    ..git::Options::default()
                },
            )
            .await
            .map_err(|e| reject(format!("Git refused the selected files; nothing was staged ({e})")))?;
        }
        // `git add` reads files as they are now: anything edited since the view was read would
        // be staged unseen, so the working tree must still match before publishing.
        if workspace::content_fingerprint(&root).await? != view.content {
            return Err(reject(
                "Files changed while staging. Nothing was staged; review the refreshed changes",
            ));
        }
        let after = index_entries(&root, Some(&guard.temp)).await?;
        if after == view.index {
            return Err(reject("The selection made no change to the index"));
        }
        publish(guard, &index)?;
        Ok(json!({
            "action": if wanted.action == Action::Stage { "stage" } else { "unstage" },
            "files": wanted.files,
            "hunks": wanted.hunks.values().map(BTreeSet::len).sum::<usize>(),
            "previousRevision": view.revision,
            "indexBefore": digest(&view.index),
            "indexAfter": digest(&after),
        }))
    })
    .await
    .map_err(|_| reject("Staging timed out; nothing was staged"))?
    // Every step before `publish` works on a private copy, and `publish` cannot be
    // interrupted between awaits, so any error here means the index is unchanged.
    .map_err(definite)
}

fn definite(error: anyhow::Error) -> anyhow::Error {
    if error.downcast_ref::<Rejected>().is_some() {
        error
    } else {
        reject(format!("{error:#}. Nothing was changed"))
    }
}

/// The `(mode, oid, path)` set of stage-0 index entries, to compare with a written tree.
fn index_set(index: &[u8]) -> Result<BTreeSet<(String, String, String)>> {
    let mut set = BTreeSet::new();
    for entry in index.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let text = std::str::from_utf8(entry)?;
        let (meta, path) = text.split_once('\t').context("Malformed index entry")?;
        let parts: Vec<_> = meta.split(' ').collect();
        ensure!(
            parts.len() == 3 && parts[2] == "0",
            "Index has unmerged entries"
        );
        set.insert((parts[0].to_owned(), parts[1].to_owned(), path.to_owned()));
    }
    Ok(set)
}

fn tree_set(tree: &[u8]) -> Result<BTreeSet<(String, String, String)>> {
    let mut set = BTreeSet::new();
    for entry in tree.split(|b| *b == 0).filter(|e| !e.is_empty()) {
        let text = std::str::from_utf8(entry)?;
        let (meta, path) = text.split_once('\t').context("Malformed tree entry")?;
        let parts: Vec<_> = meta.split(' ').collect();
        ensure!(parts.len() == 3, "Malformed tree entry");
        set.insert((parts[0].to_owned(), parts[2].to_owned(), path.to_owned()));
    }
    Ok(set)
}

/// Commit exactly the previewed index to the task branch. The tree is written from the
/// index and checked entry by entry against the preview; the branch moves only from the
/// previewed HEAD (compare-and-swap). Unstaged edits and new files stay in the worktree.
pub async fn commit(row: &Value, params: &Value) -> Result<Value> {
    let root = require_isolated(row)?;
    let expected = params["revision"]
        .as_str()
        .ok_or_else(|| reject("Refresh the changes view before committing"))?
        .to_owned();
    let message = params["message"]
        .as_str()
        .ok_or_else(|| reject("Commit message required"))?
        .to_owned();
    if message.trim().is_empty() || message.len() > 4000 {
        return Err(reject("Commit message must contain 1..4000 bytes"));
    }
    let branch = row["managedWorkspace"]["branch"]
        .as_str()
        .context("Task branch missing")?
        .to_owned();
    tokio::time::timeout(DEADLINE, async move {
        let view = view(&root).await?;
        if view.revision != expected {
            return Err(reject(
                "Files or the index changed since this preview. Nothing was committed; review the refreshed changes",
            ));
        }
        if view.branch != branch {
            return Err(reject("The task branch changed; nothing was committed"));
        }
        if !view.conflicts.is_empty() {
            return Err(reject("Resolve merge conflicts before committing"));
        }
        if view.staged.is_empty() {
            return Err(reject("Nothing is staged. Stage files or hunks first"));
        }
        let tree = String::from_utf8(git::run(&root, &["write-tree"], STEP, false).await?)?
            .trim()
            .to_string();
        let written = read(&root, &["ls-tree", "-r", "-z", "--full-tree", &tree]).await?;
        if tree_set(&written)? != index_set(&view.index)? {
            return Err(reject(
                "The index changed while the commit was prepared, or holds intent-to-add entries. Nothing was committed; refresh",
            ));
        }
        let commit = String::from_utf8(
            git::run_with(
                &root,
                &["commit-tree", &tree, "-p", &view.head, "-F", "-"],
                STEP,
                git::Options {
                    input: Some(message.as_bytes()),
                    ..git::Options::default()
                },
            )
            .await?,
        )?
        .trim()
        .to_string();
        let subject = message.lines().next().unwrap_or_default();
        let reflog = format!("commit: {subject}");
        git::run(
            &root,
            &[
                "update-ref",
                "-m",
                &reflog,
                &format!("refs/heads/{branch}"),
                &commit,
                &view.head,
            ],
            STEP,
            false,
        )
        .await
        .map_err(|_| reject("The task branch moved before the commit was recorded; nothing was committed"))?;
        Ok(json!({
            "head": commit,
            "tree": tree,
            "previousHead": view.head,
            "previousRevision": view.revision,
            "files": view.staged.iter().map(|s| s.path.clone()).collect::<Vec<_>>(),
            "unstagedRemaining": view.unstaged.len() + view.untracked.len(),
            "mode": "staged",
        }))
    })
    .await
    // A timeout can stop `update-ref` midway: the branch may or may not have moved.
    .map_err(|_| anyhow::anyhow!("Commit timed out; refresh to see whether the branch moved"))?
    // Before `update-ref` nothing is published, and `update-ref` either moves the branch
    // from the previewed HEAD or fails without moving it.
    .map_err(definite)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(root: &Path, args: &[&str]) -> Result<String> {
        Ok(String::from_utf8(git::run(root, args, STEP, false).await?)?)
    }

    fn lines(n: usize, changed: &[usize]) -> String {
        (1..=n)
            .map(|i| {
                if changed.contains(&i) {
                    format!("line {i} edited\n")
                } else {
                    format!("line {i}\n")
                }
            })
            .collect()
    }

    /// A disposable repository on its task branch, and the session row that owns it.
    async fn fixture(files: &[(&str, String)]) -> Result<(PathBuf, Value)> {
        let base = std::fs::canonicalize(std::env::temp_dir())?
            .join(format!("lascoria-stage-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        std::fs::create_dir_all(&root)?;
        git(&root, &["init", "-q", "-b", "lascoria/t"]).await?;
        git(&root, &["config", "user.name", "Fixture"]).await?;
        git(&root, &["config", "user.email", "fixture@example.invalid"]).await?;
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap())?;
            std::fs::write(path, text)?;
        }
        git(&root, &["add", "-A"]).await?;
        git(&root, &["commit", "-qm", "init"]).await?;
        let row = json!({"id":"t","workspace":root,"managedWorkspace":{"branch":"lascoria/t","path":root}});
        Ok((root, row))
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    fn entry<'a>(changes: &'a Value, side: &str, path: &str) -> Option<&'a Value> {
        changes[side]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["path"] == path)
    }

    fn hunk(changes: &Value, side: &str, path: &str, index: usize) -> Value {
        let id = entry(changes, side, path).unwrap()["hunks"][index]["id"].clone();
        json!({"path": path, "id": id})
    }

    fn rejected(result: Result<Value>) -> String {
        let error = result.unwrap_err();
        assert!(
            error.downcast_ref::<Rejected>().is_some(),
            "expected a definite refusal: {error:#}"
        );
        error.to_string()
    }

    #[test]
    fn header_paths_are_unambiguous_quoted_or_not() {
        assert_eq!(header_path("diff --git a/x b/y b/x b/y").unwrap(), "x b/y");
        assert_eq!(
            header_path(r#"diff --git "a/q\"d \303\274.txt" "b/q\"d \303\274.txt""#).unwrap(),
            "q\"d ü.txt"
        );
        assert!(header_path("diff --git a/x b/z").is_err());
        assert!(header_path(r#"diff --git "a/x" "b/y""#).is_err());
    }

    #[tokio::test]
    async fn hunks_and_files_stage_separately_and_commit_only_the_index() -> Result<()> {
        let (root, row) = fixture(&[
            ("a.txt", lines(30, &[])),
            ("b.txt", "b\n".into()),
            ("c.txt", "c\n".into()),
        ])
        .await?;
        let result = async {
            std::fs::write(root.join("a.txt"), lines(30, &[2, 28]))?;
            std::fs::write(root.join("b.txt"), "b staged before\n")?;
            git(&root, &["add", "b.txt"]).await?;
            std::fs::write(root.join("b.txt"), "b staged before\nand unstaged after\n")?;
            std::fs::write(root.join("c.txt"), "c unstaged\n")?;
            std::fs::write(root.join("d.txt"), "new\n")?;
            let view = changes(&row).await?;
            assert_eq!(entry(&view, "unstaged", "a.txt").unwrap()["hunks"].as_array().unwrap().len(), 2);
            assert!(entry(&view, "staged", "b.txt").is_some());
            assert!(entry(&view, "unstaged", "b.txt").is_some());
            assert_eq!(view["untracked"], json!(["d.txt"]));

            // Stage the first hunk of a.txt and the whole of d.txt, together.
            let staged = stage(&row, &json!({"revision":view["revision"],"action":"stage","files":["d.txt"],"hunks":[hunk(&view,"unstaged","a.txt",0)]})).await?;
            assert_eq!(staged["hunks"], 1);
            // The old view is stale now: the same request again is refused, not replayed.
            let again = rejected(stage(&row, &json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","a.txt",1)]})).await);
            assert!(again.contains("changed since"), "{again}");
            let view = changes(&row).await?;
            let a_staged = entry(&view, "staged", "a.txt").unwrap();
            assert_eq!(a_staged["hunks"].as_array().unwrap().len(), 1);
            assert!(a_staged["hunks"][0]["text"].as_str().unwrap().contains("+line 2 edited"));
            assert!(entry(&view, "unstaged", "a.txt").unwrap()["hunks"][0]["text"].as_str().unwrap().contains("+line 28 edited"));
            assert!(view["stagedPatch"].as_str().unwrap().contains("+line 2 edited"));
            assert!(!view["stagedPatch"].as_str().unwrap().contains("line 28 edited"));

            // Stage line 28 too, then take it back out by its staged hunk.
            stage(&row, &json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","a.txt",0)]})).await?;
            let view = changes(&row).await?;
            assert_eq!(entry(&view, "staged", "a.txt").unwrap()["hunks"].as_array().unwrap().len(), 2);
            assert!(entry(&view, "unstaged", "a.txt").is_none());
            stage(&row, &json!({"revision":view["revision"],"action":"unstage","hunks":[hunk(&view,"staged","a.txt",1)]})).await?;
            let view = changes(&row).await?;
            assert!(entry(&view, "unstaged", "a.txt").unwrap()["hunks"][0]["text"].as_str().unwrap().contains("line 28 edited"));

            // Commit: exactly the staged content; every unselected edit stays in the worktree.
            let before = git(&root, &["rev-parse", "HEAD"]).await?;
            let committed = commit(&row, &json!({"revision":view["revision"],"message":"Selected work"})).await?;
            assert_eq!(committed["previousHead"].as_str().unwrap(), before.trim());
            assert_eq!(git(&root, &["log", "-1", "--format=%s"]).await?.trim(), "Selected work");
            assert_eq!(git(&root, &["show", "HEAD:a.txt"]).await?, lines(30, &[2]));
            assert_eq!(git(&root, &["show", "HEAD:b.txt"]).await?, "b staged before\n");
            assert_eq!(git(&root, &["show", "HEAD:c.txt"]).await?, "c\n");
            assert_eq!(git(&root, &["show", "HEAD:d.txt"]).await?, "new\n");
            assert_eq!(std::fs::read_to_string(root.join("a.txt"))?, lines(30, &[2, 28]));
            assert_eq!(std::fs::read_to_string(root.join("b.txt"))?, "b staged before\nand unstaged after\n");
            assert_eq!(std::fs::read_to_string(root.join("c.txt"))?, "c unstaged\n");
            let after = changes(&row).await?;
            assert!(after["staged"].as_array().unwrap().is_empty());
            let left: BTreeSet<_> = after["unstaged"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap()).collect();
            assert_eq!(left, BTreeSet::from(["a.txt", "b.txt", "c.txt"]));
            // A committed view cannot commit again, and nothing staged cannot commit at all.
            rejected(commit(&row, &json!({"revision":view["revision"],"message":"Twice"})).await);
            let nothing = rejected(commit(&row, &json!({"revision":after["revision"],"message":"Empty"})).await);
            assert!(nothing.contains("Nothing is staged"), "{nothing}");

            // Unstage a whole file, including one that is new to the index.
            stage(&row, &json!({"revision":after["revision"],"action":"stage","files":["c.txt"]})).await?;
            std::fs::write(root.join("e.txt"), "e\n")?;
            let view = changes(&row).await?;
            stage(&row, &json!({"revision":view["revision"],"action":"stage","files":["e.txt"]})).await?;
            let view = changes(&row).await?;
            stage(&row, &json!({"revision":view["revision"],"action":"unstage","files":["c.txt","e.txt"]})).await?;
            let view = changes(&row).await?;
            assert!(view["staged"].as_array().unwrap().is_empty());
            assert!(view["untracked"].as_array().unwrap().contains(&json!("e.txt")));
            assert_eq!(std::fs::read_to_string(root.join("c.txt"))?, "c unstaged\n");
            Ok::<_, anyhow::Error>(())
        }
        .await;
        cleanup(&root);
        result
    }

    #[tokio::test]
    async fn external_edits_index_changes_and_locks_are_refused_without_change() -> Result<()> {
        let (root, row) = fixture(&[("a.txt", lines(10, &[])), ("b.txt", "b\n".into())]).await?;
        let result = async {
            std::fs::write(root.join("a.txt"), lines(10, &[3]))?;
            let index = index_path(&root).await?;
            let view = changes(&row).await?;
            let select = json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","a.txt",0)]});
            // A working-tree edit after the view.
            std::fs::write(root.join("b.txt"), "b changed elsewhere\n")?;
            let before = std::fs::read(&index)?;
            assert!(rejected(stage(&row, &select).await).contains("changed since"));
            assert_eq!(std::fs::read(&index)?, before);
            // An index change made by another Git client.
            let view = changes(&row).await?;
            git(&root, &["add", "b.txt"]).await?;
            let select = json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","a.txt",0)]});
            rejected(stage(&row, &select).await);
            rejected(commit(&row, &json!({"revision":view["revision"],"message":"Stale"})).await);
            assert_eq!(git(&root, &["rev-list", "--count", "HEAD"]).await?.trim(), "1");
            // Another process holding Git's index lock.
            let view = changes(&row).await?;
            let lock = index.with_file_name("index.lock");
            std::fs::write(&lock, "")?;
            let select = json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","a.txt",0)]});
            assert!(rejected(stage(&row, &select).await).contains("Another Git process"));
            assert!(lock.exists(), "never remove a lock that is not ours");
            std::fs::remove_file(&lock)?;
            stage(&row, &select).await?;
            assert!(!lock.exists());
            let leftovers: Vec<_> = std::fs::read_dir(index.parent().unwrap())?
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("index.lascoria-"))
                .collect();
            assert!(leftovers.is_empty());
            // Selections that name nothing real, or mix a file with its hunks, are refused.
            let view = changes(&row).await?;
            rejected(stage(&row, &json!({"revision":view["revision"],"action":"stage","files":["missing.txt"]})).await);
            rejected(stage(&row, &json!({"revision":view["revision"],"action":"stage","hunks":[{"path":"b.txt","id":"0"}]})).await);
            rejected(stage(&row, &json!({"revision":view["revision"],"action":"stage"})).await);
            rejected(stage(&row, &json!({"revision":view["revision"],"action":"discard","files":["b.txt"]})).await);
            rejected(stage(&row, &json!({"revision":view["revision"],"action":"unstage","files":["../outside"]})).await);
            // Only isolated task worktrees can be staged here.
            let plain = json!({"id":"t","workspace":root,"managedWorkspace":null});
            assert!(changes(&plain).await.is_err());
            Ok::<_, anyhow::Error>(())
        }
        .await;
        cleanup(&root);
        result
    }

    #[tokio::test]
    async fn special_paths_are_literal_and_whole_file_cases_are_explained() -> Result<()> {
        let mut files = vec![
            ("space name.txt", lines(12, &[])),
            ("-leading.txt", "dash\n".into()),
            ("ünï.txt", "u\n".into()),
            ("x.txt", "x\n".into()),
            ("binary.bin", "\0\x01\x02".into()),
            ("gone.txt", "bye\n".into()),
        ];
        if cfg!(unix) {
            files.push(("*.txt", "star\n".into()));
            files.push(("q\"d.txt", lines(12, &[])));
            files.push(("run.sh", "echo\n".into()));
        }
        let (root, row) = fixture(&files).await?;
        let result = async {
            std::fs::write(root.join("space name.txt"), lines(12, &[1, 11]))?;
            std::fs::write(root.join("-leading.txt"), "dash edited\n")?;
            std::fs::write(root.join("ünï.txt"), "u edited\n")?;
            std::fs::write(root.join("x.txt"), "x edited\n")?;
            std::fs::write(root.join("binary.bin"), "\0\x01\x03")?;
            std::fs::remove_file(root.join("gone.txt"))?;
            std::fs::create_dir_all(root.join("new dir"))?;
            std::fs::write(root.join("new dir/file.txt"), "n\n")?;
            if cfg!(unix) {
                std::fs::write(root.join("*.txt"), "star edited\n")?;
                std::fs::write(root.join("q\"d.txt"), lines(12, &[2]))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(root.join("run.sh"), std::fs::Permissions::from_mode(0o755))?;
                }
            }
            let view = changes(&row).await?;
            assert_eq!(entry(&view, "unstaged", "binary.bin").unwrap()["wholeOnly"], "Binary files are staged whole");
            assert_eq!(entry(&view, "unstaged", "gone.txt").unwrap()["change"], "deleted");
            assert!(entry(&view, "unstaged", "gone.txt").unwrap()["hunks"].as_array().unwrap().is_empty());
            let binary = rejected(stage(&row, &json!({"revision":view["revision"],"action":"stage","hunks":[{"path":"binary.bin","id":"x"}]})).await);
            assert!(binary.contains("staged whole"), "{binary}");
            let mut whole = vec!["-leading.txt", "ünï.txt", "binary.bin", "gone.txt", "new dir/file.txt"];
            let mut hunks = vec![hunk(&view, "unstaged", "space name.txt", 1)];
            if cfg!(unix) {
                assert_eq!(entry(&view, "unstaged", "run.sh").unwrap()["wholeOnly"], "Permission changes are staged with the whole file");
                whole.extend(["*.txt", "run.sh"]);
                hunks.push(hunk(&view, "unstaged", "q\"d.txt", 0));
            }
            stage(&row, &json!({"revision":view["revision"],"action":"stage","files":whole,"hunks":hunks})).await?;
            let view = changes(&row).await?;
            let staged: BTreeSet<_> = view["staged"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_owned()).collect();
            for path in &whole {
                assert!(staged.contains(*path), "{path} staged");
            }
            // `*.txt` named itself only: x.txt stays unstaged.
            assert!(!staged.contains("x.txt"));
            assert!(entry(&view, "unstaged", "x.txt").is_some());
            assert!(entry(&view, "unstaged", "space name.txt").unwrap()["hunks"][0]["text"].as_str().unwrap().contains("line 1 edited"));
            commit(&row, &json!({"revision":view["revision"],"message":"Special paths"})).await?;
            assert_eq!(git(&root, &["show", "HEAD:space name.txt"]).await?, lines(12, &[11]));
            assert!(git(&root, &["show", "HEAD:gone.txt"]).await.is_err());
            if cfg!(unix) {
                assert_eq!(git(&root, &["show", "HEAD:q\"d.txt"]).await?, lines(12, &[2]));
                assert!(git(&root, &["ls-tree", "HEAD", "run.sh"]).await?.starts_with("100755"));
            }
            assert_eq!(std::fs::read_to_string(root.join("x.txt"))?, "x edited\n");
            Ok::<_, anyhow::Error>(())
        }
        .await;
        cleanup(&root);
        result
    }

    #[tokio::test]
    async fn intent_to_add_is_staged_whole_and_never_committed_inexactly() -> Result<()> {
        let (root, row) = fixture(&[("a.txt", "a\n".into())]).await?;
        let result = async {
            std::fs::write(root.join("planned.txt"), "planned\n")?;
            std::fs::write(root.join("a.txt"), "a edited\n")?;
            git(&root, &["add", "-N", "planned.txt"]).await?;
            git(&root, &["add", "a.txt"]).await?;
            let view = changes(&row).await?;
            let planned = entry(&view, "unstaged", "planned.txt").unwrap();
            assert_eq!(planned["wholeOnly"], "New files are staged whole");
            // A commit while an intent-to-add entry remains would not match the index.
            rejected(
                commit(
                    &row,
                    &json!({"revision":view["revision"],"message":"Inexact"}),
                )
                .await,
            );
            assert_eq!(
                git(&root, &["rev-list", "--count", "HEAD"]).await?.trim(),
                "1"
            );
            stage(
                &row,
                &json!({"revision":view["revision"],"action":"stage","files":["planned.txt"]}),
            )
            .await?;
            let view = changes(&row).await?;
            commit(
                &row,
                &json!({"revision":view["revision"],"message":"Exact"}),
            )
            .await?;
            assert_eq!(
                git(&root, &["show", "HEAD:planned.txt"]).await?,
                "planned\n"
            );
            Ok::<_, anyhow::Error>(())
        }
        .await;
        cleanup(&root);
        result
    }

    #[tokio::test]
    async fn conflicts_filters_and_links_refuse_without_running_or_changing_anything() -> Result<()>
    {
        let (root, row) = fixture(&[("a.txt", "base\n".into())]).await?;
        let result = async {
            git(&root, &["checkout", "-qb", "other"]).await?;
            std::fs::write(root.join("a.txt"), "other\n")?;
            git(&root, &["commit", "-qam", "other"]).await?;
            git(&root, &["checkout", "-q", "lascoria/t"]).await?;
            std::fs::write(root.join("a.txt"), "mine\n")?;
            git(&root, &["commit", "-qam", "mine"]).await?;
            assert!(git(&root, &["merge", "-q", "other"]).await.is_err());
            let view = changes(&row).await?;
            assert_eq!(view["conflicts"], json!(["a.txt"]));
            assert!(
                rejected(
                    stage(
                        &row,
                        &json!({"revision":view["revision"],"action":"stage","files":["a.txt"]})
                    )
                    .await
                )
                .contains("conflicts")
            );
            rejected(commit(&row, &json!({"revision":view["revision"],"message":"No"})).await);
            git(&root, &["merge", "--abort"]).await?;

            // A configured filter selected by attributes is never executed.
            let marker = root.parent().unwrap().join("filter-ran");
            let trap = format!("echo ran > '{}'; cat", marker.display());
            std::fs::write(root.join(".gitattributes"), "*.txt filter=marker\n")?;
            git(&root, &["add", ".gitattributes"]).await?;
            git(&root, &["commit", "-qm", "attributes"]).await?;
            git(&root, &["config", "filter.marker.clean", &trap]).await?;
            std::fs::write(root.join("a.txt"), "filtered\n")?;
            assert!(changes(&row).await.is_err());
            assert!(!marker.exists(), "a clean filter must never run");
            git(&root, &["config", "--unset", "filter.marker.clean"]).await?;
            std::fs::write(root.join("a.txt"), "mine\n")?;

            #[cfg(unix)]
            {
                std::os::unix::fs::symlink("/etc/hosts", root.join("link"))?;
                let error = changes(&row).await.unwrap_err();
                assert!(format!("{error:#}").contains("non-regular"), "{error:#}");
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        cleanup(&root);
        result
    }

    #[tokio::test]
    async fn project_folders_stage_and_commit_only_in_their_own_worktree() -> Result<()> {
        let base = std::fs::canonicalize(std::env::temp_dir())?
            .join(format!("lascoria-stage-roots-{}", uuid::Uuid::new_v4()));
        let result = async {
            let mut folders = Vec::new();
            for (id, name) in [("a", "app"), ("b", "api")] {
                let path = base.join(name);
                std::fs::create_dir_all(&path)?;
                git(&path, &["init", "-q"]).await?;
                git(&path, &["config", "user.name", "Fixture"]).await?;
                git(&path, &["config", "user.email", "fixture@example.invalid"]).await?;
                std::fs::write(path.join("same.txt"), lines(8, &[]))?;
                git(&path, &["add", "."]).await?;
                git(&path, &["commit", "-qm", "init"]).await?;
                folders.push(json!({"id":id,"name":name,"path":path}));
            }
            let parent = base.join("worktrees");
            std::fs::create_dir_all(&parent)?;
            let made = workspace::create_project(&folders, &parent, "s").await?;
            let row = json!({"id":"s","workspace":made[0]["path"],"managedWorkspace":made[0],"managedWorkspaces":made,"projectContext":{"folders":folders}});
            for m in &made {
                std::fs::write(Path::new(m["path"].as_str().unwrap()).join("same.txt"), lines(8, &[4]))?;
            }
            let api = workspace::scoped(&row, Some("b"))?;
            let app = workspace::scoped(&row, Some("a"))?;
            let view = changes(&api).await?;
            // The API view's revision and hunk IDs do not act on the App worktree.
            let app_view = changes(&app).await?;
            assert_ne!(view["revision"], app_view["revision"]);
            rejected(stage(&app, &json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","same.txt",0)]})).await);
            stage(&api, &json!({"revision":view["revision"],"action":"stage","hunks":[hunk(&view,"unstaged","same.txt",0)]})).await?;
            assert!(changes(&app).await?["staged"].as_array().unwrap().is_empty());
            let view = changes(&api).await?;
            commit(&api, &json!({"revision":view["revision"],"message":"API only"})).await?;
            let log = |path: &Path| {
                let path = path.to_owned();
                async move { git(&path, &["log", "-1", "--format=%s", "lascoria/s"]).await }
            };
            assert_eq!(log(&base.join("api")).await?.trim(), "API only");
            assert_eq!(log(&base.join("app")).await?.trim(), "init");
            assert!(git(&base.join("api"), &["status", "--porcelain"]).await?.trim().is_empty());
            Ok::<_, anyhow::Error>(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&base);
        result
    }
}
