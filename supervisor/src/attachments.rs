//! Session-owned attachment staging for the composer (R14): images, MP4/QuickTime videos and
//! UTF-8 text files. Bytes arrive in bounded chunks over the normal 64 KiB control channel,
//! are written only inside Lascoria's private state, and are validated by content (signature
//! or encoding, size, header dimensions, SHA-256) before they can be sent. The command journal
//! records attachment IDs only; the session worker reads the verified file on explicit send.
//! Nothing here contacts Muse or a model.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

/// One image may be at most this large; a task may carry `MAX_PER_TURN` of them.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_TURN_BYTES: u64 = 6 * 1024 * 1024;
pub const MAX_PER_TURN: usize = 4;
/// Muse keeps an uploaded video in the session's own store for the life of the session, so
/// the cap also bounds the copy it retains.
pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_VIDEOS_PER_TURN: usize = 1;
/// Bytes per `media/upload` call, well inside the SDK's 10 MiB frame once base64-encoded.
pub const VIDEO_CHUNK_BYTES: u64 = 4 * 1024 * 1024;
/// Text files travel as part of the task text, so they are bounded like prompt text.
pub const MAX_TEXT_BYTES: u64 = 256 * 1024;
pub const MAX_TEXT_TURN_BYTES: u64 = 512 * 1024;
pub const MAX_TEXTS_PER_TURN: usize = 4;
/// Staged items, finished or not, per session and across all sessions.
pub const MAX_PER_SESSION: usize = 8;
pub const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Largest side and pixel count accepted from image headers.
pub const MAX_SIDE: u32 = 8192;
pub const MAX_PIXELS: u64 = 40_000_000;
/// Base64 text per append request, well under the 64 KiB control frame.
pub const MAX_CHUNK_BASE64: usize = 44 * 1024;
const MAX_NAME: usize = 200;
/// Unfinished uploads older than this are removed when another upload begins.
const PARTIAL_TTL_MS: u128 = 10 * 60 * 1000;

const MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const VIDEO_TYPES: [&str; 2] = ["video/mp4", "video/quicktime"];

/// What an attachment is, declared at begin (so the right size limit applies before any byte
/// arrives) and confirmed by content at finish.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Image,
    Video,
    Text,
}
impl Kind {
    fn parse(value: &Value) -> Result<Self> {
        Ok(match value.as_str().unwrap_or("image") {
            "image" => Self::Image,
            "video" => Self::Video,
            "text" => Self::Text,
            _ => bail!("Only images, MP4 or QuickTime videos and text files can be attached"),
        })
    }
    fn of(manifest: &Value) -> Self {
        Self::parse(&manifest["kind"]).unwrap_or(Self::Image)
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
            Self::Text => "text",
        }
    }
    fn limit(self) -> (u64, &'static str) {
        match self {
            Self::Image => (MAX_IMAGE_BYTES, "Images can be at most 5 MB"),
            Self::Video => (MAX_VIDEO_BYTES, "Videos can be at most 100 MB"),
            Self::Text => (MAX_TEXT_BYTES, "Text files can be at most 256 KB"),
        }
    }
}

fn uuid(value: &Value, what: &str) -> Result<String> {
    let id = value.as_str().with_context(|| format!("{what} required"))?;
    ensure!(
        uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id),
        "Invalid {what}"
    );
    Ok(id.to_owned())
}

fn session_dir(root: &Path, session: &str) -> Result<PathBuf> {
    let base = root.join("attachments");
    lascoria_runtime::platform::private_dir(&base)?;
    let dir = base.join(session);
    lascoria_runtime::platform::private_dir(&dir)?;
    Ok(dir)
}

fn manifest_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}
pub fn bytes_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.bin"))
}

fn read_manifest(dir: &Path, id: &str) -> Result<Option<Value>> {
    match fs::read_to_string(manifest_path(dir, id)) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_manifest(dir: &Path, id: &str, manifest: &Value) -> Result<()> {
    let path = manifest_path(dir, id);
    let temporary = path.with_extension(format!("partial-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut file = lascoria_runtime::platform::private_file(&temporary, true)?;
        file.write_all(manifest.to_string().as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn manifests(dir: &Path) -> Result<Vec<Value>> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(found);
    };
    for entry in entries.take(4 * MAX_PER_SESSION + 16) {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "json")
            && let Ok(text) = fs::read_to_string(&path)
            && let Ok(manifest) = serde_json::from_str::<Value>(&text)
        {
            found.push(manifest);
        }
    }
    found.sort_by_key(|m| m["createdAtMillis"].as_u64().unwrap_or(0));
    Ok(found)
}

/// Serialises admission so two concurrent begins cannot both fit under the global cap.
static ADMISSION: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Bytes reserved across every session: the announced size of each staged image, finished
/// or still arriving, so a begin is counted before its chunks are written. Unfinished uploads
/// past their expiry are removed here, in any session, so abandoned reservations are freed.
/// Byte files without a manifest are counted by their length. Survives restart because it is
/// derived from the manifests on disk.
fn reserved_bytes(root: &Path, now: u128) -> u64 {
    let Ok(sessions) = fs::read_dir(root.join("attachments")) else {
        return 0;
    };
    let mut total = 0;
    for session in sessions.flatten().take(256) {
        let dir = session.path();
        let mut declared = std::collections::HashSet::new();
        for manifest in manifests(&dir).unwrap_or_default() {
            let id = manifest["id"].as_str().unwrap_or_default().to_owned();
            if manifest["status"] == "uploading"
                && now.saturating_sub(manifest["createdAtMillis"].as_u64().unwrap_or(0) as u128)
                    > PARTIAL_TTL_MS
            {
                remove(&dir, &id);
                continue;
            }
            let length = fs::metadata(bytes_path(&dir, &id)).map_or(0, |m| m.len());
            total += manifest["bytes"].as_u64().unwrap_or(0).max(length);
            declared.insert(format!("{id}.bin"));
        }
        let Ok(files) = fs::read_dir(&dir) else {
            continue;
        };
        for file in files.flatten().take(4 * MAX_PER_SESSION + 16) {
            let name = file.file_name().to_string_lossy().into_owned();
            if name.ends_with(".bin") && !declared.contains(&name) {
                total += file.metadata().map_or(0, |m| m.len());
            }
        }
    }
    total
}

fn remove(dir: &Path, id: &str) {
    let _ = fs::remove_file(bytes_path(dir, id));
    let _ = fs::remove_file(manifest_path(dir, id));
}

/// Strict standard base64, as browsers produce it.
fn decode_base64(text: &str) -> Result<Vec<u8>> {
    let bytes = text.as_bytes();
    ensure!(
        bytes.len().is_multiple_of(4),
        "Attachment chunk is not valid base64"
    );
    let value = |c: u8| -> Result<u32> {
        Ok(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => bail!("Attachment chunk is not valid base64"),
        } as u32)
    };
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for (index, quad) in bytes.chunks(4).enumerate() {
        let last = index + 1 == bytes.len() / 4;
        let pad = quad.iter().rev().take_while(|&&c| c == b'=').count();
        ensure!(
            pad <= 2 && (pad == 0 || last),
            "Attachment chunk is not valid base64"
        );
        let mut n = 0u32;
        for &c in &quad[..4 - pad] {
            n = (n << 6) | value(c)?;
        }
        n <<= 6 * pad as u32;
        let decoded = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&decoded[..3 - pad]);
    }
    Ok(out)
}

/// Media type and pixel size from the file header. Content decides the type, never the name or
/// the declared MIME type; anything else is refused.
pub fn sniff(head: &[u8]) -> Result<(&'static str, u32, u32)> {
    let be16 = |b: &[u8]| u16::from_be_bytes([b[0], b[1]]) as u32;
    let be32 = |b: &[u8]| u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
    let le16 = |b: &[u8]| u16::from_le_bytes([b[0], b[1]]) as u32;
    let unsupported = "Images must be PNG, JPEG, GIF or WebP";
    let (media, width, height) =
        if head.len() >= 24 && head.starts_with(b"\x89PNG\r\n\x1a\n") && &head[12..16] == b"IHDR" {
            ("image/png", be32(&head[16..]), be32(&head[20..]))
        } else if head.len() >= 10 && (head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a")) {
            ("image/gif", le16(&head[6..]), le16(&head[8..]))
        } else if head.len() >= 30 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
            let le24 = |b: &[u8]| u32::from_le_bytes([b[0], b[1], b[2], 0]);
            match &head[12..16] {
                b"VP8X" => ("image/webp", le24(&head[24..]) + 1, le24(&head[27..]) + 1),
                b"VP8L" if head[20] == 0x2f => {
                    let bits = u32::from_le_bytes([head[21], head[22], head[23], head[24]]);
                    (
                        "image/webp",
                        (bits & 0x3fff) + 1,
                        ((bits >> 14) & 0x3fff) + 1,
                    )
                }
                b"VP8 " if head[23..26] == [0x9d, 0x01, 0x2a] => (
                    "image/webp",
                    le16(&head[26..]) & 0x3fff,
                    le16(&head[28..]) & 0x3fff,
                ),
                _ => bail!(unsupported),
            }
        } else if head.len() >= 4 && head.starts_with(&[0xff, 0xd8, 0xff]) {
            // Walk JPEG segments to the first start-of-frame marker.
            let mut at = 2;
            loop {
                ensure!(at + 9 <= head.len(), "JPEG header is incomplete");
                ensure!(head[at] == 0xff, "JPEG header is malformed");
                let marker = head[at + 1];
                if marker == 0xff {
                    at += 1;
                    continue;
                }
                let length = be16(&head[at + 2..]) as usize;
                ensure!(length >= 2, "JPEG header is malformed");
                if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf) {
                    break ("image/jpeg", be16(&head[at + 7..]), be16(&head[at + 5..]));
                }
                ensure!(
                    !matches!(marker, 0xd9 | 0xda),
                    "JPEG has no image dimensions"
                );
                at += 2 + length;
            }
        } else {
            bail!(unsupported)
        };
    ensure!(width > 0 && height > 0, "Image dimensions are missing");
    ensure!(
        width <= MAX_SIDE && height <= MAX_SIDE && (width as u64) * (height as u64) <= MAX_PIXELS,
        "Images can be at most {MAX_SIDE} pixels on each side"
    );
    Ok((media, width, height))
}

fn public(manifest: &Value) -> Value {
    json!({
        "id": manifest["id"], "kind": Kind::of(manifest).name(), "name": manifest["name"], "mediaType": manifest["mediaType"],
        "bytes": manifest["bytes"], "width": manifest["width"], "height": manifest["height"],
        "status": manifest["status"], "received": manifest["received"],
    })
}

pub fn begin(root: &Path, params: &Value) -> Result<Value> {
    let session = uuid(&params["sessionId"], "session")?;
    let id = uuid(&params["attachmentId"], "attachment ID")?;
    let kind = Kind::parse(&params["kind"])?;
    let size = params["bytes"]
        .as_u64()
        .context("Attachment size required")?;
    ensure!(size > 0, "The file is empty");
    let (limit, message) = kind.limit();
    ensure!(size <= limit, "{message}");
    let name = params["name"].as_str().unwrap_or("Attachment").trim();
    let name: String = name
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME)
        .collect();
    let dir = session_dir(root, &session)?;
    let _admission = ADMISSION
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(existing) = read_manifest(&dir, &id)? {
        // A retried begin with the same identity is the same upload; resume from `received`.
        ensure!(
            existing["bytes"] == size
                && existing["sessionId"] == session
                && Kind::of(&existing) == kind,
            "Attachment ID reused for a different file"
        );
        return Ok(public(&existing));
    }
    let now = crate::db::now_ms();
    // Also removes expired unfinished uploads in every session, this one included.
    let reserved = reserved_bytes(root, now);
    let staged = manifests(&dir)?;
    ensure!(
        staged.len() < MAX_PER_SESSION,
        "A session can hold {MAX_PER_SESSION} attachments waiting to be sent; remove one first"
    );
    ensure!(
        reserved + size <= MAX_TOTAL_BYTES,
        "Waiting attachments use the {} MB storage limit; send or remove some first",
        MAX_TOTAL_BYTES / 1024 / 1024
    );
    drop(lascoria_runtime::platform::private_file(
        &bytes_path(&dir, &id),
        true,
    )?);
    let mut manifest = json!({"id":id,"sessionId":session,"kind":kind.name(),"name":if name.is_empty() {"Attachment".into()} else {name},"bytes":size,"received":0,"status":"uploading","createdAtMillis":now as u64});
    if kind == Kind::Video {
        // Muse's receipt for the upload: minted once, so a resent task finds the same upload.
        manifest["uploadId"] = json!(uuid::Uuid::now_v7().to_string());
    }
    write_manifest(&dir, &id, &manifest)?;
    Ok(public(&manifest))
}

pub fn append(root: &Path, params: &Value) -> Result<Value> {
    let session = uuid(&params["sessionId"], "session")?;
    let id = uuid(&params["attachmentId"], "attachment ID")?;
    let offset = params["offset"].as_u64().context("Chunk offset required")?;
    let data = params["data"].as_str().context("Chunk data required")?;
    ensure!(
        !data.is_empty() && data.len() <= MAX_CHUNK_BASE64,
        "Attachment chunk is too large"
    );
    let chunk = decode_base64(data)?;
    let dir = session_dir(root, &session)?;
    let mut manifest = read_manifest(&dir, &id)?.context("Unknown attachment")?;
    ensure!(manifest["sessionId"] == session, "Unknown attachment");
    ensure!(
        manifest["status"] == "uploading",
        "This file has already been checked"
    );
    let received = manifest["received"].as_u64().unwrap_or(0);
    let size = manifest["bytes"].as_u64().unwrap_or(0);
    let end = offset
        .checked_add(chunk.len() as u64)
        .context("Chunk offset overflow")?;
    ensure!(end <= size, "The file is larger than announced");
    let mut file = lascoria_runtime::platform::private_file(&bytes_path(&dir, &id), false)?;
    if end <= received {
        // A retried chunk must match what was already written.
        let mut existing = vec![0; chunk.len()];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut existing)?;
        ensure!(existing == chunk, "Retried chunk differs from the original");
        return Ok(public(&manifest));
    }
    ensure!(offset == received, "Chunks must arrive in order");
    file.seek(SeekFrom::Start(offset))?;
    file.write_all(&chunk)?;
    file.sync_data()?;
    manifest["received"] = json!(end);
    write_manifest(&dir, &id, &manifest)?;
    Ok(public(&manifest))
}

/// A video's container type from its first box. Muse accepts any bytes labelled as video, so
/// Lascoria checks the ISO base media `ftyp` box itself.
pub fn sniff_video(head: &[u8]) -> Result<&'static str> {
    ensure!(
        head.len() >= 16
            && &head[4..8] == b"ftyp"
            && u32::from_be_bytes([head[0], head[1], head[2], head[3]]) >= 16
            && head[8..12]
                .iter()
                .all(|b| b.is_ascii_graphic() || *b == b' '),
        "Videos must be MP4 or QuickTime (.mp4, .m4v or .mov)"
    );
    Ok(if &head[8..12] == b"qt  " {
        "video/quicktime"
    } else {
        "video/mp4"
    })
}

/// Text files must be UTF-8 without NUL bytes; anything else is treated as binary and refused.
pub fn check_text(bytes: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| {
        anyhow::anyhow!("Only UTF-8 text files can be attached; this file looks binary")
    })?;
    ensure!(
        !text.contains('\0'),
        "Only UTF-8 text files can be attached; this file looks binary"
    );
    Ok(())
}

pub fn finish(root: &Path, params: &Value) -> Result<Value> {
    let session = uuid(&params["sessionId"], "session")?;
    let id = uuid(&params["attachmentId"], "attachment ID")?;
    let expected = params["sha256"]
        .as_str()
        .context("Attachment checksum required")?;
    let dir = session_dir(root, &session)?;
    let mut manifest = read_manifest(&dir, &id)?.context("Unknown attachment")?;
    ensure!(manifest["sessionId"] == session, "Unknown attachment");
    if manifest["status"] == "ready" {
        ensure!(
            manifest["sha256"] == expected,
            "Attachment checksum changed"
        );
        return Ok(public(&manifest));
    }
    let kind = Kind::of(&manifest);
    let checked = (|| {
        let path = bytes_path(&dir, &id);
        let mut file = fs::File::open(&path)?;
        let length = file.metadata()?.len();
        ensure!(
            length == manifest["bytes"].as_u64().unwrap_or(0)
                && manifest["received"] == manifest["bytes"],
            "The file did not arrive completely; add it again"
        );
        // Stream the checksum: a video is never held in memory whole.
        let mut hasher = Sha256::new();
        let mut head = Vec::new();
        let mut text = Vec::new();
        let mut buffer = vec![0; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            if head.len() < 64 * 1024 {
                let take = read.min(64 * 1024 - head.len());
                head.extend_from_slice(&buffer[..take]);
            }
            if kind == Kind::Text {
                text.extend_from_slice(&buffer[..read]);
            }
        }
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        ensure!(
            digest == expected,
            "The file changed while it was being added; add it again"
        );
        let found = match kind {
            Kind::Image => {
                let (media, width, height) = sniff(&head)?;
                json!({"mediaType":media,"width":width,"height":height})
            }
            Kind::Video => json!({"mediaType":sniff_video(&head)?}),
            Kind::Text => {
                check_text(&text)?;
                json!({"mediaType":"text/plain"})
            }
        };
        Ok::<_, anyhow::Error>((digest, found))
    })();
    match checked {
        Ok((digest, found)) => {
            manifest["status"] = json!("ready");
            manifest["sha256"] = json!(digest);
            for (key, value) in found.as_object().unwrap() {
                manifest[key] = value.clone();
            }
            write_manifest(&dir, &id, &manifest)?;
            Ok(public(&manifest))
        }
        Err(error) => {
            remove(&dir, &id);
            Err(error)
        }
    }
}

pub fn discard(root: &Path, params: &Value) -> Result<Value> {
    let session = uuid(&params["sessionId"], "session")?;
    let id = uuid(&params["attachmentId"], "attachment ID")?;
    remove(&session_dir(root, &session)?, &id);
    Ok(json!({"removed":id}))
}

pub fn list(root: &Path, params: &Value) -> Result<Value> {
    let session = uuid(&params["sessionId"], "session")?;
    let dir = session_dir(root, &session)?;
    Ok(
        json!({"attachments": manifests(&dir)?.iter().filter(|m| m["status"] == "ready").map(public).collect::<Vec<_>>(),"limits":{"imageBytes":MAX_IMAGE_BYTES,"turnBytes":MAX_TURN_BYTES,"perTurn":MAX_PER_TURN,"videoBytes":MAX_VIDEO_BYTES,"videosPerTurn":MAX_VIDEOS_PER_TURN,"textBytes":MAX_TEXT_BYTES,"textsPerTurn":MAX_TEXTS_PER_TURN,"perSession":MAX_PER_SESSION,"chunkBase64":MAX_CHUNK_BASE64,"mediaTypes":MEDIA_TYPES,"videoTypes":VIDEO_TYPES}}),
    )
}

/// Resolve a turn's attachment IDs to verified files for the worker, in the user's order.
pub fn for_turn(root: &Path, session: &str, ids: &Value) -> Result<Vec<Value>> {
    let ids = ids.as_array().context("Attachments must be a list")?;
    let most = MAX_PER_TURN + MAX_VIDEOS_PER_TURN + MAX_TEXTS_PER_TURN;
    ensure!(
        !ids.is_empty() && ids.len() <= most,
        "A task can include 1 to {most} attachments"
    );
    let dir = session_dir(root, session)?;
    let mut seen = std::collections::HashSet::new();
    let mut counts = std::collections::HashMap::<&str, (usize, u64)>::new();
    let mut items = Vec::new();
    for id in ids {
        let id = uuid(id, "attachment ID")?;
        ensure!(seen.insert(id.clone()), "The same file is attached twice");
        let manifest = read_manifest(&dir, &id)?
            .filter(|m| m["status"] == "ready" && m["sessionId"] == session)
            .context("An attachment is no longer available; remove it and add it again")?;
        let kind = Kind::of(&manifest);
        let entry = counts.entry(kind.name()).or_default();
        entry.0 += 1;
        entry.1 += manifest["bytes"].as_u64().unwrap_or(0);
        items.push(json!({"kind":kind.name(),"path":bytes_path(&dir, &id),"sha256":manifest["sha256"],"mediaType":manifest["mediaType"],"width":manifest["width"],"height":manifest["height"],"bytes":manifest["bytes"],"name":manifest["name"],"uploadId":manifest["uploadId"]}));
    }
    let (images, image_bytes) = counts.get("image").copied().unwrap_or_default();
    let (videos, _) = counts.get("video").copied().unwrap_or_default();
    let (texts, text_bytes) = counts.get("text").copied().unwrap_or_default();
    ensure!(
        images <= MAX_PER_TURN,
        "A task can include {MAX_PER_TURN} images"
    );
    ensure!(
        image_bytes <= MAX_TURN_BYTES,
        "Images in one task can total at most {} MB",
        MAX_TURN_BYTES / 1024 / 1024
    );
    ensure!(
        videos <= MAX_VIDEOS_PER_TURN,
        "A task can include one video"
    );
    ensure!(
        texts <= MAX_TEXTS_PER_TURN && text_bytes <= MAX_TEXT_TURN_BYTES,
        "A task can include {MAX_TEXTS_PER_TURN} text files, 512 KB in total"
    );
    Ok(items)
}

/// After Muse has the bytes (its own durable log keeps them), the staged copies go.
pub fn sent(root: &Path, session: &str, ids: &Value) {
    if let (Ok(dir), Some(ids)) = (session_dir(root, session), ids.as_array()) {
        for id in ids.iter().filter_map(Value::as_str) {
            if uuid::Uuid::parse_str(id).is_ok() {
                remove(&dir, id);
            }
        }
    }
}

/// Remove every staged attachment of a session, for archived-session cleanup.
pub fn remove_session(root: &Path, session: &str) {
    if uuid::Uuid::parse_str(session).is_ok() {
        let _ = fs::remove_dir_all(root.join("attachments").join(session));
    }
}

pub fn handle(root: &Path, operation: &str, params: &Value) -> Result<Value> {
    ensure!(params.is_object(), "Params must be an object");
    match operation {
        "attachment/begin" => begin(root, params),
        "attachment/append" => append(root, params),
        "attachment/finish" => finish(root, params),
        "attachment/discard" => discard(root, params),
        "attachment/list" => list(root, params),
        _ => bail!("Unsupported attachment operation"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn root() -> Root {
        let path = std::env::temp_dir().join(format!("lascoria-att-{}", uuid::Uuid::new_v4()));
        lascoria_runtime::platform::private_dir(&path).unwrap();
        Root(path)
    }
    fn encode(bytes: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk.iter().fold(0u32, |n, &b| (n << 8) | b as u32) << (8 * (3 - chunk.len()));
            for i in 0..4 {
                out.push(if i <= chunk.len() {
                    T[(n >> (18 - 6 * i)) as usize & 63] as char
                } else {
                    '='
                });
            }
        }
        out
    }
    fn png(width: u32, height: u32, padding: usize) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend(std::iter::repeat_n(7u8, padding));
        bytes
    }
    fn sha(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    #[test]
    fn base64_and_headers_are_checked_by_content() {
        for sample in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\xff\x00\x10"] {
            assert_eq!(decode_base64(&encode(sample)).unwrap(), sample);
        }
        assert!(decode_base64("abc").is_err());
        assert!(decode_base64("ab=c").is_err());
        assert!(decode_base64("a*bc").is_err());
        assert_eq!(sniff(&png(640, 480, 8)).unwrap(), ("image/png", 640, 480));
        assert_eq!(
            sniff(b"GIF89a\x20\x00\x10\x00rest").unwrap(),
            ("image/gif", 32, 16)
        );
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0];
        jpeg.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 3]);
        assert_eq!(sniff(&jpeg).unwrap(), ("image/jpeg", 640, 480));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend_from_slice(&[0x7f, 0x02, 0x00, 0xdf, 0x01, 0x00]);
        assert_eq!(sniff(&webp).unwrap(), ("image/webp", 640, 480));
        assert!(sniff(b"%PDF-1.7 not an image").is_err());
        assert!(sniff(&png(9000, 10, 0)).is_err(), "side limit");
        assert!(sniff(&png(0, 10, 0)).is_err());
        assert!(sniff(&jpeg[..6]).is_err(), "truncated JPEG");
    }

    #[test]
    fn staging_is_session_owned_ordered_retry_safe_and_bounded() -> Result<()> {
        let root = root();
        let session = uuid::Uuid::new_v4().to_string();
        let other = uuid::Uuid::new_v4().to_string();
        let image = png(64, 32, 70_000);
        let id = uuid::Uuid::new_v4().to_string();
        let begin_params = json!({"sessionId":session,"attachmentId":id,"name":"shot\u{7}.png","bytes":image.len()});
        let started = begin(&root.0, &begin_params)?;
        assert_eq!(started["name"], "shot.png");
        assert_eq!(
            begin(&root.0, &begin_params)?["status"],
            "uploading",
            "retry"
        );
        let half = 30_000;
        let first =
            json!({"sessionId":session,"attachmentId":id,"offset":0,"data":encode(&image[..half])});
        append(&root.0, &first)?;
        append(&root.0, &first)?; // retried chunk
        assert!(
            append(&root.0, &json!({"sessionId":session,"attachmentId":id,"offset":half + 3,"data":encode(&image[half + 3..half + 6])})).is_err(),
            "gap"
        );
        assert!(
            append(&root.0, &json!({"sessionId":other,"attachmentId":id,"offset":half,"data":encode(&image[half..half + 3])})).is_err(),
            "another session cannot write"
        );
        let mut at = half;
        while at < image.len() {
            let end = (at + 30_000).min(image.len());
            append(
                &root.0,
                &json!({"sessionId":session,"attachmentId":id,"offset":at,"data":encode(&image[at..end])}),
            )?;
            at = end;
        }
        assert!(
            finish(
                &root.0,
                &json!({"sessionId":session,"attachmentId":id,"sha256":"0".repeat(64)})
            )
            .is_err()
        );
        // A checksum mismatch discards the upload.
        assert!(
            list(&root.0, &json!({"sessionId":session}))?["attachments"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let id = uuid::Uuid::new_v4().to_string();
        begin(
            &root.0,
            &json!({"sessionId":session,"attachmentId":id,"bytes":image.len()}),
        )?;
        let mut at = 0;
        while at < image.len() {
            let end = (at + 30_000).min(image.len());
            append(
                &root.0,
                &json!({"sessionId":session,"attachmentId":id,"offset":at,"data":encode(&image[at..end])}),
            )?;
            at = end;
        }
        let ready = finish(
            &root.0,
            &json!({"sessionId":session,"attachmentId":id,"sha256":sha(&image)}),
        )?;
        assert_eq!(
            (ready["mediaType"].as_str(), ready["width"].as_u64()),
            (Some("image/png"), Some(64))
        );
        assert_eq!(
            finish(
                &root.0,
                &json!({"sessionId":session,"attachmentId":id,"sha256":sha(&image)})
            )?,
            ready
        );
        let listed = list(&root.0, &json!({"sessionId":session}))?;
        assert_eq!(listed["attachments"][0]["id"], id);
        assert!(
            list(&root.0, &json!({"sessionId":other}))?["attachments"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let files = for_turn(&root.0, &session, &json!([id]))?;
        assert_eq!(fs::read(files[0]["path"].as_str().unwrap())?, image);
        assert!(
            for_turn(&root.0, &other, &json!([id])).is_err(),
            "cross-session"
        );
        assert!(
            for_turn(&root.0, &session, &json!([id, id])).is_err(),
            "duplicate"
        );
        assert!(for_turn(&root.0, &session, &json!([])).is_err());

        // A PDF renamed .png is refused by content.
        let pdf = b"%PDF-1.7 pretending".to_vec();
        let fake = uuid::Uuid::new_v4().to_string();
        begin(
            &root.0,
            &json!({"sessionId":session,"attachmentId":fake,"name":"x.png","bytes":pdf.len()}),
        )?;
        append(
            &root.0,
            &json!({"sessionId":session,"attachmentId":fake,"offset":0,"data":encode(&pdf)}),
        )?;
        assert!(
            finish(
                &root.0,
                &json!({"sessionId":session,"attachmentId":fake,"sha256":sha(&pdf)})
            )
            .is_err()
        );

        // Size and count bounds.
        assert!(begin(&root.0, &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"bytes":MAX_IMAGE_BYTES + 1})).is_err());
        for _ in 1..MAX_PER_SESSION {
            begin(
                &root.0,
                &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"bytes":10}),
            )?;
        }
        assert!(begin(&root.0, &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"bytes":10})).is_err());

        sent(&root.0, &session, &json!([id]));
        assert!(
            for_turn(&root.0, &session, &json!([id])).is_err(),
            "sent images are gone"
        );
        remove_session(&root.0, &session);
        assert!(!root.0.join("attachments").join(&session).exists());
        Ok(())
    }

    #[test]
    fn announced_bytes_are_reserved_across_sessions_before_any_chunk_arrives() -> Result<()> {
        let root = root();
        let sessions = [
            uuid::Uuid::new_v4().to_string(),
            uuid::Uuid::new_v4().to_string(),
        ];
        let begin_one = |session: &str| {
            begin(
                &root.0,
                &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"kind":"video","bytes":MAX_VIDEO_BYTES}),
            )
        };
        // Interleave begins across two sessions without sending a single chunk.
        let mut admitted = Vec::new();
        let mut refused = 0;
        for n in 0..16 {
            match begin_one(&sessions[n % 2]) {
                Ok(manifest) => admitted.push((n % 2, manifest["id"].as_str().unwrap().to_owned())),
                Err(error) => {
                    assert!(error.to_string().contains("storage limit"), "{error}");
                    refused += 1;
                }
            }
        }
        let fit = (MAX_TOTAL_BYTES / MAX_VIDEO_BYTES) as usize;
        assert_eq!(
            admitted.len(),
            fit,
            "two announced 100 MiB videos fit in 256 MiB"
        );
        assert_eq!(refused, 16 - fit);
        assert!(reserved_bytes(&root.0, crate::db::now_ms()) <= MAX_TOTAL_BYTES);

        // Discarding frees its reservation; the next begin fits again.
        let (owner, id) = admitted.remove(0);
        discard(
            &root.0,
            &json!({"sessionId":sessions[owner],"attachmentId":id}),
        )?;
        begin_one(&sessions[0])?;
        assert!(begin_one(&sessions[1]).is_err());

        // Abandoned unfinished uploads in another session expire and free their bytes.
        let dir = session_dir(&root.0, &sessions[1])?;
        for mut manifest in manifests(&dir)? {
            manifest["createdAtMillis"] = json!(0);
            write_manifest(&dir, manifest["id"].as_str().unwrap(), &manifest)?;
        }
        begin_one(&sessions[0])?;
        Ok(())
    }

    #[test]
    fn concurrent_begins_cannot_overcommit_the_global_cap() -> Result<()> {
        let root = std::sync::Arc::new(root());
        let threads: Vec<_> = (0..16)
            .map(|n| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let session = if n % 2 == 0 { "00000000-0000-4000-8000-000000000001" } else { "00000000-0000-4000-8000-000000000002" };
                    begin(
                        &root.0,
                        &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"kind":"video","bytes":MAX_VIDEO_BYTES}),
                    )
                    .is_ok()
                })
            })
            .collect();
        let admitted = threads
            .into_iter()
            .filter(|_| true)
            .map(|t| t.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(admitted, (MAX_TOTAL_BYTES / MAX_VIDEO_BYTES) as usize);
        assert!(reserved_bytes(&root.0, crate::db::now_ms()) <= MAX_TOTAL_BYTES);
        Ok(())
    }

    fn stage(root: &Path, session: &str, kind: &str, name: &str, bytes: &[u8]) -> Result<Value> {
        let id = uuid::Uuid::new_v4().to_string();
        begin(
            root,
            &json!({"sessionId":session,"attachmentId":id,"kind":kind,"name":name,"bytes":bytes.len()}),
        )?;
        for (n, chunk) in bytes.chunks(30_000).enumerate() {
            append(
                root,
                &json!({"sessionId":session,"attachmentId":id,"offset":n * 30_000,"data":encode(chunk)}),
            )?;
        }
        finish(
            root,
            &json!({"sessionId":session,"attachmentId":id,"sha256":sha(bytes)}),
        )
    }

    #[test]
    fn videos_and_text_files_are_checked_by_content_and_bounded_per_task() -> Result<()> {
        let root = root();
        let session = uuid::Uuid::new_v4().to_string();
        let mut mp4 = vec![0, 0, 0, 24];
        mp4.extend_from_slice(b"ftypisom\0\0\x02\0isommp41");
        mp4.extend(std::iter::repeat_n(1u8, 100_000));
        let video = stage(&root.0, &session, "video", "clip.mp4", &mp4)?;
        assert_eq!(
            (video["kind"].as_str(), video["mediaType"].as_str()),
            (Some("video"), Some("video/mp4"))
        );
        let mut mov = vec![0, 0, 0, 20];
        mov.extend_from_slice(b"ftypqt  \0\0\x02\0qt  ");
        let quicktime = stage(&root.0, &session, "video", "clip.mov", &mov)?;
        assert_eq!(quicktime["mediaType"], "video/quicktime");
        // Muse would accept any bytes labelled as video; Lascoria checks the container itself.
        let refused = stage(
            &root.0,
            &session,
            "video",
            "fake.mp4",
            b"not a video at all",
        )
        .unwrap_err();
        assert!(refused.to_string().contains("MP4 or QuickTime"));
        assert!(
            begin(&root.0, &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"kind":"video","bytes":MAX_VIDEO_BYTES + 1}))
                .unwrap_err()
                .to_string()
                .contains("100 MB")
        );

        let text = stage(
            &root.0,
            &session,
            "text",
            "notes.md",
            "# Notes\n\u{e9}t\u{e9}\n".as_bytes(),
        )?;
        assert_eq!(
            (text["kind"].as_str(), text["mediaType"].as_str()),
            (Some("text"), Some("text/plain"))
        );
        for binary in [&b"%PDF-1.7\0\x01"[..], &[0xff, 0xfe, 0x00, 0x41][..]] {
            assert!(
                stage(&root.0, &session, "text", "x.txt", binary)
                    .unwrap_err()
                    .to_string()
                    .contains("looks binary")
            );
        }
        assert!(begin(&root.0, &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"kind":"text","bytes":MAX_TEXT_BYTES + 1})).is_err());
        assert!(begin(&root.0, &json!({"sessionId":session,"attachmentId":uuid::Uuid::new_v4().to_string(),"kind":"pdf","bytes":10})).is_err());
        // A retried begin cannot change what the upload is.
        let id = uuid::Uuid::new_v4().to_string();
        begin(
            &root.0,
            &json!({"sessionId":session,"attachmentId":id,"kind":"text","bytes":10}),
        )?;
        assert!(
            begin(
                &root.0,
                &json!({"sessionId":session,"attachmentId":id,"kind":"video","bytes":10})
            )
            .is_err()
        );
        discard(&root.0, &json!({"sessionId":session,"attachmentId":id}))?;

        let items = for_turn(&root.0, &session, &json!([text["id"], video["id"]]))?;
        assert_eq!(items[0]["kind"], "text");
        assert_eq!(items[0]["name"], "notes.md");
        assert_eq!(items[1]["kind"], "video");
        assert!(uuid::Uuid::parse_str(items[1]["uploadId"].as_str().unwrap()).is_ok());
        assert_eq!(
            for_turn(&root.0, &session, &json!([video["id"]]))?[0]["uploadId"],
            items[1]["uploadId"],
            "the upload receipt is stable across retries"
        );
        assert!(
            for_turn(&root.0, &session, &json!([video["id"], quicktime["id"]]))
                .unwrap_err()
                .to_string()
                .contains("one video")
        );
        Ok(())
    }
}
