//! Control authority is bound to the connecting executable as well as the token (security
//! finding F1). The token is a file any same-user process can read, including repository
//! scripts and model-directed tools; the peer binding stops those from driving the supervisor.
//!
//! Binding is enforced when the desktop app starts the supervisor and names itself in
//! `SCH_DESKTOP_EXE`. Development and test supervisors started without it stay token-only.
use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::SystemTime,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Peer {
    /// The installed desktop app: every operation.
    Desktop,
    /// This binary in `--relay-mcp` mode: only the session-scoped relay tools.
    RelayHelper,
    /// Token-only development or test supervisor.
    Unbound,
}

/// The session helper's whole authority: relay messages and Muse's advisory decision tool,
/// which the supervisor refuses unless the user enabled it for that session's workspace.
const RELAY_HELPER_OPERATIONS: [&str; 5] = [
    "relay/agentPeers",
    "relay/agentRead",
    "relay/agentSend",
    "decision/tool",
    "decision/toolAvailable",
];
const CACHE_LIMIT: usize = 16;

/// Size, modification time and SHA-256 of a previously hashed executable.
type Digested = (u64, Option<SystemTime>, String);

struct Identity {
    path: PathBuf,
    sha256: String,
}

pub struct Policy {
    desktop: Option<Identity>,
    helper: PathBuf,
    // Hashes keyed by path, invalidated by size and modification time.
    cache: Mutex<HashMap<PathBuf, Digested>>,
}

fn digest(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

impl Policy {
    pub fn new(desktop: Option<&Path>, helper: &Path) -> Result<Self> {
        let desktop = desktop
            .map(|path| {
                let path = dunce::canonicalize(path).context("Desktop executable unavailable")?;
                ensure!(path.is_file(), "Desktop executable must be a file");
                Ok::<_, anyhow::Error>(Identity {
                    sha256: digest(&path)?,
                    path,
                })
            })
            .transpose()?;
        Ok(Self {
            desktop,
            helper: dunce::canonicalize(helper)?,
            cache: Mutex::new(HashMap::new()),
        })
    }
    pub fn from_env() -> Result<Self> {
        let desktop = std::env::var_os("SCH_DESKTOP_EXE").map(PathBuf::from);
        Self::new(desktop.as_deref(), &std::env::current_exe()?)
    }
    pub fn enforced(&self) -> bool {
        self.desktop.is_some()
    }
    fn cached_digest(&self, path: &Path) -> Result<String> {
        let meta = std::fs::metadata(path)?;
        let key = (meta.len(), meta.modified().ok());
        let mut cache = self.cache.lock().unwrap();
        if let Some((len, modified, hash)) = cache.get(path)
            && (*len, *modified) == key
        {
            return Ok(hash.clone());
        }
        let hash = digest(path)?;
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(path.to_owned(), (key.0, key.1, hash.clone()));
        Ok(hash)
    }
    /// Same path (updated in place) or same content (moved or translocated) is the desktop.
    pub fn classify(&self, executable: Option<PathBuf>) -> Result<Peer> {
        let Some(desktop) = &self.desktop else {
            return Ok(Peer::Unbound);
        };
        let refused = "Only the Lascoria app can control its background service";
        let Some(executable) = executable else {
            bail!("{refused}: the connecting program could not be identified");
        };
        let Ok(path) = dunce::canonicalize(&executable) else {
            bail!("{refused}");
        };
        if path == self.helper {
            return Ok(Peer::RelayHelper);
        }
        if path == desktop.path || self.cached_digest(&path).is_ok_and(|h| h == desktop.sha256) {
            return Ok(Peer::Desktop);
        }
        bail!(
            "{refused}. If you moved or updated Lascoria while it was running, restart your computer or end the constellation-supervisor process, then reopen Lascoria"
        )
    }
}

/// Compares a presented control token with the expected one in time that depends only on the
/// lengths, so response timing does not reveal how many leading bytes matched (F4).
pub fn same_secret(presented: &str, expected: &str) -> bool {
    let (a, b) = (presented.as_bytes(), expected.as_bytes());
    let mut difference = a.len() ^ b.len();
    for (index, byte) in b.iter().enumerate() {
        difference |= usize::from(a.get(index).copied().unwrap_or(0) ^ byte);
    }
    std::hint::black_box(difference) == 0
}

pub fn authorise(peer: Peer, operation: &str) -> Result<()> {
    if peer == Peer::RelayHelper {
        ensure!(
            RELAY_HELPER_OPERATIONS.contains(&operation),
            "The session message helper cannot perform {operation}"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn relay_helpers_cannot_read_keys_or_spend_on_decision_providers() {
        for operation in [
            "decision/status",
            "decision/setKey",
            "decision/test",
            "decision/evaluate",
            "decision/result",
        ] {
            assert!(authorise(Peer::RelayHelper, operation).is_err());
            assert!(authorise(Peer::Desktop, operation).is_ok());
        }
        // Only the advisory tool, scoped by the supervisor to the helper's own session.
        assert!(authorise(Peer::RelayHelper, "decision/tool").is_ok());
        assert!(authorise(Peer::RelayHelper, "decision/toolAvailable").is_ok());
        for operation in [
            "decision/configureMode",
            "decision/feedback",
            "decision/metrics",
            "decision/forgetKey",
        ] {
            assert!(authorise(Peer::RelayHelper, operation).is_err());
        }
    }

    #[test]
    fn token_comparison_needs_every_byte_and_the_length() {
        assert!(same_secret("abc123", "abc123"));
        assert!(!same_secret("abc124", "abc123"));
        assert!(!same_secret("abc12", "abc123"));
        assert!(!same_secret("abc1234", "abc123"));
        assert!(!same_secret("", "abc123"));
        assert!(!same_secret("bbc123", "abc123"));
    }

    #[test]
    fn binds_desktop_by_path_or_content_and_scopes_the_helper() -> Result<()> {
        let dir = Dir(std::env::temp_dir().join(format!("lascoria-peer-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir_all(&dir.0)?;
        let desktop = dir.0.join("Lascoria");
        let helper = dir.0.join("constellation-supervisor");
        std::fs::write(&desktop, b"desktop build 1")?;
        std::fs::write(&helper, b"supervisor build 1")?;
        let policy = Policy::new(Some(&desktop), &helper)?;
        assert!(policy.enforced());
        assert_eq!(policy.classify(Some(desktop.clone()))?, Peer::Desktop);
        // Moved or translocated copy of the same app.
        let moved = dir.0.join("Moved Lascoria");
        std::fs::copy(&desktop, &moved)?;
        assert_eq!(policy.classify(Some(moved.clone()))?, Peer::Desktop);
        // Updated in place at the original path.
        std::fs::write(&desktop, b"desktop build 2")?;
        assert_eq!(policy.classify(Some(desktop.clone()))?, Peer::Desktop);
        // Any other program, such as a repository script's interpreter, is refused.
        let script = dir.0.join("node");
        std::fs::write(&script, b"interpreter")?;
        assert!(policy.classify(Some(script.clone())).is_err());
        assert!(policy.classify(None).is_err());
        // Changing a cached file's content is noticed.
        std::fs::write(&moved, b"tampered and longer")?;
        assert!(policy.classify(Some(moved)).is_err());

        assert_eq!(policy.classify(Some(helper))?, Peer::RelayHelper);
        authorise(Peer::RelayHelper, "relay/agentSend")?;
        for operation in [
            "decide",
            "turn",
            "workspace/run",
            "data/export",
            "stop",
            "status",
        ] {
            assert!(
                authorise(Peer::RelayHelper, operation).is_err(),
                "{operation}"
            );
            authorise(Peer::Desktop, operation)?;
        }
        // Without a named desktop the supervisor stays token-only for development and tests.
        let open = Policy::new(None, &dir.0.join("constellation-supervisor"))?;
        assert!(!open.enforced());
        assert_eq!(open.classify(Some(script))?, Peer::Unbound);
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reports_the_real_peer_executable() -> Result<()> {
        let (a, _b) = tokio::net::UnixStream::pair()?;
        let exe = lascoria_runtime::platform::peer_executable(&a)?.context("peer process")?;
        assert_eq!(
            dunce::canonicalize(exe)?,
            dunce::canonicalize(std::env::current_exe()?)?
        );
        Ok(())
    }
}
