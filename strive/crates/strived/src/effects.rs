//! Effects: what the daemon does to the machine on the agent's behalf.
//!
//! Every path is resolved against the session's directory and checked
//! against one policy: strive's own state is never readable or writable, and
//! writes outside the workspace need approval. Commands run in the OS
//! sandbox (Seatbelt on macOS, bubblewrap on Linux): writes are confined to
//! the workspace and temp directories, strive's state is hidden, and the
//! network is off. Where no sandbox is available, every command asks first,
//! and runs unconfined only if a person allows it.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use strive_proto::{ApprovalMode, EffectRequest};

/// Where an effect runs.
pub struct Scope {
    /// The session's directory, canonical.
    pub workspace: PathBuf,
    /// strive's home, canonical: never readable or writable by an effect.
    pub strive_home: PathBuf,
}

/// What an effect produced, before it is journaled.
pub enum Result {
    Done { text: String, exit_code: Option<i32>, truncated: bool },
    Refused(String),
}

pub const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
const READ_LINES: u64 = 2000;
const READ_BYTES: usize = 256 * 1024;
/// Command output kept from each end when it is too long.
const OUTPUT_KEEP: usize = 100 * 1024;

/// A policy decision about a path.
enum Access {
    Allowed(PathBuf),
    /// Outside the workspace: allowed only with approval.
    Ask(PathBuf),
    Denied(String),
}

/// Whether an effect may run now, must be asked about, or is refused.
pub enum Gate {
    Allow,
    /// Needs a person's approval; the text describes the effect for them.
    Ask(String),
    Deny(String),
}

/// Applies the policy and the session's approval mode to a request.
pub fn gate(scope: &Scope, request: &EffectRequest, mode: ApprovalMode) -> Gate {
    let change = |verb: &str, path: &str| match resolve(scope, path, true) {
        Access::Denied(why) => Gate::Deny(why),
        Access::Ask(real) => Gate::Ask(format!("{verb} outside the workspace: {}", real.display())),
        Access::Allowed(_) if mode == ApprovalMode::Ask => Gate::Ask(format!("{verb} {path}")),
        Access::Allowed(_) => Gate::Allow,
    };
    match request {
        EffectRequest::Read { path, .. } => match resolve(scope, path, false) {
            Access::Denied(why) => Gate::Deny(why),
            Access::Allowed(_) | Access::Ask(_) => Gate::Allow,
        },
        EffectRequest::Write { path, .. } => change("write", path),
        EffectRequest::Edit { path, .. } => change("edit", path),
        EffectRequest::Bash { command, .. } => {
            if sandboxed_command(scope, command).is_none() {
                Gate::Ask(format!("run without a sandbox: {command}"))
            } else if mode == ApprovalMode::FullAuto {
                Gate::Allow
            } else {
                Gate::Ask(format!("run: {command}"))
            }
        }
    }
}

/// Performs an effect the gate allowed (or a person approved).
/// Performs an effect. `cancelled` stops a running command early.
pub fn perform(scope: &Scope, request: &EffectRequest, cancelled: &AtomicBool) -> Result {
    match request {
        EffectRequest::Read { path, offset, limit } => match resolve(scope, path, false) {
            Access::Allowed(p) | Access::Ask(p) => read(&p, path, *offset, *limit),
            Access::Denied(why) => Result::Refused(why),
        },
        EffectRequest::Write { path, content } => match resolve(scope, path, true) {
            Access::Allowed(p) | Access::Ask(p) => write(&p, path, content.as_bytes()),
            Access::Denied(why) => Result::Refused(why),
        },
        EffectRequest::Edit { path, old_text, new_text } => match resolve(scope, path, true) {
            Access::Allowed(p) | Access::Ask(p) => edit(&p, path, old_text, new_text),
            Access::Denied(why) => Result::Refused(why),
        },
        EffectRequest::Bash { command, timeout_ms } => {
            bash(scope, command, timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS), cancelled)
        }
    }
}

fn absolute(scope: &Scope, path: &str) -> PathBuf {
    let raw = Path::new(path);
    if raw.is_absolute() { raw.to_path_buf() } else { scope.workspace.join(raw) }
}

/// The path an effect would touch, after following every symlink that
/// exists, and whether the policy allows it.
fn resolve(scope: &Scope, path: &str, writing: bool) -> Access {
    let Some(real) = real_path(&absolute(scope, path)) else {
        return Access::Denied(format!("can't resolve {path}"));
    };
    // Global skills are the one part of strive's home the agent may read.
    let skill = !writing && real.starts_with(scope.strive_home.join("skills"));
    if real.starts_with(&scope.strive_home) && !skill {
        return Access::Denied("the agent can't read strive's own state".into());
    }
    if writing && !real.starts_with(&scope.workspace) {
        return Access::Ask(real);
    }
    Access::Allowed(real)
}

/// Canonicalizes the longest existing prefix and appends the rest, with `..`
/// resolved lexically only after symlinks in the existing part are followed.
fn real_path(p: &Path) -> Option<PathBuf> {
    let mut existing = p.to_path_buf();
    let mut rest = Vec::new();
    while fs::symlink_metadata(&existing).is_err() {
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?.to_path_buf();
    }
    let mut out = existing.canonicalize().ok()?;
    for part in rest.iter().rev() {
        match Path::new(part).components().next() {
            Some(Component::ParentDir) => {
                out.pop();
            }
            Some(Component::CurDir) | None => {}
            Some(_) => out.push(part),
        }
    }
    Some(out)
}

fn read(p: &Path, shown: &str, offset: Option<u64>, limit: Option<u64>) -> Result {
    let bytes = match fs::read(p) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Result::Refused(format!("no such file: {shown}")),
        Err(e) if e.kind() == io::ErrorKind::IsADirectory => {
            return Result::Refused(format!("{shown} is a directory; use bash to list it"));
        }
        Err(e) => return Result::Refused(format!("can't read {shown}: {e}")),
    };
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Result::Done {
            text: format!("{shown} is a binary file ({} bytes)", bytes.len()),
            exit_code: None,
            truncated: false,
        };
    }
    let text = String::from_utf8_lossy(&bytes);
    let start = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(READ_LINES).min(READ_LINES);
    let mut out = String::new();
    let mut shown_lines = 0;
    let mut truncated = false;
    for (i, line) in text.split_inclusive('\n').enumerate() {
        let n = i as u64 + 1;
        if n < start {
            continue;
        }
        if shown_lines == limit || out.len() + line.len() > READ_BYTES {
            truncated = true;
            let _ = writeln!(out, "[... more lines; read with offset {n} to continue]");
            break;
        }
        out.push_str(line);
        shown_lines += 1;
    }
    Result::Done { text: out, exit_code: None, truncated }
}

/// Replaces a file atomically, keeping an existing file's permissions.
fn replace_file(p: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = p.parent().ok_or_else(|| io::Error::other("no parent directory"))?;
    fs::create_dir_all(dir)?;
    let mode = fs::metadata(p).ok().map(|m| m.permissions().mode());
    let tmp =
        dir.join(format!(".{}.strive-{}", p.file_name().and_then(|n| n.to_str()).unwrap_or("f"), std::process::id()));
    let _ = fs::remove_file(&tmp);
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    if let Some(mode) = mode {
        fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    }
    fs::rename(&tmp, p)
}

fn write(p: &Path, shown: &str, bytes: &[u8]) -> Result {
    match replace_file(p, bytes) {
        Ok(()) => {
            Result::Done { text: format!("wrote {shown} ({} bytes)", bytes.len()), exit_code: None, truncated: false }
        }
        Err(e) => Result::Refused(format!("can't write {shown}: {e}")),
    }
}

fn quoted(s: &str) -> String {
    let short: String = s.chars().take(60).collect();
    if short.len() < s.len() { format!("\"{short}…\"") } else { format!("\"{s}\"") }
}

fn edit(p: &Path, shown: &str, old: &str, new: &str) -> Result {
    let text = match fs::read_to_string(p) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Result::Refused(format!("no such file: {shown}")),
        Err(e) => return Result::Refused(format!("can't read {shown}: {e}")),
    };
    if old.is_empty() {
        return Result::Refused("the text to replace is empty; use write to create a file".into());
    }
    match text.matches(old).count() {
        0 => Result::Refused(format!("{} does not appear in {shown}", quoted(old))),
        1 => match replace_file(p, text.replacen(old, new, 1).as_bytes()) {
            Ok(()) => Result::Done { text: format!("edited {shown}"), exit_code: None, truncated: false },
            Err(e) => Result::Refused(format!("can't write {shown}: {e}")),
        },
        n => Result::Refused(format!(
            "{} appears {n} times in {shown}; include more surrounding text so it matches once",
            quoted(old)
        )),
    }
}

/// The command that runs `bash -c command` in the sandbox, or `None` where
/// there is no sandbox.
fn sandboxed_command(scope: &Scope, command: &str) -> Option<Command> {
    let ws = scope.workspace.display();
    let home = scope.strive_home.display();
    if cfg!(target_os = "macos") {
        if !Path::new("/usr/bin/sandbox-exec").exists() {
            return None;
        }
        let tmp = std::env::temp_dir().canonicalize().unwrap_or_else(|_| PathBuf::from("/private/tmp"));
        let profile = format!(
            r#"(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write*
  (subpath "{ws}")
  (subpath "/private/tmp")
  (subpath "{tmp}")
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty")
  (regex #"^/dev/fd/") (regex #"^/dev/ttys"))
(deny file-read* file-write* (subpath "{home}"))
(allow file-read* (subpath "{home}/skills"))"#,
            tmp = tmp.display()
        );
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.args(["-p", &profile, "/bin/bash", "-c", command]);
        return Some(c);
    }
    let bwrap = which("bwrap")?;
    let mut c = Command::new(bwrap);
    // A private /tmp and /run: the host's hold sockets (the user's D-Bus and
    // systemd, X11, Docker) that can start processes outside the sandbox.
    c.args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run"]);
    c.args(["--bind"]).arg(&scope.workspace).arg(&scope.workspace);
    c.args(["--tmpfs"]).arg(&scope.strive_home);
    // Its own PID namespace: every process the command starts dies with it.
    c.args(["--unshare-net", "--unshare-pid", "--die-with-parent", "--", "/bin/bash", "-c", command]);
    Some(c)
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|p| std::env::split_paths(&p).map(|d| d.join(bin)).find(|p| p.is_file()))
}

/// Environment variables a command never sees: strive's own, the provider
/// keys only the gateway may use, and addresses of session buses that could
/// start processes outside the sandbox.
fn scrubbed(name: &str) -> bool {
    name.starts_with("STRIVE_")
        || name == "ANTHROPIC_API_KEY"
        || name == "OPENAI_API_KEY"
        || name == "DBUS_SESSION_BUS_ADDRESS"
}

enum Ended {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
}

fn bash(scope: &Scope, command: &str, timeout_ms: u64, cancelled: &AtomicBool) -> Result {
    // Without a sandbox the gate always asks, so reaching here unconfined
    // means a person approved exactly that.
    let mut cmd = sandboxed_command(scope, command).unwrap_or_else(|| {
        let mut c = Command::new("/bin/bash");
        c.args(["-c", command]);
        c
    });
    let (mut reader, writer) = match io::pipe() {
        Ok(p) => p,
        Err(e) => return Result::Refused(format!("can't run the command: {e}")),
    };
    let Ok(writer2) = writer.try_clone() else { return Result::Refused("can't run the command".into()) };
    for (k, _) in std::env::vars_os() {
        if k.to_str().is_some_and(scrubbed) {
            cmd.env_remove(&k);
        }
    }
    cmd.current_dir(&scope.workspace).stdin(Stdio::null()).stdout(writer).stderr(writer2).process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Result::Refused(format!("can't run the command: {e}")),
    };
    drop(cmd);
    let (captured, output) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = captured.send(capture(&mut reader));
    });
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let root = i32::try_from(child.id()).unwrap_or(i32::MAX);
    let ended = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ended::Exited(s),
            Ok(None) if cancelled.load(Ordering::SeqCst) => break Ended::Cancelled,
            Ok(None) if Instant::now() >= deadline => break Ended::TimedOut,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Result::Refused(format!("can't wait for the command: {e}")),
        }
    };
    // Descendants are found while the command still runs (a finished one's
    // children belong to init), including jobs that left its process group.
    let doomed = if matches!(ended, Ended::Exited(_)) { Vec::new() } else { descendants(root) };
    let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(root), nix::sys::signal::Signal::SIGKILL);
    for pid in doomed {
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL);
    }
    let _ = child.wait();
    // A process that escaped every kill (it daemonized) may hold the output
    // pipe open; don't wait on it.
    let (text, truncated) = output.recv_timeout(Duration::from_secs(1)).unwrap_or_default();
    let stopped = |why: String| Result::Done { text: why, exit_code: None, truncated };
    match ended {
        Ended::Exited(s) => Result::Done { text, exit_code: s.code(), truncated },
        Ended::TimedOut => stopped(format!(
            "the command timed out after {}.{}s and was stopped",
            timeout_ms / 1000,
            timeout_ms % 1000 / 100
        )),
        Ended::Cancelled => stopped("the command was interrupted and stopped".into()),
    }
}

/// Every process descended from `root`, by walking parent links from `ps`.
fn descendants(root: i32) -> Vec<i32> {
    let Ok(out) = Command::new("/bin/ps").args(["-A", "-o", "pid=", "-o", "ppid="]).output() else {
        return Vec::new();
    };
    let pairs: Vec<(i32, i32)> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace().map(str::parse::<i32>);
            Some((it.next()?.ok()?, it.next()?.ok()?))
        })
        .collect();
    let mut found = vec![root];
    let mut i = 0;
    while i < found.len() {
        let parent = found[i];
        found.extend(pairs.iter().filter(|(_, ppid)| *ppid == parent).map(|(pid, _)| *pid));
        i += 1;
    }
    found.split_off(1)
}

/// Reads a command's output, keeping the start and the end when it is long.
fn capture(r: &mut io::PipeReader) -> (String, bool) {
    let mut head = Vec::new();
    let mut tail = std::collections::VecDeque::new();
    let mut dropped = 0usize;
    let mut buf = [0u8; 16 * 1024];
    while let Ok(n) = r.read(&mut buf) {
        if n == 0 {
            break;
        }
        for &b in &buf[..n] {
            if head.len() < OUTPUT_KEEP {
                head.push(b);
            } else {
                tail.push_back(b);
                if tail.len() > OUTPUT_KEEP {
                    tail.pop_front();
                    dropped += 1;
                }
            }
        }
    }
    let mut out = String::from_utf8_lossy(&head).into_owned();
    if dropped > 0 {
        let _ = write!(out, "\n[... output cut: {dropped} bytes ...]\n");
    }
    out.push_str(&String::from_utf8_lossy(&tail.into_iter().collect::<Vec<u8>>()));
    (out, dropped > 0)
}

/// The journal's record of a request: payloads go to the content store.
pub fn record(cas: &strive_journal::cas::Cas, request: &EffectRequest) -> io::Result<strive_proto::EffectRecord> {
    use strive_proto::EffectRecord as R;
    Ok(match request {
        EffectRequest::Read { path, offset, limit } => R::Read { path: path.clone(), offset: *offset, limit: *limit },
        EffectRequest::Write { path, content } => {
            R::Write { path: path.clone(), content: cas.put(content.as_bytes())?, bytes: content.len() as u64 }
        }
        EffectRequest::Edit { path, old_text, new_text } => R::Edit {
            path: path.clone(),
            old_text: cas.put(old_text.as_bytes())?,
            new_text: cas.put(new_text.as_bytes())?,
        },
        EffectRequest::Bash { command, timeout_ms } => R::Bash {
            command: command.clone(),
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS),
        },
    })
}
