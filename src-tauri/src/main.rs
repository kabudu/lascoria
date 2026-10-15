#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod muse_setup;
use serde_json::{Value, json};
use std::{path::PathBuf, process::Stdio};
use tauri::{Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    time::{Duration, timeout},
};

fn directory() -> PathBuf {
    lascoria_runtime::state_dir()
}
async fn request(operation: &str, params: Value, id: String) -> Result<Value, String> {
    if ![
        "account/status",
        "account/login",
        "account/cancel",
        "account/logout",
        "account/setKey",
        "account/useKey",
        "account/forgetKey",
        "workspace/inspect",
        "workspace/files",
        "workspace/file",
        "workspace/run",
        "workspace/commit",
        "workspace/discard",
        "session/archive",
        "status",
        "diagnostics",
        "models",
        "setModel",
        "setEffort",
        "start",
        "turn",
        "steer",
        "cancel",
        "decide",
        "answer",
        "resume",
        "stop",
        "transcript",
        "output",
        "presentation/get",
        "presentation/save",
        "drafts/get",
        "drafts/save",
        "artifact/capture",
        "artifact/check",
        "artifact/read",
        "review/list",
        "evidence/record",
    ]
    .contains(&operation)
    {
        return Err("Unsupported operation".into());
    }
    let root = directory();
    let token = tokio::fs::read_to_string(root.join("token"))
        .await
        .map_err(|e| e.to_string())?;
    let payload = json!({"version":1,"token":token,"id":id,"operation":operation,"params":params})
        .to_string()
        + "\n";
    if payload.len() > 65536 {
        return Err("Request exceeds budget".into());
    }
    let duration = if operation == "status" {
        Duration::from_millis(500)
    } else {
        Duration::from_secs(30)
    };
    let result = timeout(duration, async {
        let mut stream = lascoria_runtime::platform::connect(&root).await?;
        stream.write_all(payload.as_bytes()).await?;
        let mut data = Vec::new();
        stream
            .take(40 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .await?;
        if data.len() > 40 * 1024 * 1024 {
            return Err(std::io::Error::other("Response exceeds budget"));
        }
        Ok::<_, std::io::Error>(data)
    })
    .await
    .map_err(|_| {
        "Operation timed out; outcome unknown. Refresh the command journal before retrying."
            .to_string()
    })?
    .map_err(|e| e.to_string())?;
    let response: Value = serde_json::from_slice(&result).map_err(|e| e.to_string())?;
    if let Some(error) = response["error"].as_str() {
        return Err(error.into());
    }
    Ok(response["result"].clone())
}
#[tauri::command]
async fn supervisor_request(operation: String, params: Value, id: String) -> Result<Value, String> {
    request(&operation, params, id).await
}
#[tauri::command]
async fn connect_supervisor(app: tauri::AppHandle) -> Result<Value, String> {
    if let Ok(status) = request("status", json!({}), "desktop-connect".into()).await {
        return Ok(status);
    }
    let resources = app
        .path()
        .resource_dir()
        .map(|path| dunce::simplified(&path).to_owned())
        .map_err(|e| e.to_string())?
        .join("runtime");
    let binary = resources.join(lascoria_runtime::executable("constellation-supervisor"));
    if !binary.is_file() {
        return Err("Installed Lascoria runtime is missing. Reinstall Lascoria or rebuild the runtime bundle.".into());
    }
    let mut cmd = std::process::Command::new(binary);
    cmd.env("SCH_RESOURCES", &resources)
        .env(
            "SCH_NODE",
            resources.join(lascoria_runtime::executable("node")),
        )
        .env("SCH_AUTH_MANAGED", "1")
        .env("SCH_PROVIDER", "meta")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc_setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008 | 0x00000200);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the installed supervisor: {e}"))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Ok(status) = request("status", json!({}), "desktop-connect".into()).await {
            return Ok(status);
        }
    }
    Err("Supervisor unavailable. Run the diagnostic supervisor to inspect startup.".into())
}
#[tauri::command]
async fn open_account_browser(url: String) -> Result<(), String> {
    // The host-provided verification URL is untrusted input, never a general shell command.
    if !url.starts_with("https://auth.meta.com/oauth/device/")
        || url.len() > 2048
        || !url.is_ascii()
        || url.contains(['\n', '\r', '\0'])
    {
        return Err("Muse returned an unsupported browser login address".into());
    }
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else if cfg!(windows) {
            "explorer.exe"
        } else {
            "xdg-open"
        })
        .arg(url)
        .kill_on_drop(true)
        .status(),
    )
    .await
    .map_err(|_| "Opening your browser timed out")?
    .map_err(|_| "Could not open your browser")?;
    if !result.success() {
        return Err("Could not open your browser".into());
    }
    Ok(())
}
#[cfg(unix)]
unsafe extern "C" {
    #[link_name = "setsid"]
    fn libc_setsid() -> i32;
}
#[tauri::command]
fn finish_quit(app: tauri::AppHandle) {
    app.exit(0);
}
fn main() {
    // Diagnostic entry point exercises the exact native bridge without a WebView.
    if std::env::args().nth(1).as_deref() == Some("--bridge-json") {
        let input: Value = serde_json::from_str(&std::env::args().nth(2).expect("JSON required"))
            .expect("Invalid JSON");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(request(
            input["operation"].as_str().unwrap(),
            input["params"].clone(),
            input["id"].as_str().unwrap_or("bridge-read").into(),
        ));
        match result {
            Ok(result) => println!("{}", json!({"result":result})),
            Err(error) => {
                println!("{}", json!({"error":error}));
                std::process::exit(1);
            }
        }
        return;
    }

    tauri::Builder::default()
        .manage(muse_setup::Setup::default())
        .invoke_handler(tauri::generate_handler![
            supervisor_request,
            connect_supervisor,
            open_account_browser,
            finish_quit,
            muse_setup::runtime_status,
            muse_setup::runtime_select,
            muse_setup::runtime_install,
            muse_setup::runtime_cancel
        ])
        .build(tauri::generate_context!())
        .expect("Tauri application failed")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event
                && code.is_none()
                && !app.webview_windows().is_empty()
            {
                api.prevent_exit();
                let _ = app.emit("lascoria-before-quit", ());
            }
        });
}
