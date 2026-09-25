//! Where strive keeps its state. Everything lives under one home directory,
//! `~/.strive` by default, overridable with `STRIVE_HOME` (tests use this).

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Home {
    pub root: PathBuf,
}

impl Home {
    pub fn discover() -> Result<Self> {
        let root = match std::env::var_os("STRIVE_HOME") {
            Some(p) if !p.is_empty() => PathBuf::from(p),
            _ => PathBuf::from(std::env::var_os("HOME").context("HOME is not set")?).join(".strive"),
        };
        Ok(Self { root })
    }

    pub fn run_dir(&self) -> PathBuf {
        self.root.join("run")
    }
    pub fn socket(&self) -> PathBuf {
        self.run_dir().join("strived.sock")
    }
    pub fn lock(&self) -> PathBuf {
        self.run_dir().join("strived.lock")
    }
    pub fn log(&self) -> PathBuf {
        self.root.join("logs").join("strived.log")
    }

    /// Creates the home, run and log directories, private to this user.
    pub fn ensure(&self) -> Result<()> {
        for dir in [self.root.clone(), self.run_dir(), self.root.join("logs")] {
            fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("restricting {}", dir.display()))?;
        }
        Ok(())
    }
}

/// Identifies this exact binary: version plus the executable file's size and
/// mtime. A rebuilt or upgraded `strive` gets a new build id, so it can tell
/// that a running daemon may be stale and replace it. The inode is left out:
/// cargo puts a fresh copy in place on every run, and a false "stale" shuts
/// down a daemon under the sessions it's running. A false "current" would
/// need another build with the same size and nanosecond mtime.
pub fn build_id() -> String {
    let version = env!("CARGO_PKG_VERSION");
    let stamp = std::env::current_exe()
        .and_then(fs::metadata)
        .ok()
        .and_then(|m| {
            let mtime = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
            Some(format!("{:x}-{:x}", m.len(), mtime.as_nanos()))
        })
        .unwrap_or_else(|| "unknown".into());
    format!("{version}+{stamp}")
}
