//! Installed runtime paths, independent of the source checkout and shell startup files.
use std::{env, path::PathBuf};
pub const MUSE_VERSION: &str = "1.4.10";
pub const MUSE_BUILD: &str = "1.4.10-R6427.1";
pub fn state_dir() -> PathBuf {
    env::var_os("SCH_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(
                env::var_os("HOME")
                    .or_else(|| env::var_os("USERPROFILE"))
                    .expect("User home unavailable"),
            )
            .join(".spatial-constellation")
        })
}
pub fn resources() -> Option<PathBuf> {
    env::var_os("SCH_RESOURCES").map(|p| dunce::simplified(&PathBuf::from(p)).to_owned())
}
pub fn executable(name: &str) -> String {
    format!("{name}{}", env::consts::EXE_SUFFIX)
}
pub fn node() -> PathBuf {
    env::var_os("SCH_NODE")
        .map(|p| dunce::simplified(&PathBuf::from(p)).to_owned())
        .or_else(|| resources().map(|p| p.join(executable("node"))))
        .unwrap_or_else(|| "node".into())
}
pub fn worker(name: &str) -> PathBuf {
    resources()
        .map(|p| p.join("workers").join(name))
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../src")
                .join(name)
        })
}
pub fn selected_muse() -> Option<PathBuf> {
    let selected = (|| {
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(state_dir().join("runtime.json")).ok()?).ok()?;
        let path = PathBuf::from(value["musePath"].as_str()?);
        path.is_absolute()
            .then(|| dunce::simplified(&path).to_owned())
    })();
    selected.or_else(|| env::var_os("MUSE_BIN").map(PathBuf::from))
}
pub fn configure_muse(command: &mut std::process::Command) {
    if let Some(path) = selected_muse() {
        command.env("MUSE_BIN", path);
    }
    command.env("MUSE_NO_AUTO_UPDATE", "1");
}
pub mod platform;
pub mod process;
pub fn fingerprint_mode(meta: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.mode()
    }
    #[cfg(windows)]
    {
        if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}
pub fn hooks_config() -> &'static str {
    if cfg!(windows) {
        "core.hooksPath=NUL"
    } else {
        "core.hooksPath=/dev/null"
    }
}
/// Background runtime children must not open console windows over the workspace.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut command = tokio::process::Command::new(program);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}
