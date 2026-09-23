//! Checkpoints: snapshots of a session's workspace in a shadow git
//! repository kept in strive's home, never in the workspace. The user's own
//! `.git`, index and refs are never touched, and the user's git
//! configuration, hooks and signing don't apply. Files the workspace's
//! `.gitignore` excludes are neither saved nor restored, and neither are
//! nested repositories (git would store only a pointer to their HEAD).

use std::collections::HashSet;
use std::io;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

/// Every git process running for a checkpoint or rewind, by process group.
/// A daemon that must exit with work unfinished kills these first, so a
/// restore can't go on changing files after it has given up ownership.
static RUNNING: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

/// Kills every checkpoint or rewind git still running.
pub fn kill_running() {
    for pgid in crate::sync::lock(&RUNNING).iter().flatten() {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(*pgid), nix::sys::signal::Signal::SIGKILL);
    }
}

/// Runs a git command in its own process group, registered while it runs.
fn output(cmd: &mut Command) -> io::Result<std::process::Output> {
    let child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn()?;
    let pgid = i32::try_from(child.id()).unwrap_or(i32::MAX);
    crate::sync::lock(&RUNNING).get_or_insert_default().insert(pgid);
    let out = child.wait_with_output();
    crate::sync::lock(&RUNNING).get_or_insert_default().remove(&pgid);
    out
}

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
        self.run_raw(args).map(|s| s.trim().to_string())
    }

    fn run_raw(&self, args: &[&str]) -> io::Result<String> {
        let mut cmd = Command::new(&self.git);
        cmd.args(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
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
            .stdin(Stdio::null());
        let out = output(&mut cmd)?;
        if !out.status.success() {
            return Err(io::Error::other(format!(
                "git {} failed: {}",
                args.first().unwrap_or(&""),
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// NUL-separated output as a list.
    fn list(&self, args: &[&str]) -> io::Result<Vec<String>> {
        Ok(self.run_raw(args)?.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect())
    }

    /// Nested repositories in the workspace, as paths relative to it: ones
    /// git lists as an untracked directory entry rather than their files,
    /// and pointers to them an earlier strive saved in the index.
    pub fn nested_repositories(&self) -> io::Result<Vec<String>> {
        let untracked = self.list(&["ls-files", "--others", "--exclude-standard", "-z"])?;
        let mut nested: Vec<String> =
            untracked.into_iter().filter_map(|p| p.strip_suffix('/').map(str::to_string)).collect();
        nested.extend(self.pointers()?);
        nested.extend(self.saved_directories_with_git()?);
        nested.sort();
        nested.dedup();
        Ok(nested)
    }

    /// Directories an earlier checkpoint saved files in that have since
    /// become repositories of their own: git lists them as neither untracked
    /// nor pointers, so they're found by their `.git`. One check per saved
    /// directory; ignored trees (`node_modules`, say) aren't walked.
    fn saved_directories_with_git(&self) -> io::Result<Vec<String>> {
        let mut dirs: HashSet<String> = HashSet::new();
        for file in self.list(&["ls-files", "-z"])? {
            dirs.extend(file.match_indices('/').map(|(i, _)| file[..i].to_string()));
        }
        let mut found: Vec<String> =
            dirs.into_iter().filter(|d| self.work_tree.join(d).join(".git").symlink_metadata().is_ok()).collect();
        found.sort();
        Ok(found)
    }

    /// Paths the index holds as pointers to nested repositories (mode 160000).
    fn pointers(&self) -> io::Result<Vec<String>> {
        Ok(self
            .list(&["ls-files", "-s", "-z"])?
            .into_iter()
            .filter_map(|l| l.strip_prefix("160000 ").and_then(|r| r.split_once('\t')).map(|(_, p)| p.to_string()))
            .collect())
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
        let nested = self.nested_repositories()?;
        // Pointers saved by an earlier strive would be restored as empty
        // directories; drop them, and exclude them below with the rest.
        let links = self.pointers()?;
        if !links.is_empty() {
            let mut args = vec!["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--"];
            args.extend(links.iter().map(String::as_str));
            self.run(&args)?;
        }
        let excluded: Vec<String> = nested.iter().map(|p| format!(":(exclude,literal){p}")).collect();
        let mut args = vec!["add", "-A", "--", "."];
        args.extend(excluded.iter().map(String::as_str));
        self.run(&args)?;
        self.run(&["commit", "-q", "--allow-empty", "--no-verify", "-m", message])?;
        self.run(&["rev-parse", "HEAD"])
    }

    /// What restoring `commit` would overwrite or remove that checkpoints
    /// don't save, so it would be lost: ignored files (or directories of
    /// them) and nested repositories. Names are compared without case,
    /// since on a case-insensitive filesystem `CACHE` is `cache`.
    pub fn unsaved_in_the_way(&self, commit: &str) -> io::Result<Vec<String>> {
        let mut unsaved =
            self.list(&["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])?;
        unsaved.extend(self.nested_repositories()?.into_iter().map(|p| format!("{p}/")));
        let restored: std::collections::HashSet<String> =
            self.list(&["ls-tree", "-r", "--name-only", "-z", commit])?.into_iter().map(|p| p.to_lowercase()).collect();
        let ancestors = |p: &str| -> Vec<String> {
            p.match_indices('/').map(|(i, _)| p[..i].to_string()).chain(std::iter::once(p.to_string())).collect()
        };
        let restored_dirs: std::collections::HashSet<String> = restored.iter().flat_map(|p| ancestors(p)).collect();
        Ok(unsaved
            .into_iter()
            .filter(|shown| {
                let path = shown.trim_end_matches('/').to_lowercase();
                let path = path.as_str();
                // The path itself, or a directory above it, is restored as a
                // file; or it is a directory the restore puts files into.
                ancestors(path).iter().any(|a| restored.contains(a)) || restored_dirs.contains(path)
            })
            .collect())
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
