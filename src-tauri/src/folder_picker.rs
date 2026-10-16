//! A directory-only chooser. Selection never reads contents or grants Muse permissions.
use std::{path::PathBuf, sync::Arc};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::{Semaphore, oneshot};

pub struct FolderPicker(Arc<Semaphore>);
impl Default for FolderPicker {
    fn default() -> Self {
        Self(Arc::new(Semaphore::new(1)))
    }
}

fn selected_path(path: PathBuf) -> Result<String, String> {
    let path = dunce::simplified(&path);
    let text = path.to_str().ok_or("Choose a folder with a UTF-8 path")?;
    if !path.is_absolute() || text.len() > 4096 || text.chars().any(char::is_control) {
        return Err("Choose an absolute folder path of at most 4096 bytes".into());
    }
    Ok(text.to_owned())
}

#[tauri::command]
pub async fn pick_workspace_folder(
    window: tauri::WebviewWindow,
    picker: tauri::State<'_, FolderPicker>,
) -> Result<Option<String>, String> {
    let permit = picker
        .0
        .clone()
        .try_acquire_owned()
        .map_err(|_| "A folder chooser is already open")?;
    let (send, receive) = oneshot::channel();
    window
        .app_handle()
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a workspace folder")
        .pick_folder(move |selection| {
            // Keep admission bounded even if the requesting WebView goes away.
            let _permit = permit;
            let result = selection
                .map(|file| {
                    file.into_path()
                        .map_err(|e| e.to_string())
                        .and_then(selected_path)
                })
                .transpose();
            let _ = send.send(result);
        });
    receive
        .await
        .map_err(|_| "Folder chooser closed unexpectedly")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bounded_absolute_text_paths_leave_the_picker() {
        let root = std::env::temp_dir().join("folder with spaces");
        assert_eq!(selected_path(root.clone()).unwrap(), root.to_str().unwrap());
        assert!(selected_path(PathBuf::from("relative")).is_err());
        assert!(selected_path(root.join("line\nbreak")).is_err());
        assert!(selected_path(root.join("x".repeat(4097))).is_err());
        // No existence/readability probe here: Rust validates at explicit Save/Start.
        assert!(selected_path(root.join("not-created")).is_ok());
    }
}
