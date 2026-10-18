//! R3: in-app updates from signed GitHub Releases.
//!
//! The release pipeline signs every updater artifact with the maintainer's key; this build
//! carries only the public key (baked in at release build time) and refuses anything that does
//! not verify, including a correctly signed artifact announced under a different version.
//! Checks are ordinary HTTPS requests, never model calls, and only one runs at a time.
//! Downloading never installs: installing is a separate, explicit step after the app has made
//! sure running work is safe (see `install_stops_work`).
use serde_json::{Value, json};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Updater public key and endpoints, supplied by the release workflow. Development builds have
/// none, so they report updates as not configured rather than trusting an unsigned source.
const PUBKEY: Option<&str> = option_env!("LASCORIA_UPDATER_PUBKEY");
const STABLE: &str = "https://github.com/kabudu/lascoria/releases/latest/download/latest.json";
const BETA: &str = "https://github.com/kabudu/lascoria/releases/download/updater-beta/latest.json";

/// Windows installers replace the background service's files, which cannot happen while it
/// runs, so installing there needs work paused first. macOS and Linux replace the app in place
/// and the old service keeps running until it can be restarted safely.
pub const INSTALL_STOPS_WORK: bool = cfg!(windows);

#[derive(Default)]
pub struct Updates {
    state: Mutex<State>,
    checking: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct State {
    available: Option<Update>,
    downloaded: Option<Vec<u8>>,
    download: Option<tauri::async_runtime::JoinHandle<()>>,
    progress: Option<(u64, Option<u64>)>,
    last_checked_ms: Option<u128>,
    last_error: Option<String>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

/// Plain-language reasons; raw updater errors can contain URLs and internal detail.
fn explain(error: &tauri_plugin_updater::Error) -> String {
    let text = error.to_string().to_lowercase();
    if text.contains("signature") || text.contains("minisign") || text.contains("verify") {
        "The update did not pass its signature check, so it was not used".into()
    } else if text.contains("timed out") || text.contains("timeout") {
        "The update server did not respond in time. Try again later".into()
    } else if text.contains("dns") || text.contains("connect") || text.contains("network") {
        "Could not reach the update server. Check your connection and try again".into()
    } else if text.contains("platform") || text.contains("target") {
        "There is no update for this computer's system in that release".into()
    } else if text.contains("status") || text.contains("403") || text.contains("429") {
        "The update server refused the request; try again later".into()
    } else {
        "Checking for updates failed. Try again later".into()
    }
}

fn describe(state: &State) -> Value {
    json!({
        "available": state.available.as_ref().map(|u| json!({
            "version": u.version,
            "date": u.date.map(|d| d.unix_timestamp() * 1000),
            "notes": u.body.as_deref().map(|b| b.chars().take(20_000).collect::<String>()),
        })),
        "downloaded": state.downloaded.is_some(),
        "downloading": state.download.as_ref().is_some_and(|d| !d.inner().is_finished()),
        "progress": state.progress.map(|(received, total)| json!({"received":received,"total":total})),
        "lastCheckedAtMs": state.last_checked_ms.map(|ms| ms as u64),
        "lastError": state.last_error,
    })
}

#[tauri::command]
pub fn update_status(app: tauri::AppHandle, updates: tauri::State<'_, Updates>) -> Value {
    let mut status = describe(&updates.state.lock().unwrap());
    status["configured"] = json!(PUBKEY.is_some_and(|key| !key.is_empty()));
    status["currentVersion"] = json!(app.package_info().version.to_string());
    status["installStopsWork"] = json!(INSTALL_STOPS_WORK);
    status
}

/// Asks the release server whether a newer, compatible version exists for this system.
#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
    channel: String,
) -> Result<Value, String> {
    let Some(pubkey) = PUBKEY.filter(|key| !key.is_empty()) else {
        return Err("Updates are not available in this build of Lascoria".into());
    };
    let endpoint = match channel.as_str() {
        "stable" => STABLE,
        "beta" => BETA,
        _ => return Err("Unknown update channel".into()),
    };
    let Ok(_guard) = updates.checking.try_lock() else {
        return Err("Already checking for updates".into());
    };
    let result = async {
        app.updater_builder()
            .pubkey(pubkey)
            .endpoints(vec![
                endpoint
                    .parse()
                    .map_err(|_| "Invalid update address".to_string())?,
            ])
            .map_err(|e| explain(&e))?
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| explain(&e))?
            .check()
            .await
            .map_err(|e| explain(&e))
    }
    .await;
    let mut state = updates.state.lock().unwrap();
    state.last_checked_ms = Some(now_ms());
    match result {
        Ok(update) => {
            let changed =
                state.available.as_ref().map(|u| &u.version) != update.as_ref().map(|u| &u.version);
            if changed {
                // A different version supersedes any download in progress or finished.
                if let Some(task) = state.download.take() {
                    task.abort();
                }
                state.downloaded = None;
                state.progress = None;
            }
            state.available = update;
            state.last_error = None;
            Ok(describe(&state))
        }
        Err(error) => {
            state.last_error = Some(error.clone());
            Err(error)
        }
    }
}

/// Downloads and verifies the available update in the background, reporting progress through
/// `update-progress` events. Nothing is installed.
#[tauri::command]
pub fn update_download(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<(), String> {
    let mut state = updates.state.lock().unwrap();
    if state
        .download
        .as_ref()
        .is_some_and(|d| !d.inner().is_finished())
    {
        return Ok(());
    }
    let update = state.available.clone().ok_or("Check for updates first")?;
    state.downloaded = None;
    state.progress = Some((0, None));
    let handle = app.clone();
    state.download = Some(tauri::async_runtime::spawn(async move {
        let mut received = 0u64;
        let progress = handle.clone();
        let result = update
            .download(
                |chunk, total| {
                    received += chunk as u64;
                    let updates = progress.state::<Updates>();
                    updates.state.lock().unwrap().progress = Some((received, total));
                    let _ = progress.emit(
                        "update-progress",
                        json!({"received":received,"total":total}),
                    );
                },
                || {},
            )
            .await;
        let updates = handle.state::<Updates>();
        let mut state = updates.state.lock().unwrap();
        match result {
            Ok(bytes) => {
                state.downloaded = Some(bytes);
                state.last_error = None;
                let _ = handle.emit("update-progress", json!({"ready":true}));
            }
            Err(error) => {
                state.progress = None;
                state.last_error = Some(explain(&error));
                let _ = handle.emit("update-progress", json!({"failed":explain(&error)}));
            }
        }
    }));
    Ok(())
}

#[tauri::command]
pub fn update_cancel(updates: tauri::State<'_, Updates>) {
    let mut state = updates.state.lock().unwrap();
    if let Some(task) = state.download.take() {
        task.abort();
    }
    state.downloaded = None;
    state.progress = None;
}

/// Installs the verified download and restarts Lascoria. The window has already confirmed
/// that running work is safe; on Windows it has paused work and stopped the background service.
#[tauri::command]
pub fn update_install(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<(), String> {
    let (update, bytes) = {
        let state = updates.state.lock().unwrap();
        (
            state.available.clone().ok_or("Check for updates first")?,
            state
                .downloaded
                .clone()
                .ok_or("Download the update first")?,
        )
    };
    update
        .install(bytes)
        .map_err(|e| format!("The update could not be installed: {}", explain(&e)))?;
    app.restart();
}
