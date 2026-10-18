//! Local data lifecycle: consistent backups, validated export/import, restore staged for the
//! next supervisor start, and explicit history cleanup. Nothing here contacts Muse or a model,
//! and nothing deletes a task folder: removed sessions leave their worktrees on disk.
use crate::db::{self, Db, now_ms};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// Retained backup files. The oldest are pruned after each successful backup.
pub const MAX_BACKUPS: usize = 10;
/// Imported or exported files above this size are refused rather than copied.
pub const MAX_BACKUP_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const POLICY: &str = "account-policy-v1";
const LAST_RESTORE: &str = "data:lastRestore";
const PENDING: &str = "restore-pending.json";
const PENDING_DB: &str = "restore-pending.sqlite";
const RELAY: &str = "local-relay-v1";
/// Terminal records older than this may be compacted to tombstones on request.
pub const COMPACT_AFTER_MS: u128 = 7 * 24 * 60 * 60 * 1000;

fn valid_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 100
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Invalid backup identity"
    );
    Ok(())
}

fn backups_dir(root: &Path) -> Result<PathBuf> {
    let dir = root.join("backups");
    lascoria_runtime::platform::private_dir(&dir)?;
    Ok(dir)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

/// Write via a private temporary file in the destination directory, then rename.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("partial-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = lascoria_runtime::platform::private_file(&temporary, true)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn ensure_space(dir: &Path, needed: u64) -> Result<()> {
    let available = fs2::available_space(dir).unwrap_or(u64::MAX);
    // Keep headroom so a backup cannot be what fills the disk.
    let required = needed.saturating_mul(2).saturating_add(64 * 1024 * 1024);
    ensure!(
        available >= required,
        "Not enough free disk space for this backup: about {} MB needed, {} MB available",
        required / 1_000_000,
        available / 1_000_000
    );
    Ok(())
}

/// Validate a candidate journal without modifying it: integrity, schema and required tables.
pub fn inspect_file(path: &Path) -> Result<Value> {
    let meta = fs::symlink_metadata(path).context("Backup file is unavailable")?;
    ensure!(
        meta.is_file() && !meta.is_symlink(),
        "Choose a regular backup file"
    );
    ensure!(
        meta.len() <= MAX_BACKUP_BYTES,
        "Backup file is larger than 4 GB"
    );
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .context("This file is not a Lascoria backup")?;
    let check: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .context("This file is not a Lascoria backup")?;
    ensure!(check == "ok", "Backup failed its integrity check");
    let schema: u32 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    ensure!(
        schema <= db::SCHEMA_VERSION,
        "This backup was made by a newer Lascoria (schema {schema}); install that version to restore it"
    );
    for table in ["sessions", "commands", "presentation"] {
        let present: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [table],
            |row| row.get(0),
        )?;
        ensure!(present, "This file is not a Lascoria backup");
    }
    let sessions: i64 =
        connection.query_row("SELECT count(*) FROM sessions", [], |row| row.get(0))?;
    Ok(json!({"schema":schema,"sessions":sessions,"bytes":meta.len()}))
}

fn manifest_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}
fn backup_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.sqlite"))
}

pub fn list(root: &Path) -> Result<Vec<Value>> {
    let dir = backups_dir(root)?;
    let mut manifests = Vec::new();
    for entry in fs::read_dir(&dir)?.take(4 * MAX_BACKUPS + 16) {
        let path = entry?.path();
        if path.extension().is_some_and(|ext| ext == "json")
            && let Ok(text) = fs::read_to_string(&path)
            && let Ok(manifest) = serde_json::from_str::<Value>(&text)
            && manifest["id"]
                .as_str()
                .is_some_and(|id| backup_path(&dir, id).is_file())
        {
            manifests.push(manifest);
        }
    }
    manifests.sort_by_key(|m| std::cmp::Reverse(m["createdAtMillis"].as_u64().unwrap_or(0)));
    Ok(manifests)
}

fn prune(dir: &Path, root: &Path) -> Result<()> {
    for old in list(root)?.into_iter().skip(MAX_BACKUPS) {
        let id = old["id"].as_str().unwrap_or_default();
        if valid_id(id).is_ok() {
            let _ = fs::remove_file(backup_path(dir, id));
            let _ = fs::remove_file(manifest_path(dir, id));
        }
    }
    Ok(())
}

/// Consistent online snapshot. `VACUUM INTO` reads one transaction, so concurrent journal
/// writers are serialised by the caller's database lock and the copy is never torn.
/// Retrying the same request identity returns the same backup.
pub fn create(db: &Db, root: &Path, id: &str, reason: &str) -> Result<Value> {
    valid_id(id)?;
    let dir = backups_dir(root)?;
    if let Ok(text) = fs::read_to_string(manifest_path(&dir, id)) {
        return Ok(serde_json::from_str(&text)?);
    }
    let size: i64 = db.0.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |row| row.get(0),
    )?;
    ensure_space(&dir, size.max(0) as u64)?;
    let target = backup_path(&dir, id);
    let temporary = dir.join(format!(".{id}.partial-{}", uuid::Uuid::new_v4().simple()));
    let made = (|| {
        db.0.execute(
            "VACUUM INTO ?1",
            [temporary.to_str().context("Non-UTF-8 state path")?],
        )?;
        drop(lascoria_runtime::platform::private_file(&temporary, false)?);
        let details = inspect_file(&temporary)?;
        let digest = sha256_file(&temporary)?;
        fs::rename(&temporary, &target)?;
        Ok::<_, anyhow::Error>((details, digest))
    })();
    let (details, digest) = match made {
        Ok(made) => made,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    let manifest = json!({
        "id": id,
        "createdAtMillis": now_ms() as u64,
        "reason": reason,
        "schema": details["schema"],
        "sessions": details["sessions"],
        "bytes": details["bytes"],
        "sha256": digest,
        "appVersion": env!("CARGO_PKG_VERSION"),
    });
    write_atomic(&manifest_path(&dir, id), manifest.to_string().as_bytes())?;
    prune(&dir, root)?;
    Ok(manifest)
}

fn verified(root: &Path, id: &str) -> Result<(PathBuf, Value)> {
    valid_id(id)?;
    let dir = backups_dir(root)?;
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(manifest_path(&dir, id)).context("Unknown backup")?,
    )?;
    let path = backup_path(&dir, id);
    inspect_file(&path)?;
    ensure!(
        manifest["sha256"].as_str() == Some(sha256_file(&path)?.as_str()),
        "Backup contents changed since it was made; choose another backup"
    );
    Ok((path, manifest))
}

/// Destinations come from the native save dialog. They must be absolute, outside the
/// private state directory and not an existing link.
pub(crate) fn destination(root: &Path, destination: &str) -> Result<(PathBuf, PathBuf)> {
    let destination = PathBuf::from(destination);
    ensure!(
        destination.is_absolute()
            && destination.as_os_str().len() <= 4096
            && destination.file_name().is_some(),
        "Choose an absolute destination file"
    );
    let parent = dunce::canonicalize(
        destination
            .parent()
            .context("Choose a destination folder")?,
    )
    .context("Destination folder is unavailable")?;
    let state = dunce::canonicalize(root)?;
    ensure!(
        !parent.starts_with(&state),
        "Export outside Lascoria's private data folder"
    );
    let destination = parent.join(destination.file_name().unwrap());
    if let Ok(meta) = fs::symlink_metadata(&destination) {
        ensure!(
            meta.is_file() && !meta.is_symlink(),
            "Choose a regular destination file"
        );
    }
    Ok((parent, destination))
}

/// Write a private (0600) file next to the destination, verify it, then rename it into place.
pub(crate) fn publish(
    parent: &Path,
    destination: &Path,
    write: impl FnOnce(&mut fs::File) -> Result<()>,
    check: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let temporary = parent.join(format!(
        ".lascoria-export-{}.partial",
        uuid::Uuid::new_v4().simple()
    ));
    let result = (|| {
        let mut output = lascoria_runtime::platform::private_file(&temporary, true)?;
        write(&mut output)?;
        output.sync_all()?;
        drop(output);
        check(&temporary)?;
        fs::rename(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn export(root: &Path, id: &str, destination: &str) -> Result<Value> {
    let (source, manifest) = verified(root, id)?;
    let (parent, destination) = self::destination(root, destination)?;
    ensure_space(&parent, manifest["bytes"].as_u64().unwrap_or(0))?;
    publish(
        &parent,
        &destination,
        |output| {
            std::io::copy(&mut fs::File::open(&source)?, output)?;
            Ok(())
        },
        |written| {
            ensure!(
                sha256_file(written)? == manifest["sha256"].as_str().unwrap_or_default(),
                "Export copy did not match the backup"
            );
            Ok(())
        },
    )?;
    Ok(json!({"exported":id,"path":destination,"sha256":manifest["sha256"]}))
}

/// `YYYY-MM-DDTHH:MM:SSZ` from Unix milliseconds (civil-from-days, proleptic Gregorian).
fn iso_utc(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// Largest transcript export; the retained window is bounded, but message text is not.
const TRANSCRIPT_LIMIT: usize = 16 * 1024 * 1024;

/// Markdown of the messages Lascoria retains for one session (D3). What the user typed is shown
/// (`displayText`), images are noted rather than embedded, and the header says which window
/// the file covers. Nothing is fetched from Muse.
pub fn transcript_markdown(row: &Value, name: &str) -> String {
    let mut out = format!("# {name}\n\n");
    let items = row["state"]["items"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let total = row["state"]["totalItems"]
        .as_u64()
        .unwrap_or(items.len() as u64);
    out.push_str(&format!(
        "- Session: `{}`\n- Folder: `{}`\n- Exported: {}\n- Contains the {} most recent of {} messages Lascoria keeps for this session. Muse keeps the full history.\n\n",
        row["id"].as_str().unwrap_or_default(),
        row["workspace"].as_str().unwrap_or_default(),
        iso_utc(crate::db::now_ms()),
        items.len(),
        total
    ));
    for item in items {
        let text = item["displayText"]
            .as_str()
            .or(item["text"].as_str())
            .unwrap_or_default()
            .trim_end();
        let when = item["recordedAt"].as_str().unwrap_or("time not reported");
        let section = match item["kind"].as_str().unwrap_or_default() {
            "userMessage" => {
                let images = item["attachments"].as_array().map_or(0, Vec::len);
                let note = match images {
                    0 => String::new(),
                    1 => "\n\n_1 image attached_".into(),
                    n => format!("\n\n_{n} images attached_"),
                };
                format!("## You · {when}\n\n{text}{note}")
            }
            "agentMessage" => format!("## Muse · {when}\n\n{text}"),
            "toolCall" => format!(
                "### Tool · {} · {when}\n\n{}",
                item["name"].as_str().unwrap_or("tool"),
                item["statusLine"]
                    .as_str()
                    .unwrap_or(item["status"].as_str().unwrap_or(""))
            ),
            other if !text.is_empty() => format!("### {other} · {when}\n\n{text}"),
            _ => continue,
        };
        out.push_str(&section);
        out.push_str("\n\n");
    }
    out
}

pub fn export_transcript(db: &Db, root: &Path, params: &Value) -> Result<Value> {
    let session = params["sessionId"].as_str().context("Session required")?;
    let row = db.get("sessions", session)?.context("Unknown session")?;
    let path = params["path"].as_str().context("Destination required")?;
    ensure!(
        Path::new(path)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md")),
        "Save the transcript as a .md file"
    );
    let name = crate::session_names::list(db)?
        .into_iter()
        .find(|s| s["id"] == session)
        .and_then(|s| s["displayName"].as_str().map(str::to_owned))
        .unwrap_or_else(|| "Lascoria session".into());
    let markdown = transcript_markdown(&row, &name);
    ensure!(
        markdown.len() <= TRANSCRIPT_LIMIT,
        "This transcript is larger than 16 MB"
    );
    let (parent, destination) = destination(root, path)?;
    ensure_space(&parent, markdown.len() as u64)?;
    publish(
        &parent,
        &destination,
        |output| Ok(output.write_all(markdown.as_bytes())?),
        |written| {
            ensure!(
                fs::metadata(written)?.len() == markdown.len() as u64,
                "Transcript was not written completely"
            );
            Ok(())
        },
    )?;
    Ok(
        json!({"path":destination,"bytes":markdown.len(),"messages":row["state"]["items"].as_array().map_or(0, Vec::len)}),
    )
}

/// Copy a file chosen by the user into the private backup set after validation.
pub fn import(root: &Path, id: &str, source: &str) -> Result<Value> {
    valid_id(id)?;
    let dir = backups_dir(root)?;
    if let Ok(text) = fs::read_to_string(manifest_path(&dir, id)) {
        return Ok(serde_json::from_str(&text)?);
    }
    let source = PathBuf::from(source);
    ensure!(source.is_absolute(), "Choose an absolute backup file");
    let details = inspect_file(&source)?;
    ensure_space(&dir, details["bytes"].as_u64().unwrap_or(0))?;
    let temporary = dir.join(format!(".{id}.partial-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut output = lascoria_runtime::platform::private_file(&temporary, true)?;
        std::io::copy(&mut fs::File::open(&source)?, &mut output)?;
        output.sync_all()?;
        drop(output);
        // Validate the private copy, not only the user's file, which can change underneath us.
        let details = inspect_file(&temporary)?;
        let digest = sha256_file(&temporary)?;
        fs::rename(&temporary, backup_path(&dir, id))?;
        Ok::<_, anyhow::Error>((details, digest))
    })();
    let (details, digest) = match result {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    };
    let manifest = json!({"id":id,"createdAtMillis":now_ms() as u64,"reason":"imported","schema":details["schema"],"sessions":details["sessions"],"bytes":details["bytes"],"sha256":digest,"appVersion":env!("CARGO_PKG_VERSION")});
    write_atomic(&manifest_path(&dir, id), manifest.to_string().as_bytes())?;
    prune(&dir, root)?;
    Ok(manifest)
}

/// Restore never replaces the open journal. It stages a verified copy that the next
/// supervisor start applies before any session, worker or IPC client exists.
pub fn stage_restore(root: &Path, id: &str) -> Result<Value> {
    let (source, manifest) = verified(root, id)?;
    ensure_space(root, manifest["bytes"].as_u64().unwrap_or(0))?;
    let staged = root.join(PENDING_DB);
    let temporary = root.join(format!(".{PENDING_DB}.partial"));
    let _ = fs::remove_file(&temporary);
    let copied = (|| {
        let mut output = lascoria_runtime::platform::private_file(&temporary, true)?;
        std::io::copy(&mut fs::File::open(&source)?, &mut output)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temporary, &staged)?;
        Ok::<_, anyhow::Error>(())
    })();
    if copied.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    copied?;
    let pending = json!({"backupId":id,"sha256":manifest["sha256"],"stagedAtMillis":now_ms() as u64,"phase":"staged"});
    write_atomic(&root.join(PENDING), pending.to_string().as_bytes())?;
    Ok(json!({"pendingRestore":pending,"restartRequired":true}))
}

pub fn cancel_restore(root: &Path) -> Result<Value> {
    let pending = pending(root)?;
    ensure!(
        pending.as_ref().is_none_or(|p| p["phase"] == "staged"),
        "Restore is already being applied"
    );
    let _ = fs::remove_file(root.join(PENDING_DB));
    let _ = fs::remove_file(root.join(PENDING));
    Ok(json!({"pendingRestore":null}))
}

pub fn pending(root: &Path) -> Result<Option<Value>> {
    match fs::read_to_string(root.join(PENDING)) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Called before `Db::open` on startup. Crash-safe in three phases:
/// 1. back up the current journal and record the current account policy;
/// 2. rename the staged copy over the journal (atomic within one directory);
/// 3. reinstate the current account policy and record the outcome.
///
/// Account policy is preserved because restoring an older billing route must never switch
/// a user between subscription and API-key use. Credentials stay in the native vault.
pub fn apply_pending_restore(root: &Path, database: &Path) -> Result<Option<Value>> {
    let Some(mut pending) = pending(root)? else {
        return Ok(None);
    };
    let staged = root.join(PENDING_DB);
    if pending["phase"] == "staged" {
        // Everything before the swap is abandonable: if verification or the safety backup
        // fails (for example on a full disk), the journal is untouched and startup continues.
        // Failing startup instead would leave no running service to cancel the restore from.
        let prepared = (|| {
            inspect_file(&staged)?;
            ensure!(
                pending["sha256"].as_str() == Some(sha256_file(&staged)?.as_str()),
                "Staged restore changed after it was verified"
            );
            let current = Db::open(database)?;
            let safety = create(
                &current,
                root,
                &format!("before-restore-{}", now_ms()),
                "beforeRestore",
            )?;
            let mut next = pending.clone();
            next["policy"] = current.get("presentation", POLICY)?.unwrap_or(Value::Null);
            next["safetyBackupId"] = safety["id"].clone();
            next["phase"] = json!("swapping");
            drop(current);
            write_atomic(&root.join(PENDING), next.to_string().as_bytes())?;
            Ok::<_, anyhow::Error>(next)
        })();
        match prepared {
            Ok(next) => pending = next,
            Err(error) => {
                let _ = fs::remove_file(&staged);
                let _ = fs::remove_file(root.join(PENDING));
                let current = Db::open(database)?;
                let outcome = json!({"status":"failed","backupId":pending["backupId"],"error":format!("Restore was not applied and your current data is unchanged: {error:#}"),"atMillis":now_ms() as u64});
                current.put("presentation", LAST_RESTORE, &outcome)?;
                return Ok(Some(outcome));
            }
        }
    }
    if pending["phase"] == "swapping" {
        if staged.exists() {
            let _ = fs::remove_file(database.with_extension("sqlite-journal"));
            fs::rename(&staged, database)?;
        }
        let restored = Db::open(database)?;
        if pending["policy"].is_null() {
            restored
                .0
                .execute("DELETE FROM presentation WHERE id=?1", [POLICY])?;
        } else {
            restored.put("presentation", POLICY, &pending["policy"])?;
        }
        let outcome = json!({"status":"restored","backupId":pending["backupId"],"safetyBackupId":pending["safetyBackupId"],"atMillis":now_ms() as u64});
        restored.put("presentation", LAST_RESTORE, &outcome)?;
        drop(restored);
        fs::remove_file(root.join(PENDING))?;
        return Ok(Some(outcome));
    }
    bail!("Unrecognised restore state; remove {PENDING} after checking backups")
}

fn relay_sessions(db: &Db) -> Result<std::collections::HashSet<String>> {
    let mut ids = std::collections::HashSet::new();
    if let Some(state) = db.get("presentation", RELAY)? {
        for connection in state["connections"].as_array().into_iter().flatten() {
            for id in connection["sessions"].as_array().into_iter().flatten() {
                ids.extend(id.as_str().map(str::to_owned));
            }
        }
        for message in state["messages"].as_array().into_iter().flatten() {
            ids.extend(message["from"].as_str().map(str::to_owned));
            ids.extend(message["to"].as_str().map(str::to_owned));
        }
    }
    Ok(ids)
}

/// Bounded counts for Settings. Never reads transcripts or command payloads into memory.
pub fn summary(db: &Db, root: &Path) -> Result<Value> {
    let (sessions, archived): (i64, i64) = db.0.query_row(
        "SELECT count(*), count(*) FILTER (WHERE json_extract(value,'$.lifecycle')='archived') FROM sessions",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let (rows, full): (i64, i64) = db.0.query_row(
        "SELECT count(*), count(*) FILTER (WHERE json_extract(value,'$.compacted') IS NULL) FROM commands",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let cutoff = now_ms().saturating_sub(COMPACT_AFTER_MS) as i64;
    let compactable: i64 = db.0.query_row(
        "SELECT count(*) FROM commands WHERE json_extract(value,'$.compacted') IS NULL
           AND json_extract(value,'$.status') IN ('applied','rejected')
           AND json_extract(value,'$.operation') <> 'workspace/run'
           AND id NOT LIKE 'relay\\_%' ESCAPE '\\'
           AND coalesce(json_extract(value,'$.createdAtMillis'),0) < ?1",
        [cutoff],
        |row| row.get(0),
    )?;
    let bytes: i64 = db.0.query_row(
        "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
        [],
        |row| row.get(0),
    )?;
    let relay = relay_sessions(db)?;
    let mut removable = Vec::new();
    let mut statement = db.0.prepare(
        "SELECT s.id, json_extract(s.value,'$.archivedAtMillis'), json_extract(s.value,'$.workspace'),
                json_extract(s.value,'$.managedWorkspace.path'), json_extract(s.value,'$.workspaceDiscarded'),
                json_extract(n.value,'$.name'), json_extract(s.value,'$.initialName')
           FROM sessions s LEFT JOIN presentation n ON n.id='session-name:' || s.id
          WHERE json_extract(s.value,'$.lifecycle')='archived' ORDER BY s.rowid LIMIT 200",
    )?;
    for row in statement.query_map([], |row| {
        Ok(json!({
            "sessionId": row.get::<_, String>(0)?,
            "archivedAtMillis": row.get::<_, Option<i64>>(1)?,
            "workspace": row.get::<_, Option<String>>(2)?,
            "retainedWorktree": if row.get::<_, Option<bool>>(4)?.unwrap_or(false) { None } else { row.get::<_, Option<String>>(3)? },
            "name": row.get::<_, Option<String>>(5)?.or(row.get::<_, Option<String>>(6)?),
        }))
    })? {
        let mut row = row?;
        let id = row["sessionId"].as_str().unwrap_or_default().to_owned();
        row["hasLocalMessages"] = json!(relay.contains(&id));
        removable.push(row);
    }
    Ok(json!({
        "sessions": sessions,
        "archivedSessions": archived,
        "sessionLimit": 100,
        "journalEntries": full,
        "journalLimit": db::JOURNAL_LIMIT,
        "journalRows": rows,
        "journalRowLimit": db::JOURNAL_ROW_LIMIT,
        "compactableEntries": compactable,
        "databaseBytes": bytes,
        "schema": db::SCHEMA_VERSION,
        "archived": removable,
        "backups": list(root)?,
        "pendingRestore": pending(root)?,
        "lastRestore": db.get("presentation", LAST_RESTORE)?,
    }))
}

fn tombstone(command: &Value) -> Value {
    json!({
        "id": command["id"],
        "operation": command["operation"],
        "sessionId": command["sessionId"],
        "commandId": command["commandId"],
        "status": command["status"],
        "createdAtMillis": command["createdAtMillis"],
        "compacted": true,
        "compactedAtMillis": now_ms() as u64,
    })
}

/// Removes archived sessions chosen by the user. A backup is made first, under the same lock,
/// so removal is reversible through restore. Command records become tombstones so a late
/// retry of the same request is refused instead of replayed. Task folders are never deleted.
pub fn remove_archived(
    db: &Db,
    root: &Path,
    request_id: &str,
    sessions: &[String],
) -> Result<Value> {
    valid_id(request_id)?;
    ensure!(
        !sessions.is_empty() && sessions.len() <= 200,
        "Choose 1 to 200 archived sessions"
    );
    let receipt_key = format!("data:cleanup:{request_id}");
    if let Some(receipt) = db.get("presentation", &receipt_key)? {
        ensure!(
            receipt["sessions"] == json!(sessions),
            "Cleanup retry changed its sessions"
        );
        return Ok(receipt);
    }
    let relay = relay_sessions(db)?;
    let mut retained = Vec::new();
    for id in sessions {
        let row = db.get("sessions", id)?.context("Unknown session")?;
        ensure!(
            row["lifecycle"] == "archived",
            "Only archived sessions can be removed"
        );
        ensure!(
            !relay.contains(id),
            "Disconnect and clear local messages before removing a session that has them"
        );
        if row["workspaceDiscarded"] != true
            && let Some(path) = row["managedWorkspace"]["path"].as_str()
        {
            retained.push(json!({"sessionId":id,"path":path}));
        }
    }
    let backup = create(
        db,
        root,
        &format!("before-cleanup-{request_id}"),
        "beforeCleanup",
    )?;
    let transaction = db.0.unchecked_transaction()?;
    let mut tombstoned = 0;
    for id in sessions {
        let mut statement = transaction.prepare(
            "SELECT id, value FROM commands WHERE json_extract(value,'$.sessionId')=?1 AND json_extract(value,'$.compacted') IS NULL",
        )?;
        let commands: Vec<(String, String)> = statement
            .query_map([id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        drop(statement);
        for (command_id, value) in commands {
            let value: Value = serde_json::from_str(&value)?;
            transaction.execute(
                "UPDATE commands SET value=?2 WHERE id=?1",
                params![command_id, tombstone(&value).to_string()],
            )?;
            tombstoned += 1;
        }
        // Keep only the paid-request identity after session removal. Full questions,
        // answers and source metadata are removed, while delayed retries cannot spend again.
        transaction.execute("UPDATE decisions SET value=json_object('id',id,'fingerprint',json_extract(value,'$.fingerprint'),'provider',json_extract(value,'$.provider'),'purpose',json_extract(value,'$.purpose'),'status','retained','createdAtMillis',json_extract(value,'$.createdAtMillis'),'detailsPruned',json('true'),'message','Full advice data was removed with the session. This request will not be sent again') WHERE json_extract(value,'$.source.sessionId')=?1",[id])?;
        for table in ["artifacts", "evidence"] {
            transaction.execute(
                &format!("DELETE FROM {table} WHERE json_extract(value,'$.sessionId')=?1"),
                [id],
            )?;
        }
        for key in [format!("draft:{id}"), format!("session-name:{id}")] {
            transaction.execute("DELETE FROM presentation WHERE id=?1", [key])?;
        }
        transaction.execute("DELETE FROM sessions WHERE id=?1", [id])?;
        crate::attachments::remove_session(root, id);
    }
    let receipt = json!({"requestId":request_id,"sessions":sessions,"backupId":backup["id"],"tombstoned":tombstoned,"retainedWorktrees":retained,"atMillis":now_ms() as u64});
    transaction.execute(
        "INSERT INTO presentation VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        params![receipt_key, receipt.to_string()],
    )?;
    transaction.commit()?;
    Ok(receipt)
}

/// Replaces old terminal records with tombstones. Test runs keep their output, local-message
/// deliveries keep their reconciliation payload and uncertain or running records are untouched.
pub fn compact(db: &Db, root: &Path, request_id: &str) -> Result<Value> {
    valid_id(request_id)?;
    let receipt_key = format!("data:compact:{request_id}");
    if let Some(receipt) = db.get("presentation", &receipt_key)? {
        return Ok(receipt);
    }
    let cutoff = now_ms().saturating_sub(COMPACT_AFTER_MS) as i64;
    let backup = create(
        db,
        root,
        &format!("before-compact-{request_id}"),
        "beforeCompact",
    )?;
    let transaction = db.0.unchecked_transaction()?;
    let mut statement = transaction.prepare(
        "SELECT id, value FROM commands WHERE json_extract(value,'$.compacted') IS NULL
           AND json_extract(value,'$.status') IN ('applied','rejected')
           AND json_extract(value,'$.operation') <> 'workspace/run'
           AND id NOT LIKE 'relay\\_%' ESCAPE '\\'
           AND coalesce(json_extract(value,'$.createdAtMillis'),0) < ?1",
    )?;
    let commands: Vec<(String, String)> = statement
        .query_map([cutoff], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    drop(statement);
    for (command_id, value) in &commands {
        let value: Value = serde_json::from_str(value)?;
        transaction.execute(
            "UPDATE commands SET value=?2 WHERE id=?1",
            params![command_id, tombstone(&value).to_string()],
        )?;
    }
    let receipt = json!({"requestId":request_id,"compacted":commands.len(),"backupId":backup["id"],"atMillis":now_ms() as u64});
    transaction.execute(
        "INSERT INTO presentation VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        params![receipt_key, receipt.to_string()],
    )?;
    transaction.commit()?;
    // Return freed pages to the operating system; no-op when nothing changed.
    if !commands.is_empty() {
        db.0.execute_batch("VACUUM")?;
    }
    Ok(receipt)
}

/// IPC entry point. All operations hold the journal lock for their duration so no writer
/// interleaves with a snapshot or cleanup.
pub fn handle(
    db: &Db,
    root: &Path,
    operation: &str,
    params: &Value,
    request_id: &str,
) -> Result<Value> {
    ensure!(params.is_object(), "Params must be an object");
    match operation {
        "data/summary" => summary(db, root),
        "data/backup" => create(db, root, request_id, "manual"),
        "data/export" => export(
            root,
            params["backupId"].as_str().context("Backup required")?,
            params["path"].as_str().context("Destination required")?,
        ),
        "data/import" => import(
            root,
            request_id,
            params["path"].as_str().context("Backup file required")?,
        ),
        "data/restore" => stage_restore(
            root,
            params["backupId"].as_str().context("Backup required")?,
        ),
        "data/cancelRestore" => cancel_restore(root),
        "data/removeArchived" => {
            let sessions: Vec<String> = params["sessionIds"]
                .as_array()
                .context("Choose archived sessions")?
                .iter()
                .map(|id| id.as_str().map(str::to_owned).context("Invalid session"))
                .collect::<Result<_>>()?;
            remove_archived(db, root, request_id, &sessions)
        }
        "data/compact" => compact(db, root, request_id),
        "data/transcript" => export_transcript(db, root, params),
        _ => bail!("Unsupported data operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("lascoria-data-{}", uuid::Uuid::new_v4()));
            lascoria_runtime::platform::private_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seeded(root: &Path) -> Result<Db> {
        let db = Db::open(&root.join("state.sqlite"))?;
        db.put(
            "sessions",
            "live",
            &json!({"id":"live","lifecycle":"connected","state":{"items":[{"text":"keep"}]}}),
        )?;
        db.put("sessions", "old", &json!({"id":"old","lifecycle":"archived","archivedAtMillis":1,"managedWorkspace":{"path":"/tmp/worktree-old"},"state":{"items":[{"text":"old"}]}}))?;
        db.put("commands", "c-old", &json!({"id":"c-old","operation":"turn","params":{"sessionId":"old","text":"x"},"sessionId":"old","status":"applied","createdAtMillis":1}))?;
        db.put("commands", "c-live", &json!({"id":"c-live","operation":"turn","params":{"sessionId":"live","text":"y"},"sessionId":"live","status":"applied","createdAtMillis":1}))?;
        db.put("commands", "c-run", &json!({"id":"c-run","operation":"workspace/run","params":{},"sessionId":"live","status":"applied","createdAtMillis":1,"output":"tests ok"}))?;
        db.put("commands", "c-unknown", &json!({"id":"c-unknown","operation":"turn","params":{},"sessionId":"live","status":"outcomeUnknown","createdAtMillis":1}))?;
        db.put("presentation", "draft:old", &json!({"text":"draft"}))?;
        db.put(
            "presentation",
            POLICY,
            &json!({"mode":"subscription","epoch":5}),
        )?;
        Ok(db)
    }

    #[test]
    fn backup_is_consistent_verified_retry_stable_and_bounded() -> Result<()> {
        let root = Root::new();
        let db = seeded(&root.0)?;
        let first = create(&db, &root.0, "b1", "manual")?;
        assert_eq!(first["sessions"], 2);
        assert_eq!(first["schema"], db::SCHEMA_VERSION);
        // Same identity returns the same backup without another snapshot.
        assert_eq!(create(&db, &root.0, "b1", "manual")?, first);
        verified(&root.0, "b1")?;
        // Tampering is detected before restore or export.
        let path = root.0.join("backups/b1.sqlite");
        let mut bytes = fs::read(&path)?;
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        fs::write(&path, bytes)?;
        assert!(verified(&root.0, "b1").is_err());
        for index in 0..MAX_BACKUPS + 3 {
            create(&db, &root.0, &format!("n{index}"), "manual")?;
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert_eq!(list(&root.0)?.len(), MAX_BACKUPS);
        assert!(create(&db, &root.0, "../escape", "manual").is_err());
        Ok(())
    }

    #[test]
    fn restore_is_staged_preserves_account_policy_and_survives_a_crash_mid_swap() -> Result<()> {
        let root = Root::new();
        let database = root.0.join("state.sqlite");
        let db = seeded(&root.0)?;
        create(&db, &root.0, "before", "manual")?;
        // Later work and a later billing choice that the restore must not undo.
        db.put(
            "sessions",
            "later",
            &json!({"id":"later","lifecycle":"connected"}),
        )?;
        db.put("presentation", POLICY, &json!({"mode":"apiKey","epoch":9}))?;
        stage_restore(&root.0, "before")?;
        assert_eq!(pending(&root.0)?.unwrap()["phase"], "staged");
        drop(db);
        // Simulate a crash after phase 1 recorded the swap but before it happened.
        let mut state = pending(&root.0)?.unwrap();
        let current = Db::open(&database)?;
        state["policy"] = current.get("presentation", POLICY)?.unwrap();
        state["phase"] = json!("swapping");
        drop(current);
        write_atomic(&root.0.join(PENDING), state.to_string().as_bytes())?;
        let outcome = apply_pending_restore(&root.0, &database)?.unwrap();
        assert_eq!(outcome["status"], "restored");
        let restored = Db::open(&database)?;
        assert!(restored.get("sessions", "later")?.is_none());
        assert!(restored.get("sessions", "old")?.is_some());
        assert_eq!(
            restored.get("presentation", POLICY)?.unwrap()["mode"],
            "apiKey"
        );
        assert!(pending(&root.0)?.is_none());
        assert!(apply_pending_restore(&root.0, &database)?.is_none());
        Ok(())
    }

    #[test]
    fn full_restore_backs_up_current_data_first_and_rejects_tampered_staging() -> Result<()> {
        let root = Root::new();
        let database = root.0.join("state.sqlite");
        let db = seeded(&root.0)?;
        create(&db, &root.0, "snap", "manual")?;
        db.put(
            "sessions",
            "later",
            &json!({"id":"later","lifecycle":"connected"}),
        )?;
        stage_restore(&root.0, "snap")?;
        drop(db);
        let outcome = apply_pending_restore(&root.0, &database)?.unwrap();
        let safety = outcome["safetyBackupId"].as_str().unwrap();
        assert!(
            list(&root.0)?
                .iter()
                .any(|b| b["id"] == safety && b["reason"] == "beforeRestore" && b["sessions"] == 3)
        );

        // A staged file altered after verification is discarded and the journal kept.
        let db = Db::open(&database)?;
        stage_restore(&root.0, "snap")?;
        db.put("sessions", "kept", &json!({"id":"kept"}))?;
        drop(db);
        fs::write(root.0.join(PENDING_DB), b"not sqlite")?;
        let outcome = apply_pending_restore(&root.0, &database)?.unwrap();
        assert_eq!(outcome["status"], "failed");
        assert!(Db::open(&database)?.get("sessions", "kept")?.is_some());
        Ok(())
    }

    #[test]
    fn restore_that_cannot_make_its_safety_backup_is_abandoned_without_blocking_startup()
    -> Result<()> {
        let root = Root::new();
        let database = root.0.join("state.sqlite");
        let db = seeded(&root.0)?;
        create(&db, &root.0, "snap", "manual")?;
        db.put("sessions", "later", &json!({"id":"later"}))?;
        stage_restore(&root.0, "snap")?;
        drop(db);
        // The backup folder becomes unusable, as on a full or read-only disk.
        fs::rename(root.0.join("backups"), root.0.join("moved-backups"))?;
        fs::write(root.0.join("backups"), b"not a folder")?;
        let outcome = apply_pending_restore(&root.0, &database)?.unwrap();
        assert_eq!(outcome["status"], "failed");
        assert!(outcome["error"].as_str().unwrap().contains("unchanged"));
        assert!(pending(&root.0)?.is_none());
        assert!(!root.0.join(PENDING_DB).exists());
        let current = Db::open(&database)?;
        assert!(current.get("sessions", "later")?.is_some());
        assert_eq!(
            current.get("presentation", LAST_RESTORE)?.unwrap()["status"],
            "failed"
        );
        drop(current);
        // The next start is ordinary.
        assert!(apply_pending_restore(&root.0, &database)?.is_none());
        Ok(())
    }

    #[test]
    fn transcript_export_shows_typed_text_notes_images_and_stays_outside_private_state()
    -> Result<()> {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(1_792_260_000_000), "2026-10-17T18:00:00Z");
        assert_eq!(iso_utc(951_782_400_000), "2000-02-29T00:00:00Z");
        let root = Root::new();
        let db = seeded(&root.0)?;
        db.put("sessions", "t", &json!({"id":"t","workspace":"/w","lifecycle":"connected","state":{"totalItems":250,"items":[
            {"kind":"userMessage","text":"Lascoria note: model only. Fix it","displayText":"Fix it","attachments":[{"type":"image"}],"recordedAt":"2026-10-17T18:00:00Z"},
            {"kind":"toolCall","name":"bash","statusLine":"ran tests"},
            {"kind":"agentMessage","text":"Done."},
            {"kind":"reasoning"}
        ]}}))?;
        let outside = root.0.join("outside");
        fs::create_dir_all(&outside)?;
        let inside = root.0.join("state-copy");
        // The private root is `root.0`, so a destination under it is refused.
        let private = Root::new();
        let file = outside.join("t.md");
        let result = export_transcript(&db, &private.0, &json!({"sessionId":"t","path":file}))?;
        let text = fs::read_to_string(&file)?;
        assert!(text.contains("## You · 2026-10-17T18:00:00Z\n\nFix it\n\n_1 image attached_"));
        assert!(!text.contains("Lascoria note"));
        assert!(text.contains("### Tool · bash"));
        assert!(text.contains("## Muse"));
        assert!(text.contains("4 most recent of 250"));
        assert_eq!(result["messages"], 4);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&file)?.permissions().mode() & 0o777, 0o600);
        }
        assert!(
            export_transcript(
                &db,
                &root.0,
                &json!({"sessionId":"t","path":inside.join("t.md")})
            )
            .is_err()
        );
        assert!(
            export_transcript(
                &db,
                &private.0,
                &json!({"sessionId":"t","path":outside.join("t.txt")})
            )
            .is_err()
        );
        assert!(
            export_transcript(
                &db,
                &private.0,
                &json!({"sessionId":"missing","path":outside.join("m.md")})
            )
            .is_err()
        );
        Ok(())
    }

    #[test]
    fn newer_schema_and_non_backups_are_refused() -> Result<()> {
        let root = Root::new();
        let path = root.0.join("newer.sqlite");
        let connection = Connection::open(&path)?;
        connection.execute_batch("CREATE TABLE sessions(id TEXT PRIMARY KEY, value TEXT); CREATE TABLE commands(id TEXT PRIMARY KEY, value TEXT); CREATE TABLE presentation(id TEXT PRIMARY KEY, value TEXT); PRAGMA user_version=99;")?;
        drop(connection);
        assert!(
            inspect_file(&path)
                .unwrap_err()
                .to_string()
                .contains("newer")
        );
        assert!(import(&root.0, "imp", path.to_str().unwrap()).is_err());
        let other = root.0.join("other.sqlite");
        Connection::open(&other)?.execute_batch("CREATE TABLE t(x)")?;
        assert!(inspect_file(&other).is_err());
        fs::write(root.0.join("text.sqlite"), "hello")?;
        assert!(inspect_file(&root.0.join("text.sqlite")).is_err());
        Ok(())
    }

    #[test]
    fn export_and_import_round_trip_outside_private_state() -> Result<()> {
        let root = Root::new();
        let outside = Root::new();
        let db = seeded(&root.0)?;
        create(&db, &root.0, "b", "manual")?;
        let destination = outside.0.join("lascoria-backup.sqlite");
        export(&root.0, "b", destination.to_str().unwrap())?;
        assert!(export(&root.0, "b", root.0.join("inside.sqlite").to_str().unwrap()).is_err());
        assert!(export(&root.0, "b", "relative.sqlite").is_err());
        let imported = import(&root.0, "imported1", destination.to_str().unwrap())?;
        assert_eq!(imported["reason"], "imported");
        assert_eq!(imported["sessions"], 2);
        assert_eq!(
            import(&root.0, "imported1", destination.to_str().unwrap())?,
            imported
        );
        Ok(())
    }

    #[test]
    fn removing_archived_sessions_tombstones_requests_and_keeps_live_work() -> Result<()> {
        let root = Root::new();
        let db = seeded(&root.0)?;
        assert!(remove_archived(&db, &root.0, "r0", &["live".into()]).is_err());
        let receipt = remove_archived(&db, &root.0, "r1", &["old".into()])?;
        assert_eq!(receipt["tombstoned"], 1);
        assert_eq!(receipt["retainedWorktrees"][0]["path"], "/tmp/worktree-old");
        assert!(db.get("sessions", "old")?.is_none());
        assert!(db.get("presentation", "draft:old")?.is_none());
        assert_eq!(
            db.get("sessions", "live")?.unwrap()["state"]["items"][0]["text"],
            "keep"
        );
        // Identity survives without payload; a retry is refused, never replayed.
        let tomb = db.get("commands", "c-old")?.unwrap();
        assert_eq!(tomb["compacted"], true);
        assert!(tomb.get("params").is_none());
        assert!(
            db::same_request(&tomb, "turn", &json!({"sessionId":"old","text":"x"}))
                .unwrap_err()
                .to_string()
                .contains("compacted history")
        );
        // Exact retry returns the receipt; a changed retry is refused.
        assert_eq!(
            remove_archived(&db, &root.0, "r1", &["old".into()])?,
            receipt
        );
        assert!(remove_archived(&db, &root.0, "r1", &["live".into()]).is_err());
        // Restoring the automatic backup brings the session back.
        assert!(
            list(&root.0)?
                .iter()
                .any(|b| b["id"] == receipt["backupId"] && b["sessions"] == 2)
        );
        Ok(())
    }

    #[test]
    fn sessions_with_local_messages_are_kept() -> Result<()> {
        let root = Root::new();
        let db = seeded(&root.0)?;
        db.put(
            "presentation",
            RELAY,
            &json!({"connections":[],"messages":[{"from":"old","to":"live"}]}),
        )?;
        assert!(remove_archived(&db, &root.0, "r", &["old".into()]).is_err());
        assert!(db.get("sessions", "old")?.is_some());
        Ok(())
    }

    #[test]
    fn compaction_frees_journal_admission_but_keeps_outputs_and_uncertain_records() -> Result<()> {
        let root = Root::new();
        let db = seeded(&root.0)?;
        for index in 0..db::JOURNAL_LIMIT {
            db.put("commands", &format!("f{index}"), &json!({"id":format!("f{index}"),"operation":"turn","params":{},"sessionId":"live","status":"applied","createdAtMillis":1}))?;
        }
        assert!(
            db.journal_admits()
                .unwrap_err()
                .to_string()
                .contains("Data & backups")
        );
        let receipt = compact(&db, &root.0, "k1")?;
        assert_eq!(receipt["compacted"], db::JOURNAL_LIMIT + 2);
        db.journal_admits()?;
        assert_eq!(db.get("commands", "c-run")?.unwrap()["output"], "tests ok");
        assert_eq!(
            db.get("commands", "c-unknown")?.unwrap()["status"],
            "outcomeUnknown"
        );
        assert!(
            db.get("commands", "c-unknown")?
                .unwrap()
                .get("compacted")
                .is_none()
        );
        assert_eq!(compact(&db, &root.0, "k1")?, receipt);
        // Recent records stay complete.
        db.put("commands", "recent", &json!({"id":"recent","operation":"turn","params":{"a":1},"sessionId":"live","status":"applied","createdAtMillis":now_ms() as u64}))?;
        compact(&db, &root.0, "k2")?;
        assert_eq!(db.get("commands", "recent")?.unwrap()["params"]["a"], 1);
        let summary = summary(&db, &root.0)?;
        assert_eq!(summary["journalEntries"], 3);
        assert_eq!(
            summary["archived"][0]["retainedWorktree"],
            "/tmp/worktree-old"
        );
        Ok(())
    }
}
