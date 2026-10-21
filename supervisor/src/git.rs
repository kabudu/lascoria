//! Background Git must never execute repository-configured conversion programs.
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeSet, path::Path, process::Stdio};
use tokio::{
    io::AsyncReadExt,
    process::Command,
    time::{Duration, timeout},
};

fn base(root: &Path) -> Command {
    let mut command = lascoria_runtime::command("git");
    command
        .args([
            "-c",
            "core.fsmonitor=false",
            "-c",
            lascoria_runtime::hooks_config(),
            "-c",
            "commit.gpgsign=false",
        ])
        .arg("-C")
        .arg(dunce::simplified(root))
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null());
    command
}

async fn output(
    mut command: Command,
    limit: usize,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>)> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdout = child.stdout.take().unwrap().take(limit as u64 + 1);
    let mut stderr = child.stderr.take().unwrap().take(8193);
    let mut out = Vec::new();
    let mut err = Vec::new();
    let (a, b) = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
    a?;
    b?;
    ensure!(
        out.len() <= limit && err.len() <= 8192,
        "Git output exceeds budget"
    );
    Ok((child.wait().await?, out, err))
}

/// Re-read the effective filter configuration for each operation. Null delimiters preserve
/// even unusual subsection names; neither configuration values nor commands are executed.
fn drivers(bytes: &[u8]) -> Result<BTreeSet<String>> {
    let mut drivers = BTreeSet::new();
    for key in bytes.split(|b| *b == 0).filter(|key| !key.is_empty()) {
        let key = std::str::from_utf8(key).context("Git filter names must be UTF-8")?;
        let name = key
            .strip_prefix("filter.")
            .and_then(|s| s.rsplit_once('.'))
            .map(|p| p.0)
            .context("Invalid Git filter configuration")?;
        ensure!(
            !name.is_empty() && name.len() <= 128,
            "Git filter name exceeds budget"
        );
        drivers.insert(name.to_owned());
    }
    ensure!(drivers.len() <= 64, "Git filter count exceeds budget");
    Ok(drivers)
}

pub async fn run(
    root: &Path,
    args: &[&str],
    deadline: Duration,
    read_only: bool,
) -> Result<Vec<u8>> {
    timeout(deadline, async {
        let mut config = base(root);
        config.args(["config", "--null", "--name-only", "--get-regexp", r"^filter\..*\.(clean|smudge|process)$"]);
        let (status, names, error) = output(config, 16384).await?;
        ensure!(status.success() || status.code() == Some(1), "Git configuration could not be read: {}", String::from_utf8_lossy(&error));
        let mut command = base(root);
        let mut budget = 0;
        let configured = drivers(&names)?;
        let has_filters = !configured.is_empty();
        for driver in configured {
            // Required + empty commands fails closed when an attribute selects this driver.
            // Silently passing raw bytes could corrupt LFS or other transformed commits.
            for (setting, value) in [("clean", ""), ("smudge", ""), ("process", ""), ("required", "true")] {
                let entry = format!("filter.{driver}.{setting}={value}");
                budget += entry.len() + 4;
                ensure!(budget <= 8192, "Git filter policy exceeds argument budget");
                command.arg("-c").arg(entry);
            }
        }
        command.args(args);
        if read_only { command.env("GIT_OPTIONAL_LOCKS", "0"); }
        let (status, out, err) = output(command, 1024 * 1024).await?;
        ensure!(status.success(), "Git operation refused or failed: {}{}", String::from_utf8_lossy(&err), if has_filters { ". Lascoria does not run Git clean, smudge or process filters. Use your editor or Git client for files that require them." } else { "" });
        Ok(out)
    }).await.context("Git operation timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filter_names_are_bounded_null_delimited_and_preserve_subsections() {
        assert_eq!(
            drivers(b"filter.a.clean\0filter.a.smudge\0filter.odd\nname.process\0").unwrap(),
            BTreeSet::from(["a".to_owned(), "odd\nname".to_owned()])
        );
        assert!(drivers(b"filter.\xff.clean\0").is_err());
        assert!(drivers(format!("filter.{}.clean\0", "x".repeat(129)).as_bytes()).is_err());
        let too_many: String = (0..65).map(|n| format!("filter.f{n}.clean\0")).collect();
        assert!(drivers(too_many.as_bytes()).is_err());
    }
}
