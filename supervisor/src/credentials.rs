//! Native-only secret storage shared by independent integrations. Never journal values.
use anyhow::{Context, Result, bail};
use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore},
    time::timeout,
};

async fn permit() -> Result<OwnedSemaphorePermit> {
    static ACCESS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    timeout(
        Duration::from_millis(250),
        ACCESS
            .get_or_init(|| Arc::new(Semaphore::new(1)))
            .clone()
            .acquire_owned(),
    )
    .await
    .context("Credential operation still in progress; unlock your account vault and retry")?
    .context("Secure credential storage unavailable")
}
#[cfg(target_os = "macos")]
fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
    match security_framework::passwords::get_generic_password(service, account) {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.code() == -25300 => Ok(None),
        Err(_) => bail!("Keychain unavailable; unlock your Mac and retry"),
    }
}
#[cfg(not(target_os = "macos"))]
fn get(service: &str, account: &str) -> Result<Option<Vec<u8>>> {
    match keyring::Entry::new(service, account)?.get_secret() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => bail!("Secure credential store unavailable; unlock your account vault and retry"),
    }
}
#[cfg(target_os = "macos")]
fn put(service: &str, account: &str, value: Option<&[u8]>) -> Result<()> {
    let result = match value {
        Some(value) => security_framework::passwords::set_generic_password(service, account, value),
        None => security_framework::passwords::delete_generic_password(service, account),
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if value.is_none() && e.code() == -25300 => Ok(()),
        Err(_) => bail!("Could not update the secure Lascoria credential entry"),
    }
}
#[cfg(not(target_os = "macos"))]
fn put(service: &str, account: &str, value: Option<&[u8]>) -> Result<()> {
    let entry = keyring::Entry::new(service, account)?;
    match value.map_or_else(|| entry.delete_credential(), |v| entry.set_secret(v)) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) if value.is_none() => Ok(()),
        Err(_) => bail!("Could not update the secure Lascoria credential entry"),
    }
}
pub async fn read(service: &'static str, account: String) -> Result<Option<Vec<u8>>> {
    let permit = permit().await?;
    timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            get(service, &account)
        }),
    )
    .await
    .context("Credential read timed out")??
}
pub async fn write(service: &'static str, account: String, value: Option<Vec<u8>>) -> Result<()> {
    let permit = permit().await?;
    timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            put(service, &account, value.as_deref())
        }),
    )
    .await
    .context("Credential update timed out; check integration settings before retrying")??
}
