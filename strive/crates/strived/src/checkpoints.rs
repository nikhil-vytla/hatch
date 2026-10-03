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

use strive_proto::{ChangeStatus, FileChange};

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
        self.run_indexed(args, &self.git_dir.join("index"))
    }

    fn run_indexed(&self, args: &[&str], index: &Path) -> io::Result<String> {
        let mut cmd = Command::new(&self.git);
        cmd.args(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
            .args(["-c", "user.name=strive", "-c", "user.email=strive@localhost"])
            .args(args)
            .env("GIT_DIR", &self.git_dir)
            .env("GIT_WORK_TREE", &self.work_tree)
            .env("GIT_INDEX_FILE", index)
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

    /// Makes the repository if it isn't there yet.
    fn init(&self) -> io::Result<()> {
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
        Ok(())
    }

    /// Takes checkpoint `commit` from another session's repository at
    /// `from` (a fork's parent, ADR-0030), so restoring it works here. Every
    /// checkpoint is on that repository's `HEAD`, so fetching `HEAD` brings
    /// it; a ref keeps it from being pruned.
    pub fn import(&self, from: &Path, commit: &str) -> io::Result<()> {
        self.init()?;
        let from = from.to_str().ok_or_else(|| io::Error::other("the repository's path isn't UTF-8"))?;
        self.run(&["fetch", "--no-tags", "-q", from, "+HEAD:refs/strive/parent"])?;
        self.run(&["update-ref", &format!("refs/strive/forked/{commit}"), commit])?;
        Ok(())
    }

    /// Saves the workspace as it is now and returns the commit.
    pub fn snapshot(&self, message: &str) -> io::Result<String> {
        self.init()?;
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

    /// What changed from `commit` to the files as they are now, as
    /// checkpoints see them (no ignored files, no nested repositories): at
    /// most `max_files` files, each file's text only up to `max_bytes`.
    pub fn changes(&self, commit: &str, max_files: usize, max_bytes: u64) -> io::Result<(Vec<FileChange>, bool)> {
        let now = self.current_tree()?;
        let listed = self.list(&["diff", "--name-status", "-z", "--no-renames", commit, &now])?;
        let mut files = Vec::new();
        let (pairs, _) = listed.as_chunks::<2>();
        for [status, path] in pairs.iter().take(max_files) {
            let status = match status.as_str() {
                "A" => ChangeStatus::Added,
                "D" => ChangeStatus::Deleted,
                _ => ChangeStatus::Modified,
            };
            let side = |rev: &str| -> io::Result<Option<String>> { self.text_at(rev, path, max_bytes) };
            let before = if status == ChangeStatus::Added { None } else { side(commit)? };
            let after = if status == ChangeStatus::Deleted { None } else { side(&now)? };
            let opaque = (status != ChangeStatus::Added && before.is_none())
                || (status != ChangeStatus::Deleted && after.is_none());
            files.push(FileChange { path: path.clone(), status, before, after, opaque });
        }
        Ok((files, pairs.len() > max_files))
    }

    /// The workspace as a tree, staged into an index of its own so the
    /// checkpoints' index (what the next snapshot starts from) is untouched.
    fn current_tree(&self) -> io::Result<String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let index = self.git_dir.join(format!("index.changes.{}.{n}", std::process::id()));
        // Starting from the checkpoints' index makes `add` fast: unchanged files are known.
        // The copy keeps the index's mtime. Git trusts an entry whose size and
        // mtime match the file unless the entry is no older than the index
        // file ("racy git"); with seconds-only timestamps (Linux's git), a
        // same-size edit in the checkpoint's second matches, and a copy
        // stamped later would have git skip it.
        let original = self.git_dir.join("index");
        if original.exists() {
            std::fs::copy(&original, &index)?;
            std::fs::File::open(&index)?.set_modified(std::fs::metadata(&original)?.modified()?)?;
        }
        let nested = self.nested_repositories()?;
        let excluded: Vec<String> = nested.iter().map(|p| format!(":(exclude,literal){p}")).collect();
        let mut args = vec!["add", "-A", "--", "."];
        args.extend(excluded.iter().map(String::as_str));
        let tree = self.run_indexed(&args, &index).and_then(|_| self.run_indexed(&["write-tree"], &index));
        let _ = std::fs::remove_file(&index); // a leftover is only a stale temporary file
        Ok(tree?.trim().to_string())
    }

    /// A file's text in `rev`, or `None` if it's binary or longer than `max_bytes`.
    fn text_at(&self, rev: &str, path: &str, max_bytes: u64) -> io::Result<Option<String>> {
        let spec = format!("{rev}:{path}");
        let size: u64 = self.run(&["cat-file", "-s", &spec])?.parse().unwrap_or(u64::MAX);
        if size > max_bytes {
            return Ok(None);
        }
        let text = self.run_raw(&["cat-file", "-p", &spec])?;
        // Lossy decoding turns what isn't UTF-8 into U+FFFD: binary either way.
        Ok((!text.contains('\0') && !text.contains('\u{FFFD}')).then_some(text))
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
