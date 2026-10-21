//! D2: open a session's folder, or a file inside it, in the user's own editor.
//!
//! The WebView names a session and a repository-relative path; the folder comes from the
//! supervisor's session record, and the target must resolve inside it. Editors start without a
//! shell, with the path as one argument. A custom editor can only be chosen through the native
//! file chooser, so the WebView cannot name an arbitrary program to run.
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

struct Preset {
    id: &'static str,
    name: &'static str,
    #[cfg(target_os = "macos")]
    bundle: &'static str,
    #[cfg(not(target_os = "macos"))]
    programs: &'static [&'static str],
}

#[cfg(target_os = "macos")]
const PRESETS: &[Preset] = &[
    Preset {
        id: "vscode",
        name: "Visual Studio Code",
        bundle: "com.microsoft.VSCode",
    },
    Preset {
        id: "cursor",
        name: "Cursor",
        bundle: "com.todesktop.230313mzl4w4u92",
    },
    Preset {
        id: "zed",
        name: "Zed",
        bundle: "dev.zed.Zed",
    },
    Preset {
        id: "sublime",
        name: "Sublime Text",
        bundle: "com.sublimetext.4",
    },
    Preset {
        id: "intellij",
        name: "IntelliJ IDEA",
        bundle: "com.jetbrains.intellij",
    },
    Preset {
        id: "xcode",
        name: "Xcode",
        bundle: "com.apple.dt.Xcode",
    },
];
#[cfg(windows)]
const PRESETS: &[Preset] = &[
    Preset {
        id: "vscode",
        name: "Visual Studio Code",
        programs: &[
            "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe",
            "%ProgramFiles%\\Microsoft VS Code\\Code.exe",
        ],
    },
    Preset {
        id: "cursor",
        name: "Cursor",
        programs: &["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe"],
    },
    Preset {
        id: "zed",
        name: "Zed",
        programs: &["%LOCALAPPDATA%\\Programs\\Zed\\Zed.exe"],
    },
    Preset {
        id: "sublime",
        name: "Sublime Text",
        programs: &["%ProgramFiles%\\Sublime Text\\sublime_text.exe"],
    },
];
#[cfg(all(unix, not(target_os = "macos")))]
const PRESETS: &[Preset] = &[
    Preset {
        id: "vscode",
        name: "Visual Studio Code",
        programs: &["code"],
    },
    Preset {
        id: "cursor",
        name: "Cursor",
        programs: &["cursor"],
    },
    Preset {
        id: "zed",
        name: "Zed",
        programs: &["zed", "zeditor"],
    },
    Preset {
        id: "sublime",
        name: "Sublime Text",
        programs: &["subl"],
    },
];

#[cfg(not(target_os = "macos"))]
fn locate(program: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let mut text = program.to_owned();
        for var in ["LOCALAPPDATA", "ProgramFiles"] {
            if let Ok(value) = std::env::var(var) {
                text = text.replace(&format!("%{var}%"), &value);
            }
        }
        let path = PathBuf::from(text);
        path.is_file().then_some(path)
    }
    #[cfg(not(windows))]
    {
        // GUI launches have a short PATH; also look in the usual user and system locations.
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).collect())
            .unwrap_or_default();
        if let Some(home) = std::env::var_os("HOME") {
            dirs.push(PathBuf::from(home).join(".local/bin"));
        }
        dirs.extend(["/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
        dirs.into_iter()
            .map(|dir| dir.join(program))
            .find(|path| path.is_file())
    }
}

#[cfg(target_os = "macos")]
fn installed(preset: &Preset) -> bool {
    // Launch Services knows the bundle if `open -Ra` can find it; avoid spawning per preset by
    // checking the standard application folders.
    let name = format!("{}.app", preset.name);
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    [PathBuf::from("/Applications"), home.join("Applications")]
        .iter()
        .any(|dir| dir.join(&name).exists())
}
#[cfg(not(target_os = "macos"))]
fn installed(preset: &Preset) -> bool {
    preset.programs.iter().any(|p| locate(p).is_some())
}

fn custom_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("editor.json"))
}
fn custom(app: &tauri::AppHandle) -> Option<PathBuf> {
    let text = std::fs::read_to_string(custom_file(app).ok()?).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let path = PathBuf::from(value["path"].as_str()?);
    (path.is_absolute() && path.exists()).then_some(path)
}

/// Editors Lascoria can open, for the Settings list. `system` is always available.
#[tauri::command]
pub fn list_editors(app: tauri::AppHandle) -> Value {
    let mut editors =
        vec![json!({"id":"system","name":"File manager (folders only)","available":true})];
    for preset in PRESETS {
        editors.push(json!({"id":preset.id,"name":preset.name,"available":installed(preset)}));
    }
    if let Some(path) = custom(&app) {
        let name = path
            .file_stem()
            .and_then(|n| n.to_str())
            .unwrap_or("Custom editor")
            .to_owned();
        editors.push(json!({"id":"custom","name":name,"available":true}));
    }
    json!(editors)
}

/// Choose a custom editor through the native chooser; only its path is stored.
#[tauri::command]
pub async fn pick_editor_application(
    window: tauri::WebviewWindow,
    picker: tauri::State<'_, crate::folder_picker::FolderPicker>,
) -> Result<Option<String>, String> {
    let permit = picker.acquire()?;
    let (send, receive) = oneshot::channel();
    window
        .app_handle()
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose your editor")
        .pick_file(move |selection| {
            let _permit = permit;
            let _ = send.send(selection.and_then(|file| file.into_path().ok()));
        });
    let Some(path) = receive.await.map_err(|_| "Chooser closed unexpectedly")? else {
        return Ok(None);
    };
    let path = dunce::simplified(&path).to_owned();
    let text = path
        .to_str()
        .ok_or("Choose an editor with a UTF-8 path")?
        .to_owned();
    if !path.is_absolute() || text.len() > 4096 || text.chars().any(char::is_control) {
        return Err("Choose an editor by its full path".into());
    }
    let file = custom_file(window.app_handle())?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, json!({"path":text}).to_string()).map_err(|e| e.to_string())?;
    Ok(path.file_stem().and_then(|n| n.to_str()).map(str::to_owned))
}

/// Resolves `relative` inside `root`: plain components only, and the canonical result must stay
/// inside the canonical root (links that escape are refused).
pub fn contained(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let root = dunce::canonicalize(root).map_err(|_| "This session's folder is unavailable")?;
    if relative.is_empty() {
        return Ok(root);
    }
    let candidate = Path::new(relative);
    if relative.len() > 4096
        || candidate.is_absolute()
        || !candidate
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Use a path inside the session's folder".into());
    }
    let target =
        dunce::canonicalize(root.join(candidate)).map_err(|_| "That file no longer exists")?;
    if !target.starts_with(&root) {
        return Err("That file is outside the session's folder".into());
    }
    Ok(target)
}

async fn launch(app: &tauri::AppHandle, editor: &str, target: &Path) -> Result<(), String> {
    let mut command;
    if editor == "custom" {
        let program = custom(app).ok_or("Choose your editor again in Settings")?;
        #[cfg(target_os = "macos")]
        if program.extension().is_some_and(|e| e == "app") {
            command = tokio::process::Command::new("/usr/bin/open");
            command.arg("-a").arg(&program).arg(target);
            return finish(command).await;
        }
        command = tokio::process::Command::new(program);
        command.arg(target);
        return spawn(command);
    }
    if editor == "system" {
        return crate::open_with_system(target).await;
    }
    let preset = PRESETS
        .iter()
        .find(|p| p.id == editor)
        .ok_or("Choose an editor in Settings")?;
    #[cfg(target_os = "macos")]
    {
        command = tokio::process::Command::new("/usr/bin/open");
        command.arg("-b").arg(preset.bundle).arg(target);
        finish(command)
            .await
            .map_err(|_| format!("Could not open {}. Is it installed?", preset.name))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let program = preset
            .programs
            .iter()
            .find_map(|p| locate(p))
            .ok_or_else(|| format!("{} was not found on this computer", preset.name))?;
        command = tokio::process::Command::new(program);
        command.arg(target);
        spawn(command)
    }
}

#[cfg(target_os = "macos")]
async fn finish(mut command: tokio::process::Command) -> Result<(), String> {
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        command.kill_on_drop(true).status(),
    )
    .await
    .map_err(|_| "Opening the editor timed out")?
    .map_err(|_| "Could not start the editor")?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "The editor could not open that path".into())
}

fn spawn(mut command: tokio::process::Command) -> Result<(), String> {
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = command.spawn().map_err(|_| "Could not start the editor")?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

/// Opens a session's folder (empty `path`) or a file inside it.
#[tauri::command]
pub async fn open_in_editor(
    app: tauri::AppHandle,
    session_id: String,
    path: String,
    editor: String,
) -> Result<(), String> {
    let status = crate::request("status", json!({}), "editor-open".into()).await?;
    let row = status["sessions"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == session_id.as_str()))
        .ok_or("Unknown session")?;
    if row["workspaceDiscarded"] == true {
        return Err("This session's task folder was discarded".into());
    }
    let root = row["workspace"]
        .as_str()
        .ok_or("This session has no folder")?;
    let target = contained(Path::new(root), &path)?;
    launch(&app, &editor, &target).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn system_fallback_refuses_files_and_missing_paths_before_os_dispatch() {
        let root =
            std::env::temp_dir().join(format!("lascoria-editor-policy-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Example.app")).unwrap();
        assert!(crate::validate_system_folder(&root).is_ok());
        for name in [
            "program.exe",
            "script.cmd",
            "script.sh",
            "shortcut.lnk",
            "note.txt",
        ] {
            let path = root.join(name);
            std::fs::write(&path, b"synthetic inert fixture").unwrap();
            assert!(
                crate::validate_system_folder(&path)
                    .unwrap_err()
                    .contains("Choose an editor")
            );
            assert!(
                crate::open_with_system(&path)
                    .await
                    .unwrap_err()
                    .contains("Choose an editor")
            );
        }
        assert!(crate::validate_system_folder(&root.join("missing")).is_err());
        #[cfg(target_os = "macos")]
        {
            let target = root.join("Example.app");
            let command = crate::system_folder_command(&target);
            let args: Vec<_> = command.as_std().get_args().collect();
            assert_eq!(args, vec![std::ffi::OsStr::new("-R"), target.as_os_str()]);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_paths_inside_the_session_folder_can_be_opened() {
        let base = std::env::temp_dir().join(format!("lascoria-editor-{}", std::process::id()));
        let root = base.join("repo");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "").unwrap();
        std::fs::write(base.join("secret.txt"), "").unwrap();
        let canonical = dunce::canonicalize(&root).unwrap();
        assert_eq!(contained(&root, "").unwrap(), canonical);
        assert_eq!(
            contained(&root, "src/main.rs").unwrap(),
            canonical.join("src/main.rs")
        );
        for bad in [
            "../secret.txt",
            "/etc/hosts",
            "src/../../secret.txt",
            "missing.rs",
        ] {
            assert!(contained(&root, bad).is_err(), "{bad}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), root.join("link.txt")).unwrap();
            assert!(contained(&root, "link.txt").is_err());
        }
        std::fs::remove_dir_all(&base).unwrap();
    }
}
