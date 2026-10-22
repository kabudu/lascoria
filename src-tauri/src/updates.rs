//! R3: in-app updates from signed GitHub Releases.
//!
//! The release pipeline signs every updater artifact with the maintainer's key; this build
//! carries only the public key (baked in at release build time) and refuses anything that does
//! not verify, including a correctly signed artifact announced under a different version.
//! Checks are ordinary HTTPS requests, never model calls, and only one runs at a time.
//! Downloading never installs: installing is a separate, explicit step after the app has made
//! sure running work is safe (see `install_stops_work`).
use serde_json::{Value, json};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const MAX_DOWNLOAD_BYTES: usize = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const DOWNLOAD_LIMIT_MESSAGE: &str =
    "This update exceeds Lascoria's 256 MB download limit and was not used";

/// Updater public key and endpoints, supplied by the release workflow. Development builds have
/// none, so they report updates as not configured rather than trusting an unsigned source.
const PUBKEY: Option<&str> = option_env!("LASCORIA_UPDATER_PUBKEY");
const STABLE: &str = "https://github.com/kabudu/lascoria/releases/latest/download/latest.json";
const BETA: &str = "https://github.com/kabudu/lascoria/releases/download/updater-beta/latest.json";

// QA builds are an explicit separate feature. No runtime environment or React argument can
// replace a production endpoint/key. The fixture server uses TLS and a compile-time CA.
#[cfg(any(feature = "update-acceptance", test))]
fn qa_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid QA update address")?;
    if url.scheme() != "https"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("QA updates require an HTTPS loopback address without credentials".into());
    }
    Ok(url)
}

fn endpoint(channel: &str) -> Result<&'static str, String> {
    let production = match channel {
        "stable" => STABLE,
        "beta" => BETA,
        _ => return Err("Unknown update channel".into()),
    };
    #[cfg(feature = "update-acceptance")]
    {
        let _ = production;
        let endpoint = option_env!("LASCORIA_QA_UPDATER_ENDPOINT")
            .ok_or("QA update endpoint was not compiled into this build")?;
        qa_url(endpoint)?;
        Ok(endpoint)
    }
    #[cfg(not(feature = "update-acceptance"))]
    Ok(production)
}

#[cfg(any(not(feature = "update-acceptance"), test))]
fn release_path(version: &str, system: &str, arch: &str) -> Option<String> {
    let (system, suffix) = match (system, arch) {
        ("macos", "aarch64" | "x86_64") => ("darwin", ".app.tar.gz"),
        ("windows", "x86_64") => ("windows", "-setup.exe"),
        ("linux", "aarch64" | "x86_64") => ("linux", ".AppImage"),
        _ => return None,
    };
    Some(format!(
        "/kabudu/lascoria/releases/download/v{version}/Lascoria_{version}_{system}-{arch}{suffix}"
    ))
}

fn validate_artifact_url(url: &reqwest::Url, endpoint: &str, version: &str) -> Result<(), String> {
    let secure = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    #[cfg(feature = "update-acceptance")]
    let allowed = {
        let _ = version;
        qa_url(endpoint).is_ok_and(|source| source.origin() == url.origin())
    };
    #[cfg(not(feature = "update-acceptance"))]
    let allowed = {
        let _ = endpoint;
        url.host_str() == Some("github.com")
            && url.port_or_known_default() == Some(443)
            && release_path(version, std::env::consts::OS, std::env::consts::ARCH)
                .is_some_and(|expected| url.path() == expected)
    };
    if !secure || !allowed {
        return Err("The update's download address does not match this version and computer's secure release source".into());
    }
    Ok(())
}

/// Keep upstream signature/version verification, but cancel its in-memory download when its
/// announced/received body exceeds the budget. A final check handles completion in the same
/// poll as the size signal. Dropping the future releases its buffer and network response.
async fn bounded_download<D, F, P>(
    download: D,
    mut progress: P,
    maximum: usize,
    wait: Duration,
) -> Result<Vec<u8>, String>
where
    D: FnOnce(Box<dyn FnMut(usize, Option<u64>) + Send>) -> F,
    F: Future<Output = Result<Vec<u8>, tauri_plugin_updater::Error>>,
    P: FnMut(u64, Option<u64>) + Send + 'static,
{
    let (limit_tx, limit_rx) = tokio::sync::oneshot::channel();
    let mut limit_tx = Some(limit_tx);
    let mut received = 0u64;
    let operation = download(Box::new(move |chunk, total| {
        received = received.saturating_add(chunk as u64);
        if received > maximum as u64 || total.is_some_and(|total| total > maximum as u64) {
            if let Some(tx) = limit_tx.take() {
                let _ = tx.send(());
            }
            return;
        }
        progress(received, total);
    }));
    tokio::select! {
        biased;
        Ok(()) = limit_rx => Err(DOWNLOAD_LIMIT_MESSAGE.into()),
        _ = tokio::time::sleep(wait) => Err("The update download timed out. Try again later".into()),
        result = operation => match result {
            Ok(bytes) if bytes.len() > maximum => Err(DOWNLOAD_LIMIT_MESSAGE.into()),
            Ok(bytes) => Ok(bytes),
            Err(error) => Err(explain(&error)),
        },
    }
}

/// Every current update replaces the full runtime, not only the UI. Pause and stop it first
/// on every OS: an old supervisor must never spawn workers from newly replaced resources.
/// Retaining work through UI-only updates requires a separately negotiated immutable runtime.
pub const INSTALL_STOPS_WORK: bool = true;

/// The supervisor holds this same full-file owner lock (fs2). Taking it proves shutdown has
/// completed and excludes another window starting a writer while installation replaces files.
fn install_guard(directory: &std::path::Path) -> Result<std::fs::File, String> {
    lascoria_runtime::platform::private_dir(directory)
        .map_err(|_| "Could not secure the update's local state directory")?;
    let guard = lascoria_runtime::platform::private_file(&directory.join("owner.lock"), false)
        .map_err(|_| "Could not open Lascoria's service lock")?;
    guard.try_lock().map_err(|_| "Lascoria's background service or another installer is still running. Pause work and wait for it to stop before installing")?;
    Ok(guard)
}

#[derive(Default)]
pub struct Updates {
    state: Mutex<State>,
    checking: tokio::sync::Mutex<()>,
}
#[derive(Default)]
struct State {
    available: Option<Update>,
    downloaded: Option<Arc<Vec<u8>>>,
    generation: u64,
    download: Option<tauri::async_runtime::JoinHandle<()>>,
    progress: Option<(u64, Option<u64>)>,
    last_checked_ms: Option<u128>,
    last_error: Option<String>,
}

impl State {
    fn invalidate_download(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        if let Some(task) = self.download.take() {
            task.abort();
        }
        self.downloaded = None;
        self.progress = None;
    }

    fn finish_download(&mut self, generation: u64, bytes: Vec<u8>) -> bool {
        if self.generation != generation {
            return false;
        }
        self.downloaded = Some(Arc::new(bytes));
        self.last_error = None;
        true
    }
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
        "Could not complete the update. Try again later".into()
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
    let endpoint = endpoint(&channel)?;
    let Ok(_guard) = updates.checking.try_lock() else {
        return Err("Already checking for updates".into());
    };
    let generation = updates.state.lock().unwrap().generation;
    let result: Result<Option<Update>, String> = async {
        let builder = app.updater_builder().pubkey(pubkey);
        #[cfg(feature = "update-acceptance")]
        let builder = {
            let certificate = option_env!("LASCORIA_QA_UPDATER_CERT_PEM")
                .ok_or("QA update certificate was not compiled into this build")?;
            let certificate = reqwest::Certificate::from_pem(certificate.as_bytes())
                .map_err(|_| "Invalid compiled QA update certificate")?;
            builder.configure_client(move |client| client.add_root_certificate(certificate.clone()))
        };
        let mut available = builder
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
            .map_err(|e| explain(&e))?;
        if let Some(update) = &mut available {
            validate_artifact_url(&update.download_url, endpoint, &update.version)?;
            // Upstream does not carry the builder's check timeout into Update::download.
            update.timeout = Some(DOWNLOAD_TIMEOUT);
        }
        Ok(available)
    }
    .await;
    let mut state = updates.state.lock().unwrap();
    if state.generation != generation {
        return Err("Update settings changed; check again for your chosen channel".into());
    }
    state.last_checked_ms = Some(now_ms());
    match result {
        Ok(update) => {
            // Channels may announce different artifacts with the same version. The
            // verified bytes belong to the URL and signature too, not just the version.
            let identity = |u: &Update| {
                (
                    u.version.clone(),
                    u.download_url.clone(),
                    u.signature.clone(),
                )
            };
            let changed = state.available.as_ref().map(identity) != update.as_ref().map(identity);
            if changed {
                // A different artifact supersedes any download in progress or finished.
                state.invalidate_download();
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
    state.generation = state.generation.wrapping_add(1);
    let generation = state.generation;
    state.downloaded = None;
    state.last_error = None;
    state.progress = Some((0, None));
    let handle = app.clone();
    state.download = Some(tauri::async_runtime::spawn(async move {
        let progress = handle.clone();
        let result = bounded_download(
            |report| async move { update.download(report, || {}).await },
            move |received, total| {
                let updates = progress.state::<Updates>();
                let mut state = updates.state.lock().unwrap();
                if state.generation != generation {
                    return;
                }
                state.progress = Some((received, total));
                let _ = progress.emit(
                    "update-progress",
                    json!({"received":received,"total":total}),
                );
            },
            MAX_DOWNLOAD_BYTES,
            DOWNLOAD_TIMEOUT,
        )
        .await;
        let updates = handle.state::<Updates>();
        let mut state = updates.state.lock().unwrap();
        if state.generation != generation {
            return;
        }
        match result {
            Ok(bytes) => {
                if state.finish_download(generation, bytes) {
                    let _ = handle.emit("update-progress", json!({"ready":true}));
                }
            }
            Err(error) => {
                state.progress = None;
                state.last_error = Some(error.clone());
                let _ = handle.emit("update-progress", json!({"failed":error}));
            }
        }
    }));
    Ok(())
}

#[tauri::command]
pub fn update_cancel(updates: tauri::State<'_, Updates>, clear_available: Option<bool>) {
    let mut state = updates.state.lock().unwrap();
    state.invalidate_download();
    if clear_available == Some(true) {
        state.available = None;
        state.last_checked_ms = None;
        state.last_error = None;
    }
}

/// Installs the verified download and restarts Lascoria. The window has explicitly confirmed
/// pausing work; Rust independently excludes a running background writer on every platform.
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
    let _service_guard = install_guard(&lascoria_runtime::state_dir())?;
    update
        .install(bytes.as_slice())
        .map_err(|e| format!("The update could not be installed: {}", explain(&e)))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installation_excludes_the_service_owner_and_other_installers() {
        let root = std::env::temp_dir().join(format!(
            "lascoria-update-lock-{}-{}",
            std::process::id(),
            now_ms()
        ));
        lascoria_runtime::platform::private_dir(&root).unwrap();
        let owner =
            lascoria_runtime::platform::private_file(&root.join("owner.lock"), false).unwrap();
        owner.try_lock().unwrap();
        assert!(
            install_guard(&root).is_err(),
            "a live writer prevents installation"
        );
        drop(owner);
        let installer = install_guard(&root).unwrap();
        assert!(
            install_guard(&root).is_err(),
            "another window cannot install concurrently"
        );
        #[cfg(unix)]
        {
            // fs2 uses flock on supported Unix targets; verify protocol interoperability,
            // including the reverse direction, rather than merely testing two std locks.
            use std::os::fd::AsRawFd;
            let supervisor =
                lascoria_runtime::platform::private_file(&root.join("owner.lock"), false).unwrap();
            assert_ne!(
                unsafe { libc::flock(supervisor.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            drop(installer);
            assert_eq!(
                unsafe { libc::flock(supervisor.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
                0
            );
            assert!(install_guard(&root).is_err());
            assert_eq!(
                unsafe { libc::flock(supervisor.as_raw_fd(), libc::LOCK_UN) },
                0
            );
        }
        #[cfg(not(unix))]
        drop(installer);
        drop(install_guard(&root).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn qa_sources_are_compile_time_https_loopback_only() {
        assert!(qa_url("https://127.0.0.1:8443/latest.json").is_ok());
        assert!(qa_url("https://localhost:8443/latest.json").is_ok());
        for value in [
            "http://127.0.0.1:8443/latest.json",
            "https://localhost.evil.test/latest.json",
            "https://user@localhost/latest.json",
            "https://localhost/latest.json#fragment",
        ] {
            assert!(qa_url(value).is_err(), "{value}");
        }
    }

    #[test]
    fn release_artifact_paths_bind_version_and_supported_platform() {
        for (system, arch, suffix) in [
            ("macos", "aarch64", ".app.tar.gz"),
            ("macos", "x86_64", ".app.tar.gz"),
            ("windows", "x86_64", "-setup.exe"),
            ("linux", "x86_64", ".AppImage"),
            ("linux", "aarch64", ".AppImage"),
        ] {
            let path = release_path("1.2.3-beta.1", system, arch).unwrap();
            assert!(path.contains("/v1.2.3-beta.1/Lascoria_1.2.3-beta.1_"));
            assert!(path.ends_with(&format!("{arch}{suffix}")));
        }
        assert!(release_path("1.2.3", "windows", "aarch64").is_none());
        assert!(release_path("1.2.3", "linux", "x86").is_none());
    }

    #[cfg(not(feature = "update-acceptance"))]
    #[test]
    fn production_artifacts_stay_on_secure_exact_version_and_target() {
        let path = release_path("1.2.3", std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let valid = format!("https://github.com{path}");
        assert!(validate_artifact_url(&valid.parse().unwrap(), STABLE, "1.2.3").is_ok());
        for value in [
            valid.replacen("https:", "http:", 1),
            valid.replace("github.com", "127.0.0.1"),
            valid.replace("/kabudu/lascoria/", "/other/repo/"),
            valid.replace("github.com", "user@github.com"),
            valid.replace("github.com", "github.com:8443"),
            format!("{valid}?other=target"),
            valid.replace("1.2.3", "1.2.4"),
            valid.replace("Lascoria_", "Other_"),
        ] {
            assert!(
                validate_artifact_url(&value.parse().unwrap(), STABLE, "1.2.3").is_err(),
                "{value}"
            );
        }
        // Even a properly signed same-version bundle for a different architecture is not
        // selected on this computer; signatures do not establish the target themselves.
        let other = if std::env::consts::ARCH == "aarch64" {
            "x86_64"
        } else {
            "aarch64"
        };
        if let Some(other_path) = release_path("1.2.3", std::env::consts::OS, other) {
            assert!(
                validate_artifact_url(
                    &format!("https://github.com{other_path}").parse().unwrap(),
                    STABLE,
                    "1.2.3"
                )
                .is_err()
            );
        }
    }

    #[tokio::test]
    async fn download_budget_cancels_real_transport_and_stalled_bodies() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // Exercise the wrapper with real socket reads and progress callbacks, including a
        // missing Content-Length. Native signed-app acceptance separately proves the actual
        // upstream signature/version verification and installation path.
        for (length, body_bytes, stall, expected) in [
            (Some(16), 16, false, "ok"),
            (Some(128), 64, true, "limit"),
            (None, 64, false, "limit"),
            (Some(16), 0, true, "timeout"),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request).await.unwrap();
                let size = length
                    .map(|size| format!("Content-Length: {size}\r\n"))
                    .unwrap_or_default();
                let headers = format!("HTTP/1.1 200 OK\r\n{size}Connection: close\r\n\r\n");
                socket.write_all(headers.as_bytes()).await.unwrap();
                socket.write_all(&vec![b'x'; body_bytes]).await.unwrap();
                if stall {
                    std::future::pending::<()>().await;
                }
            });
            // Keep platform proxy discovery/client setup outside the transport deadline.
            // Successful loopback reads need scheduling room on busy CI workers; the
            // deliberately stalled case retains its short cancellation deadline.
            let client = reqwest::Client::builder().no_proxy().build().unwrap();
            let result = bounded_download(
                |mut report| async move {
                    let mut response = client
                        .get(format!("http://{address}/bundle"))
                        .send()
                        .await?;
                    let total = response.content_length();
                    let mut body = Vec::new();
                    while let Some(chunk) = response.chunk().await? {
                        report(chunk.len(), total);
                        body.extend_from_slice(&chunk);
                    }
                    Ok(body)
                },
                |_, _| {},
                32,
                if expected == "timeout" {
                    Duration::from_millis(500)
                } else {
                    Duration::from_secs(5)
                },
            )
            .await;
            server.abort();
            match expected {
                "ok" => assert_eq!(result.unwrap(), vec![b'x'; 16]),
                "limit" => assert!(result.unwrap_err().contains("download limit")),
                _ => assert!(result.unwrap_err().contains("timed out")),
            }
        }
        let result = bounded_download(
            |_| async { Ok(vec![0; 33]) },
            |_, _| {},
            32,
            Duration::from_secs(1),
        )
        .await;
        assert!(
            result.unwrap_err().contains("download limit"),
            "final size check cannot be bypassed by missing progress"
        );
    }

    #[test]
    fn cancelled_download_cannot_become_ready_or_replace_its_successor() {
        let mut state = State::default();
        let old = state.generation;
        state.invalidate_download();
        assert!(!state.finish_download(old, vec![1, 2]));
        assert!(state.downloaded.is_none());
        let current = state.generation;
        assert!(state.finish_download(current, vec![3, 4]));
        assert!(!state.finish_download(old, vec![1, 2]));
        assert_eq!(state.downloaded.as_ref().unwrap().as_slice(), &[3, 4]);
        // Preparing an install shares the verified bytes instead of duplicating the bundle.
        let install = state.downloaded.clone().unwrap();
        assert!(Arc::ptr_eq(&install, state.downloaded.as_ref().unwrap()));
        state.invalidate_download();
        assert!(state.downloaded.is_none());
    }
}
