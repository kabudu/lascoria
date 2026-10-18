//! Account policy and operating-system credential storage. Secrets never enter the command journal.
use crate::worker::SharedDb;
use anyhow::{Context, Result, bail, ensure};
use futures_util::StreamExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    process::{Child, ChildStdin, Command},
    time::timeout,
};
use tokio_util::codec::{FramedRead, LinesCodec};
const POLICY: &str = "account-policy-v1";
const SERVICE: &str = "dev.lascoria.credentials";

fn root() -> PathBuf {
    lascoria_runtime::state_dir()
}
fn config() -> PathBuf {
    fs::canonicalize(root())
        .unwrap_or_else(|_| env::current_dir().unwrap().join(root()))
        .join("account-config")
}
fn account() -> String {
    let path = fs::canonicalize(root()).unwrap_or_else(|_| root());
    let hash: String = Sha256::digest(path.as_os_str().as_encoded_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("{hash}:meta-api-key")
}
async fn read_key() -> Result<Option<Vec<u8>>> {
    crate::credentials::read(SERVICE, account()).await
}
async fn write_key(value: Option<Vec<u8>>) -> Result<()> {
    crate::credentials::write(SERVICE, account(), value).await
}

pub fn validate(operation: &str, params: &Value) -> Result<()> {
    ensure!(
        [
            "account/login",
            "account/cancel",
            "account/logout",
            "account/setKey",
            "account/useKey",
            "account/forgetKey"
        ]
        .contains(&operation),
        "Unsupported account operation"
    );
    let params = params.as_object().context("Invalid account parameters")?;
    if operation == "account/setKey" {
        ensure!(params.len() == 1, "Only apiKey is accepted");
        let value = params
            .get("apiKey")
            .and_then(Value::as_str)
            .context("API key required")?;
        ensure!(
            !value.trim().is_empty() && value.len() <= 8192 && !value.contains(['\n', '\r', '\0']),
            "Invalid API key"
        );
    } else {
        ensure!(params.is_empty(), "Account operation accepts no parameters");
    }
    Ok(())
}

pub fn managed(db: &SharedDb) -> bool {
    env::var("SCH_AUTH_MANAGED").as_deref() == Ok("1")
        || db
            .lock()
            .unwrap()
            .get("presentation", POLICY)
            .ok()
            .flatten()
            .is_some()
}
/// Configure a new SDK process from current non-secret policy, never from ambient API keys.
pub async fn configure(command: &mut Command, db: &SharedDb) -> Result<()> {
    if let Some(path) = lascoria_runtime::selected_muse() {
        command.env("MUSE_BIN", path);
    }
    command.env("MUSE_NO_AUTO_UPDATE", "1");
    if !managed(db) {
        return Ok(());
    }
    let policy = db
        .lock()
        .unwrap()
        .get("presentation", POLICY)?
        .unwrap_or(json!({"mode":"loggedOut"}));
    command
        .env_remove("META_API_KEY")
        .env_remove("MUSE_AUTH_PATH")
        .env("XDG_CONFIG_HOME", config())
        .env("SCH_PROVIDER", "meta");
    match policy["mode"].as_str() {
        Some("subscription") => {
            ensure!(
                policy["loginPending"] != true,
                "Complete browser sign-in before starting Muse"
            );
        }
        Some("apiKey") => {
            command.env(
                "META_API_KEY",
                String::from_utf8(read_key().await?.context("Configure an API key first")?)?,
            );
        }
        _ => bail!("Sign in to Lascoria before starting Muse"),
    }
    Ok(())
}
struct Host {
    child: Child,
    input: ChildStdin,
    output: FramedRead<tokio::process::ChildStdout, LinesCodec>,
}
impl Host {
    async fn spawn() -> Result<Self> {
        if let Ok(metadata) = fs::symlink_metadata(config()) {
            ensure!(
                metadata.is_dir() && !metadata.is_symlink(),
                "Account configuration must be a directory, not a symlink"
            );
        }
        lascoria_runtime::platform::private_dir(&config())?;
        let script = env::var_os("SCH_ACCOUNT_WORKER")
            .map(PathBuf::from)
            .unwrap_or_else(|| lascoria_runtime::worker("auth-worker.js"));
        let mut command = lascoria_runtime::command(lascoria_runtime::node());
        if let Some(path) = lascoria_runtime::selected_muse() {
            command.env("MUSE_BIN", path);
        }
        command.env("MUSE_NO_AUTO_UPDATE", "1");
        let mut child = command
            .arg(script)
            .env_remove("META_API_KEY")
            .env_remove("MUSE_AUTH_PATH")
            .env("XDG_CONFIG_HOME", config())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Start Muse account host")?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: FramedRead::new(
                child.stdout.take().unwrap(),
                LinesCodec::new_with_max_length(65536),
            ),
            child,
        })
    }
    async fn call(&mut self, operation: &str) -> Result<Value> {
        timeout(Duration::from_secs(15), async {
            self.input
                .write_all(format!("{}\n", json!({"operation":operation})).as_bytes())
                .await?;
            self.input.flush().await?;
            let value: Value = serde_json::from_str(
                &self
                    .output
                    .next()
                    .await
                    .context("Muse account host disconnected")??,
            )?;
            ensure!(
                value.get("error").is_none(),
                "Muse account operation failed; reconnect and try again"
            );
            Ok(value["result"].clone())
        })
        .await
        .context("Muse account operation timed out")?
    }
    async fn stop(&mut self) -> Result<()> {
        // Closing stdin lets the worker drain its Muse child before exit.
        let _ = self.input.shutdown().await;
        match timeout(Duration::from_secs(4), self.child.wait()).await {
            Ok(result) => {
                result.context("Reap Muse account host")?;
            }
            Err(_) => {
                self.child.start_kill()?;
                timeout(Duration::from_secs(2), self.child.wait())
                    .await
                    .context("Muse account host cleanup timed out")??;
            }
        }
        Ok(())
    }
}
pub struct Auth {
    db: SharedDb,
    host: Option<Host>,
    mode: String,
    enabled: bool,
    configured: bool,
    vault_available: bool,
    account: Value,
    outcome: Value,
    pending: bool,
    cached: Option<(Instant, Value)>,
    checked_version: String,
    logout_pending: bool,
    needs_login: bool,
    epoch: u128,
    pub ready: Arc<AtomicBool>,
}
impl Auth {
    pub fn new(db: SharedDb) -> Result<Self> {
        let enabled = managed(&db);
        let policy = db
            .lock()
            .unwrap()
            .get("presentation", POLICY)?
            .unwrap_or_else(|| json!({}));
        let mode = policy["mode"].as_str().unwrap_or("loggedOut").to_owned();
        // Keychain access is lazy; an empty first-run screen must not cause a system credential prompt.
        Ok(Self {
            db: db.clone(),
            host: None,
            mode,
            enabled,
            configured: false,
            vault_available: false,
            account: json!({"state":"loggedOut"}),
            outcome: Value::Null,
            pending: false,
            cached: None,
            checked_version: String::new(),
            logout_pending: policy["logoutPending"] == true,
            needs_login: policy["loginPending"] == true,
            epoch: policy["epoch"].as_u64().unwrap_or(0) as u128,
            ready: Arc::new(AtomicBool::new(!enabled)),
        })
    }
    fn persist(&mut self, mode: &str) -> Result<()> {
        self.enabled = true;
        self.mode = mode.into();
        self.needs_login = false;
        self.checked_version.clear();
        self.epoch = crate::db::now_ms();
        self.cached = None;
        self.ready.store(false, Ordering::SeqCst);
        self.db.lock().unwrap().put(
            "presentation",
            POLICY,
            &json!({"mode":mode,"epoch":self.epoch,"logoutPending":self.logout_pending,"loginPending":self.pending}),
        )
    }
    async fn call(&mut self, operation: &str) -> Result<Value> {
        if self.host.is_none() {
            self.host = Some(Host::spawn().await?);
        }
        let result = self.host.as_mut().unwrap().call(operation).await;
        if result.is_err() {
            if self.pending || operation == "login" {
                self.pending = false;
                self.outcome = json!("failed");
                self.needs_login = true;
                self.cached = None;
            }
            if let Some(mut host) = self.host.take() {
                let _ = host.stop().await;
            }
            self.ready.store(false, Ordering::SeqCst);
        }
        result
    }
    pub async fn status(&mut self) -> Result<Value> {
        let result = self.status_inner().await;
        if result.is_err() {
            self.ready.store(false, Ordering::SeqCst);
        }
        result
    }
    async fn status_inner(&mut self) -> Result<Value> {
        if let Some((at, value)) = &self.cached
            && at.elapsed() < Duration::from_secs(2)
        {
            return Ok(value.clone());
        }
        if self.enabled {
            match read_key().await {
                Ok(value) => {
                    self.configured = value.is_some();
                    self.vault_available = true;
                }
                Err(error) => {
                    self.vault_available = false;
                    // Optional BYOK storage must not gate browser subscription access.
                    if self.mode == "apiKey" {
                        return Err(error);
                    }
                }
            }
            if self.mode == "subscription" {
                let state = self.call("read").await?;
                self.account = state["account"].clone();
                self.outcome = state["outcome"].clone();
                if self.pending && !self.outcome.is_null() {
                    self.pending = false;
                    if self.outcome == "granted" && self.account["state"] == "accountLogin" {
                        self.persist("subscription")?;
                    } else {
                        self.needs_login = true;
                    }
                }
            } else {
                self.account = json!({"state":"loggedOut"});
            }
        }
        if self.enabled && self.mode == "subscription" && !self.needs_login {
            let database = self.db.lock().unwrap();
            let version = database.version();
            if version != self.checked_version {
                self.needs_login = database.auth_failed_since(self.epoch as u64)?;
                self.checked_version = version;
            }
        }
        let authenticated = !self.enabled
            || (self.mode == "subscription"
                && self.account["state"] == "accountLogin"
                && !self.pending
                && !self.needs_login)
            || (self.mode == "apiKey" && self.configured);
        self.ready.store(authenticated, Ordering::SeqCst);
        let value = json!({"managed":self.enabled,"mode":self.mode,"authenticated":authenticated,"keyConfigured":if self.vault_available {json!(self.configured)} else {Value::Null},"keyStorageAvailable":if self.enabled {json!(self.vault_available)} else {Value::Null},"subscription":self.account,"pending":self.pending,"outcome":self.outcome,"reconnectRequired":self.needs_login,"logoutPending":self.logout_pending});
        self.cached = Some((Instant::now(), value.clone()));
        Ok(value)
    }
    pub fn validate_transition(&self, operation: &str) -> Result<()> {
        ensure!(
            operation != "account/cancel" || self.pending,
            "There is no browser sign-in to cancel"
        );
        ensure!(
            !(operation == "account/useKey"
                && self.mode == "subscription"
                && self.account["state"] == "accountLogin"
                && !self.needs_login),
            "Sign out of your subscription before activating API billing"
        );
        Ok(())
    }
    pub fn changes_route(&self, operation: &str) -> bool {
        match operation {
            "account/cancel" => false,
            "account/setKey" => self.mode != "subscription",
            "account/forgetKey" => self.mode == "apiKey",
            _ => true,
        }
    }
    /// Persist the logout barrier before the caller drains authenticated session hosts.
    /// Keep pending-flow knowledge until handle() cancels the account connection.
    pub fn prepare_logout(&mut self) -> Result<()> {
        self.logout_pending = true;
        self.persist("loggedOut")
    }
    pub async fn handle(&mut self, operation: &str, params: Value) -> Result<Value> {
        ensure!(params.is_object(), "Invalid account parameters");
        // Gate locally before any fallible remote cleanup or Keychain operation.
        match operation {
            "account/login" => {
                self.logout_pending = false;
                self.pending = true;
                self.persist("subscription")?;
                self.outcome = Value::Null;
                // A new host cannot report an earlier flow's completion as this login.
                self.stop().await;
                let result = self.call("login").await?;
                Ok(result)
            }
            "account/cancel" => {
                self.pending = false;
                self.persist("loggedOut")?;
                let result = if self.host.is_some() {
                    self.call("cancel").await
                } else {
                    Ok(json!({}))
                };
                self.stop().await;
                result
            }
            "account/logout" => {
                self.logout_pending = true;
                self.pending = false;
                self.persist("loggedOut")?;
                self.account = json!({"state":"loggedOut"});
                self.outcome = Value::Null;
                // Muse's logout can revoke a credential shared with the CLI. Only
                // cancel this app's device flow and close its account connection.
                let cancelled = if self.host.is_some() {
                    self.call("cancel").await.map(|_| ())
                } else {
                    Ok(())
                };
                let closed = if let Some(mut host) = self.host.take() {
                    host.stop().await
                } else {
                    Ok(())
                };
                cancelled
                    .and(closed)
                    .context("Signed out locally; Muse login cleanup could not be confirmed")?;
                self.logout_pending = false;
                self.persist("loggedOut")?;
                self.status().await
            }
            "account/setKey" => {
                let value = params["apiKey"].as_str().context("API key required")?;
                ensure!(
                    !value.trim().is_empty()
                        && value.len() <= 8192
                        && !value.contains(['\n', '\r', '\0']),
                    "Invalid API key"
                );
                write_key(Some(value.as_bytes().to_vec())).await?;
                self.configured = true;
                if self.mode != "subscription" {
                    self.persist("apiKey")?;
                } else {
                    self.cached = None;
                }
                self.status().await
            }
            "account/useKey" => {
                if self.host.is_some() {
                    self.call("cancel").await?;
                    self.stop().await;
                }
                self.pending = false;
                ensure!(read_key().await?.is_some(), "Configure an API key first");
                self.persist("apiKey")?;
                self.status().await
            }
            "account/forgetKey" => {
                write_key(None).await?;
                self.configured = false;
                self.cached = None;
                if self.mode == "apiKey" {
                    self.persist("loggedOut")?;
                }
                self.status().await
            }
            _ => bail!("Unsupported account operation"),
        }
    }
    pub async fn stop(&mut self) {
        if let Some(mut host) = self.host.take() {
            let _ = host.stop().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn startup_reads_mode_epoch_and_pending_cleanup_without_relocking_database() {
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let db = Arc::new(std::sync::Mutex::new(
                crate::db::Db::open(std::path::Path::new(":memory:")).unwrap(),
            ));
            db.lock()
                .unwrap()
                .put(
                    "presentation",
                    POLICY,
                    &json!({"mode":"loggedOut","epoch":123,"logoutPending":true}),
                )
                .unwrap();
            let account = Auth::new(db).unwrap();
            send.send((account.mode, account.epoch, account.logout_pending))
                .unwrap();
        });
        assert_eq!(
            receive.recv_timeout(Duration::from_secs(2)).unwrap(),
            ("loggedOut".into(), 123, true)
        );
    }
}
