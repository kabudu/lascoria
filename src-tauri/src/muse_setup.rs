//! Fixed-vendor, version-pinned onboarding. No generic URL, shell installer or frontend execution.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};
const FINGERPRINT: &str = "sha256:5d3b43e5ccdb7dc4f5a32c380f5f2cde0f10e3059b93610afb2e73f73b1d914c";
const MAX_SIZE: u64 = 768 * 1024 * 1024;
#[derive(Default)]
pub struct Setup(
    pub Arc<Mutex<Value>>,
    pub Arc<AtomicBool>,
    pub tokio::sync::Mutex<()>,
);
fn target() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64_macos"),
        ("macos", "x86_64") => Ok("x86_macos"),
        ("linux", "aarch64") => Ok("aarch64_linux"),
        ("linux", "x86_64") => Ok("x86_linux"),
        ("windows", "aarch64") => Ok("aarch64_windows"),
        ("windows", "x86_64") => Ok("x86_windows"),
        _ => Err("This OS/architecture does not have a tested Muse artifact".into()),
    }
}
fn managed_path() -> PathBuf {
    lascoria_runtime::state_dir()
        .join("runtime")
        .join(lascoria_runtime::MUSE_BUILD)
        .join(lascoria_runtime::executable("muse"))
}
fn native(path: PathBuf) -> Option<PathBuf> {
    // Do not run a launcher merely to probe it: first run can install/update behind the UI.
    let sibling = path.parent()?.join(format!(
        "muse-bin-{}{}",
        lascoria_runtime::MUSE_BUILD,
        std::env::consts::EXE_SUFFIX
    ));
    if sibling.is_file() {
        return Some(sibling);
    }
    let mut f = std::fs::File::open(&path).ok()?;
    let mut magic = [0; 4];
    std::io::Read::read_exact(&mut f, &mut magic).ok()?;
    (*b"\x7fELF" == magic
        || magic[..2] == *b"MZ"
        || [
            [0xcf, 0xfa, 0xed, 0xfe],
            [0xfe, 0xed, 0xfa, 0xcf],
            [0xca, 0xfe, 0xba, 0xbe],
        ]
        .contains(&magic))
    .then_some(path)
}
async fn output(mut command: Command, seconds: u64) -> Result<Vec<u8>, String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Could not launch the runtime")?;
    let mut stdout = child.stdout.take().unwrap().take(8193);
    timeout(Duration::from_secs(seconds), async {
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Could not read runtime version")?;
        if bytes.len() > 8192 {
            return Err("Runtime response exceeds its limit");
        }
        if !child
            .wait()
            .await
            .map_err(|_| "Could not reap runtime")?
            .success()
        {
            return Err("Runtime compatibility check failed");
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| "Runtime check timed out".to_string())?
    .map_err(str::to_owned)
}
async fn probe(app: &tauri::AppHandle, path: &Path) -> Result<(), String> {
    let mut version = lascoria_runtime::command(path);
    version
        .arg("--version")
        .env("MUSE_NO_AUTO_UPDATE", "1")
        .env("MUSE_LOGIN", "0");
    let bytes = output(version, 5).await.map_err(|e| {
        format!("Muse version check: {e}. Check your system security notifications and retry")
    })?;
    let value = String::from_utf8_lossy(&bytes);
    if !value
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '.' && c != '-')
        .any(|word| word == lascoria_runtime::MUSE_VERSION || word == lascoria_runtime::MUSE_BUILD)
    {
        return Err(format!(
            "Muse {} is required by this version of Lascoria",
            lascoria_runtime::MUSE_VERSION
        ));
    }
    let resources = app
        .path()
        .resource_dir()
        .map(|path| dunce::simplified(&path).to_owned())
        .map_err(|_| "Runtime resources unavailable")?
        .join("runtime");
    let mut check = lascoria_runtime::command(resources.join(lascoria_runtime::executable("node")));
    check
        .arg(resources.join("workers").join("probe-worker.js"))
        .env("MUSE_BIN", path)
        .env("MUSE_NO_AUTO_UPDATE", "1")
        .env_remove("META_API_KEY")
        .env_remove("MUSE_AUTH_PATH");
    output(check, 20).await.map_err(|e| {
        format!("Muse protocol check: {e}. Check your system security notifications and retry")
    })?;
    Ok(())
}
async fn persist(path: &Path, managed: bool) -> Result<(), String> {
    let root = lascoria_runtime::state_dir();
    lascoria_runtime::platform::private_dir(&root)
        .map_err(|_| "Could not secure the setup directory")?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let staging = root.join(format!(
        "runtime-{}-{}.partial",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let value = json!({"musePath":path,"managed":managed,"version":lascoria_runtime::MUSE_VERSION});
    let result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .await?;
        file.write_all(value.to_string().as_bytes()).await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::rename(&staging, root.join("runtime.json")).await
    }
    .await;
    let _ = tokio::fs::remove_file(staging).await;
    result.map_err(|_| "Could not save runtime choice".to_owned())
}
#[tauri::command]
pub async fn runtime_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, Setup>,
) -> Result<Value, String> {
    let _guard = state.2.lock().await;
    let current = state.0.lock().unwrap().clone();
    if current["running"] == true {
        return Ok(current);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("Home directory unavailable")?;
    let mut candidates = Vec::new();
    if let Some(path) = lascoria_runtime::selected_muse() {
        candidates.push(path);
    }
    candidates.extend([
        managed_path(),
        home.join(".local/bin/muse"),
        home.join("AppData/Local/Programs/muse/muse.exe"),
        PathBuf::from("/opt/homebrew/bin/muse"),
        PathBuf::from("/usr/local/bin/muse"),
        PathBuf::from("/usr/bin/muse"),
    ]);
    if let Some(paths) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&paths).map(|p| p.join(lascoria_runtime::executable("muse"))),
        );
    }
    let mut failure = None;
    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }
        if let Some(path) = native(candidate) {
            match probe(&app, &path).await {
                Ok(()) => {
                    let managed = path == managed_path();
                    persist(&path, managed).await?;
                    return Ok(
                        json!({"state":"ready","ready":true,"path":path,"managed":managed,"version":lascoria_runtime::MUSE_VERSION}),
                    );
                }
                // A previously selected or older runtime (for example after a Lascoria upgrade)
                // must not hide a compatible one further down the list.
                Err(error) => {
                    failure.get_or_insert(error);
                }
            }
        }
    }
    Ok(
        json!({"state":if failure.is_some(){"incompatible"}else{"missing"},"ready":false,"required":lascoria_runtime::MUSE_VERSION,"message":failure.unwrap_or("Muse Code is required to run your agents".into()),"lastInstall":current}),
    )
}
#[tauri::command]
pub async fn runtime_select(
    app: tauri::AppHandle,
    path: String,
    state: tauri::State<'_, Setup>,
) -> Result<Value, String> {
    let _guard = state.2.lock().await;
    if state.0.lock().unwrap()["running"] == true {
        return Err("Finish or cancel installation first".into());
    }
    if path.len() > 4096 || !Path::new(&path).is_absolute() {
        return Err("Choose an absolute Muse executable path".into());
    }
    let path = native(PathBuf::from(path))
        .ok_or("Choose a native Muse executable, not an installer or shell script")?;
    probe(&app, &path).await?;
    persist(&path, false).await?;
    Ok(
        json!({"ready":true,"state":"ready","path":path,"managed":false,"version":lascoria_runtime::MUSE_VERSION}),
    )
}
fn vendor(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| {
            h == "lookaside.facebook.com" || h == "api.meta.ai" || h.ends_with(".fbcdn.net")
        })
}
#[tauri::command]
pub fn runtime_cancel(state: tauri::State<'_, Setup>) {
    state.1.store(true, Ordering::SeqCst);
}
#[tauri::command]
pub async fn runtime_install(
    app: tauri::AppHandle,
    state: tauri::State<'_, Setup>,
) -> Result<Value, String> {
    let _guard = state.2.lock().await;
    let platform = target()?;
    {
        let mut current = state.0.lock().unwrap();
        if current["running"] == true {
            return Err("An installation is already running".into());
        }
        *current = json!({"running":true,"phase":"connecting","bytes":0});
    }
    state.1.store(false, Ordering::SeqCst);
    let progress = state.0.clone();
    let cancelled = state.1.clone();
    tauri::async_runtime::spawn(async move {
        let result = install(&app, platform, progress.clone(), cancelled.clone()).await;
        *progress.lock().unwrap() = match result {
            Ok(value) => value,
            Err(message) => {
                json!({"running":false,"phase":if cancelled.load(Ordering::SeqCst){"cancelled"}else{"failed"},"message":message})
            }
        };
    });
    Ok(json!({"running":true,"phase":"connecting","bytes":0}))
}
async fn cancellable<F: std::future::Future>(
    future: F,
    cancelled: &AtomicBool,
) -> Result<F::Output, String> {
    tokio::pin!(future);
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Installation cancelled".into());
        }
        tokio::select! {
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}
async fn verified_download(
    mut response: reqwest::Response,
    file: &mut tokio::fs::File,
    size: u64,
    checksum: &str,
    progress: &Mutex<Value>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let mut digest = Sha256::new();
    let mut received = 0u64;
    while let Some(chunk) = cancellable(response.chunk(), cancelled)
        .await?
        .map_err(|_| "Muse download was interrupted")?
    {
        received += chunk.len() as u64;
        if received > size {
            return Err("Muse artifact exceeded its declared size".into());
        }
        digest.update(&chunk);
        cancellable(file.write_all(&chunk), cancelled)
            .await?
            .map_err(|_| "Could not write Muse. Check free disk space")?;
        *progress.lock().unwrap() =
            json!({"running":true,"phase":"downloading","bytes":received,"total":size});
    }
    let actual: String = digest
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if received != size || actual != checksum.to_ascii_lowercase() {
        return Err("Muse download failed integrity verification".into());
    }
    file.sync_all()
        .await
        .map_err(|_| "Could not finish writing Muse")?;
    Ok(())
}
async fn install(
    app: &tauri::AppHandle,
    platform: &str,
    progress: Arc<Mutex<Value>>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let path = managed_path();
    let parent = path.parent().unwrap();
    lascoria_runtime::platform::private_dir(&lascoria_runtime::state_dir())
        .map_err(|_| "Could not secure the Lascoria state directory")?;
    lascoria_runtime::platform::private_dir(parent)
        .map_err(|_| "Could not secure the Muse install directory")?;
    let lock = lascoria_runtime::platform::private_file(&parent.join("install.lock"), false)
        .map_err(|_| "Could not open installer lock")?;
    lock.try_lock()
        .map_err(|_| "Another Lascoria window is installing Muse")?;
    if path.exists() {
        probe(app, &path).await?;
        persist(&path, true).await?;
        return Ok(
            json!({"running":false,"phase":"ready","ready":true,"path":path,"version":lascoria_runtime::MUSE_VERSION}),
        );
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!(
            "Lascoria/",
            env!("CARGO_PKG_VERSION"),
            " Muse-Onboarding/1"
        ))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 3 && vendor(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|_| "Could not prepare the vendor connection")?;
    let url = format!(
        "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version={}&file=manifest.json",
        lascoria_runtime::MUSE_BUILD
    );
    let mut response = cancellable(client.get(url).send(), &cancelled)
        .await?
        .map_err(|_| "Cannot reach Meta. Check your connection and retry")?
        .error_for_status()
        .map_err(|_| "Meta's installer is unavailable")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = cancellable(response.chunk(), &cancelled)
        .await?
        .map_err(|_| "Could not read vendor manifest")?
    {
        if bytes.len() + chunk.len() > 65536 {
            return Err("Vendor manifest exceeds its limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid vendor manifest")?;
    if manifest["version"] != lascoria_runtime::MUSE_BUILD
        || manifest["msp_schema_fingerprint"] != FINGERPRINT
        || manifest["checksum_algorithm"] != "sha256"
    {
        return Err("Muse release is incompatible with this Lascoria adapter".into());
    }
    let artifact = &manifest["artifacts"][platform];
    let size = artifact["size"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= MAX_SIZE)
        .ok_or("Invalid vendor artifact size")?;
    let checksum = artifact["checksum"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("Invalid vendor checksum")?;
    let url = reqwest::Url::parse(artifact["url"].as_str().ok_or("Missing vendor artifact")?)
        .map_err(|_| "Invalid vendor artifact URL")?;
    if !vendor(&url) {
        return Err("Unsupported vendor artifact destination".into());
    }
    let temporary = parent.join("muse.partial");
    // We hold the cross-process installer lock: a partial file is from an interrupted prior attempt.
    if temporary.exists() {
        tokio::fs::remove_file(&temporary)
            .await
            .map_err(|_| "Could not remove an interrupted download")?;
    }
    let result=async {
        let response=cancellable(client.get(url).send(),&cancelled).await?.map_err(|_|"Muse download failed. Check your connection")?.error_for_status().map_err(|_|"Meta refused the Muse download")?;
        let mut file=tokio::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).await.map_err(|_|"Could not create the download file")?;
        verified_download(response,&mut file,size,checksum,&progress,&cancelled).await?;
        drop(file);
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(&temporary,std::fs::Permissions::from_mode(0o700)).await.map_err(|_|"Could not make Muse executable")?;
        }
        *progress.lock().unwrap()=json!({"running":true,"phase":"verifying","bytes":size,"total":size});
        cancellable(probe(app,&temporary),&cancelled).await??;
        if cancelled.load(Ordering::SeqCst) { return Err("Installation cancelled".into()); }
        tokio::fs::rename(&temporary,&path).await.map_err(|_|"Could not activate Muse installation")?;
        persist(&path,true).await?;
        Ok(json!({"running":false,"phase":"ready","ready":true,"path":path,"version":lascoria_runtime::MUSE_VERSION,"managed":true}))
    }.await;
    let _ = tokio::fs::remove_file(&temporary).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vendor_destinations_are_https_and_specific() {
        for url in [
            "https://api.meta.ai/a",
            "https://lookaside.facebook.com/a",
            "https://a.fbcdn.net/b",
        ] {
            assert!(vendor(&url.parse().unwrap()));
        }
        for url in [
            "http://api.meta.ai/a",
            "https://api.meta.ai.evil.invalid/a",
            "https://fbcdn.net.evil.invalid/a",
            "file:///tmp/muse",
        ] {
            assert!(!vendor(&url.parse().unwrap()));
        }
    }
    #[tokio::test]
    async fn cancellation_bounds_a_stalled_network_operation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let signal = cancelled.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            signal.store(true, Ordering::SeqCst);
        });
        let result = timeout(
            Duration::from_secs(1),
            cancellable(std::future::pending::<()>(), &cancelled),
        )
        .await
        .unwrap();
        assert!(result.is_err());
    }
    #[tokio::test]
    async fn integrity_check_rejects_wrong_bytes_and_short_downloads() {
        for (body, size, checksum, accept) in [
            (
                b"abc".as_slice(),
                3,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                true,
            ),
            (
                b"bad".as_slice(),
                3,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                false,
            ),
            (
                b"ab".as_slice(),
                3,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                false,
            ),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut input = [0; 4096];
                let _ = stream.read(&mut input).await;
                stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await
                    .unwrap();
                stream.write_all(body).await.unwrap();
            });
            let response = reqwest::get(format!("http://{address}")).await.unwrap();
            let path = std::env::temp_dir().join(format!(
                "lascoria-install-{}-{}",
                std::process::id(),
                accept
            ));
            let mut file = tokio::fs::File::create(&path).await.unwrap();
            let result = verified_download(
                response,
                &mut file,
                size,
                checksum,
                &Mutex::new(json!({})),
                &AtomicBool::new(false),
            )
            .await;
            assert_eq!(result.is_ok(), accept);
            drop(file);
            tokio::fs::remove_file(path).await.unwrap();
        }
    }
}
