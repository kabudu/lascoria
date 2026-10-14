#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::{Value, json};
use std::{env, path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    time::{Duration, timeout},
};

fn directory() -> PathBuf {
    env::var_os("SCH_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap()).join(".spatial-constellation")
        })
}
async fn request(operation: &str, params: Value, id: String) -> Result<Value, String> {
    if ![
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
        let mut stream = UnixStream::connect(root.join("supervisor.sock")).await?;
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
async fn connect_supervisor() -> Result<Value, String> {
    if let Ok(status) = request("status", json!({}), "desktop-connect".into()).await {
        return Ok(status);
    }
    // Source-checkout development unit. No worker or host is tied to the window lifetime.
    let binary = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../supervisor/target/debug/constellation-supervisor");
    let mut cmd = std::process::Command::new(binary);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            if libc_setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Build the supervisor first: {e}"))?;
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
unsafe extern "C" {
    #[link_name = "setsid"]
    fn libc_setsid() -> i32;
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
        .invoke_handler(tauri::generate_handler![
            supervisor_request,
            connect_supervisor
        ])
        .run(tauri::generate_context!())
        .expect("Tauri application failed");
}
