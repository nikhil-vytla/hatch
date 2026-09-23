//! Checkpoints: snapshots of a session's workspace in a shadow git
//! repository kept in strive's home, never in the workspace. The user's own
//! `.git`, index and refs are never touched, and the user's git
//! configuration, hooks and signing don't apply. Files the workspace's
//! `.gitignore` excludes are neither saved nor restored.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub struct Shadow {
    git: PathBuf,
    git_dir: PathBuf,
    work_tree: PathBuf,
}

impl Shadow {
    /// `None` when there is no git to run, so checkpoints are off.
    pub fn new(git_dir: &Path, work_tree: &Path) -> Option<Self> {
        let git =
            std::env::var_os("STRIVE_GIT").map_or_else(|| crate::doctor::which("git"), |p| Some(PathBuf::from(p)))?;
        git.is_file().then(|| Self { git, git_dir: git_dir.to_path_buf(), work_tree: work_tree.to_path_buf() })
    }

    fn run(&self, args: &[&str]) -> io::Result<String> {
        let out = Command::new(&self.git)
            .args(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(["-c", "user.name=strive", "-c", "user.email=strive@localhost"])
            .args(args)
            .env("GIT_DIR", &self.git_dir)
            .env("GIT_WORK_TREE", &self.work_tree)
            .env("GIT_INDEX_FILE", self.git_dir.join("index"))
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .current_dir(&self.work_tree)
            .stdin(Stdio::null())
            .output()?;
        if !out.status.success() {
            return Err(io::Error::other(format!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Saves the workspace as it is now and returns the commit.
    pub fn snapshot(&self, message: &str) -> io::Result<String> {
        if !self.git_dir.join("HEAD").exists() {
            // git refuses to init with a work tree in the environment.
            let out = Command::new(&self.git)
                .args(["init", "-q", "--bare"])
                .arg(&self.git_dir)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env_remove("GIT_DIR")
                .env_remove("GIT_WORK_TREE")
                .stdin(Stdio::null())
                .output()?;
            if !out.status.success() {
                return Err(io::Error::other(format!(
                    "git init failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                )));
            }
            self.run(&["config", "core.bare", "false"])?;
        }
        self.run(&["add", "-A", "."])?;
        self.run(&["commit", "-q", "--allow-empty", "--no-verify", "-m", message])?;
        self.run(&["rev-parse", "HEAD"])
    }

    /// Makes the workspace match `commit`: changed files are put back,
    /// files created since are removed, deleted ones return. Call
    /// `snapshot` first, so files created since the last checkpoint are
    /// known and the rewind can be undone.
    pub fn restore(&self, commit: &str) -> io::Result<()> {
        self.run(&["read-tree", "-u", "--reset", commit])?;
        Ok(())
    }
}
