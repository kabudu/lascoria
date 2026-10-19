//! Native drag and drop (R14/R15). The window takes file and folder drops itself so the
//! WebView learns real folder paths, which HTML drops never carry. Only the most recent drop
//! is remembered; the page can read the bytes of a file from that drop, by position, and
//! nothing else, so this is not a general file-reading command.
use serde_json::json;
use std::{
    io::Read,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
};
use tauri::{DragDropEvent, Emitter, WebviewWindow, Window};

/// Matches the largest attachment the supervisor accepts (a video).
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// Entries reported per drop; more are counted but not offered.
const MAX_ENTRIES: usize = 16;

#[derive(Default)]
pub struct Drops {
    next: AtomicU64,
    last: Mutex<Option<(u64, Vec<PathBuf>)>>,
}

/// Whether this platform's drop positions are device pixels. Tauri labels every drop
/// position physical, but wry passes on what the system gives it: client pixels from
/// WebView2 on Windows, and view points (already CSS pixels) from WKWebView and WebKitGTK.
/// Dividing points by the scale factor put every Retina drop at half its real position.
const POSITIONS_ARE_PIXELS: bool = cfg!(windows);

fn to_css(position: (f64, f64), scale: f64, pixels: bool) -> (f64, f64) {
    let scale = if pixels && scale > 0.0 { scale } else { 1.0 };
    (position.0 / scale, position.1 / scale)
}

fn logical(window: &Window, position: tauri::PhysicalPosition<f64>) -> (f64, f64) {
    to_css(
        (position.x, position.y),
        window.scale_factor().unwrap_or(1.0),
        POSITIONS_ARE_PIXELS,
    )
}

/// Called for every window drag-and-drop event.
pub fn on_event(window: &Window, drops: &Drops, event: &DragDropEvent) {
    match event {
        DragDropEvent::Enter { position, .. } | DragDropEvent::Over { position } => {
            let (x, y) = logical(window, *position);
            let _ = window.emit("lascoria-drag", json!({"state":"over","x":x,"y":y}));
        }
        DragDropEvent::Leave => {
            let _ = window.emit("lascoria-drag", json!({"state":"leave"}));
        }
        DragDropEvent::Drop { paths, position } => {
            let (x, y) = logical(window, *position);
            let token = drops.next.fetch_add(1, Ordering::SeqCst) + 1;
            let kept: Vec<PathBuf> = paths.iter().take(MAX_ENTRIES).cloned().collect();
            let entries: Vec<_> = kept
                .iter()
                .map(|path| {
                    let meta = std::fs::metadata(path).ok();
                    json!({
                        "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                        "path": path.to_str(),
                        "directory": meta.as_ref().is_some_and(|m| m.is_dir()),
                        "bytes": meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
                    })
                })
                .collect();
            *drops.last.lock().unwrap() = Some((token, kept));
            let _ = window.emit(
                "lascoria-drop",
                json!({"token":token,"x":x,"y":y,"entries":entries,"more":paths.len().saturating_sub(MAX_ENTRIES)}),
            );
        }
        _ => {}
    }
}

/// The bytes of one regular file from the most recent drop, for staging as an attachment.
#[tauri::command]
pub async fn read_dropped(
    _window: WebviewWindow,
    drops: tauri::State<'_, Drops>,
    token: u64,
    index: usize,
) -> Result<tauri::ipc::Response, String> {
    let path = {
        let last = drops.last.lock().unwrap();
        let (current, paths) = last.as_ref().ok_or("Nothing was dropped")?;
        if *current != token {
            return Err("That drop is no longer current; drop the file again".into());
        }
        paths.get(index).cloned().ok_or("Unknown dropped file")?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let meta = file.metadata().map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Only files can be attached".to_owned());
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err("That file is larger than 100 MB".to_owned());
        }
        let mut bytes = Vec::with_capacity(meta.len() as usize);
        file.take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("That file is larger than 100 MB".to_owned());
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::to_css;

    #[test]
    fn drop_positions_become_css_pixels_on_every_platform() {
        // macOS and Linux report points: a Retina scale must not move the drop.
        assert_eq!(to_css((1150.0, 800.0), 2.0, false), (1150.0, 800.0));
        // Windows reports pixels: 150% scaling divides back to CSS pixels.
        assert_eq!(to_css((1500.0, 900.0), 1.5, true), (1000.0, 600.0));
        assert_eq!(to_css((10.0, 20.0), 0.0, true), (10.0, 20.0));
    }
}
