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
use std::io::{self, Read};
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
/// The file a gated effect acts on: the path the gate checked, with every
/// symlink resolved. `perform` reaches exactly it, or fails.
pub struct Target(Option<PathBuf>);

pub fn gate(scope: &Scope, request: &EffectRequest, mode: ApprovalMode) -> (Gate, Target) {
    let change = |verb: &str, path: &str| match resolve(scope, path, true) {
        Access::Denied(why) => (Gate::Deny(why), Target(None)),
        Access::Ask(real) => {
            (Gate::Ask(format!("{verb} outside the workspace: {}", real.display())), Target(Some(real)))
        }
        Access::Allowed(real) if mode == ApprovalMode::Ask => (Gate::Ask(format!("{verb} {path}")), Target(Some(real))),
        Access::Allowed(real) => (Gate::Allow, Target(Some(real))),
    };
    match request {
        EffectRequest::Read { path, .. } => match resolve(scope, path, false) {
            Access::Denied(why) => (Gate::Deny(why), Target(None)),
            Access::Allowed(real) | Access::Ask(real) => (Gate::Allow, Target(Some(real))),
        },
        EffectRequest::Write { path, .. } => change("write", path),
        EffectRequest::Edit { path, .. } => change("edit", path),
        // A server can do anything its tool does, so only full-auto skips asking.
        EffectRequest::Mcp { server, tool, .. } => {
            let gate = if mode == ApprovalMode::FullAuto {
                Gate::Allow
            } else {
                Gate::Ask(format!("use {server}'s {tool} tool"))
            };
            (gate, Target(None))
        }
        EffectRequest::Bash { command, .. } => {
            let gate = if sandboxed_command(scope, command).is_none() {
                Gate::Ask(format!("run without a sandbox: {command}"))
            } else if mode == ApprovalMode::FullAuto {
                Gate::Allow
            } else {
                Gate::Ask(format!("run: {command}"))
            };
            (gate, Target(None))
        }
    }
}

/// Performs an effect the gate allowed (or a person approved), on the
/// target the gate checked. `cancelled` stops a running command early.
pub fn perform(scope: &Scope, request: &EffectRequest, target: &Target, cancelled: &AtomicBool) -> Result {
    let file = || target.0.as_deref().ok_or_else(|| Result::Refused("the effect has no checked path".into()));
    match request {
        EffectRequest::Read { path, offset, limit } => match file() {
            Ok(p) => read(p, path, *offset, *limit),
            Err(r) => r,
        },
        EffectRequest::Write { path, content } => match file() {
            Ok(p) => write(p, path, content.as_bytes()),
            Err(r) => r,
        },
        EffectRequest::Edit { path, old_text, new_text } => match file() {
            Ok(p) => edit(p, path, old_text, new_text),
            Err(r) => r,
        },
        EffectRequest::Bash { command, timeout_ms } => {
            bash(scope, command, timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS), cancelled)
        }
        // Tool calls are async and go to the session's server (see methods.rs).
        EffectRequest::Mcp { .. } => Result::Refused("an MCP tool call can't run as a file or command effect".into()),
    }
}

/// A pinned-file failure as the agent reads it.
fn explain(e: crate::pinned::Error, verb: &str, shown: &str) -> Result {
    use crate::pinned::Error as E;
    Result::Refused(match e {
        E::NotFound => format!("no such file: {shown}"),
        E::NotRegular => format!("{shown} is not a regular file"),
        E::Changed => format!("can't {verb} {shown}: a directory in its path was replaced while this ran"),
        E::Io(e) => format!("can't {verb} {shown}: {e}"),
    })
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
    let opened = crate::pinned::parent(p, false).and_then(|(dir, name)| dir.open_regular(&name));
    let (file, stat) = match opened {
        Ok(f) => f,
        Err(crate::pinned::Error::NotRegular) if p.is_dir() => {
            return Result::Refused(format!("{shown} is a directory; use bash to list it"));
        }
        Err(e) => return explain(e, "read", shown),
    };
    match read_lines(file, offset, limit) {
        Ok(Some((text, truncated))) => Result::Done { text, exit_code: None, truncated },
        Ok(None) => Result::Done {
            text: format!("{shown} is a binary file ({} bytes)", stat.st_size),
            exit_code: None,
            truncated: false,
        },
        Err(e) => Result::Refused(format!("can't read {shown}: {e}")),
    }
}

/// The requested lines, streamed so a huge file costs no more memory than
/// what is shown; `None` for a binary file.
fn read_lines(file: fs::File, offset: Option<u64>, limit: Option<u64>) -> io::Result<Option<(String, bool)>> {
    use std::io::BufRead;
    let mut r = io::BufReader::with_capacity(8192, file);
    if r.fill_buf()?.contains(&0) {
        return Ok(None);
    }
    let start = offset.unwrap_or(1).max(1);
    let limit = limit.unwrap_or(READ_LINES).min(READ_LINES);
    for _ in 1..start {
        if !skip_line(&mut r)? {
            return Ok(Some((String::new(), false)));
        }
    }
    let mut out = Vec::new();
    let mut shown_lines = 0;
    let mut line = Vec::new();
    loop {
        line.clear();
        // One byte past what fits, to tell a line that fits from one that doesn't.
        let room = (READ_BYTES - out.len().min(READ_BYTES)) as u64 + 1;
        if r.by_ref().take(room).read_until(b'\n', &mut line)? == 0 {
            return Ok(Some((String::from_utf8_lossy(&out).into_owned(), false)));
        }
        if shown_lines == limit || out.len() + line.len() > READ_BYTES {
            let mut text = String::from_utf8_lossy(&out).into_owned();
            let _ = writeln!(text, "[... more lines; read with offset {} to continue]", start + shown_lines);
            return Ok(Some((text, true)));
        }
        out.extend_from_slice(&line);
        shown_lines += 1;
    }
}

/// Reads past one line without keeping it; false at the end of the file.
fn skip_line(r: &mut impl std::io::BufRead) -> io::Result<bool> {
    loop {
        let buf = r.fill_buf()?;
        if buf.is_empty() {
            return Ok(false);
        }
        if let Some(i) = buf.iter().position(|&b| b == b'\n') {
            r.consume(i + 1);
            return Ok(true);
        }
        let n = buf.len();
        r.consume(n);
    }
}

fn write(p: &Path, shown: &str, bytes: &[u8]) -> Result {
    match crate::pinned::parent(p, true).and_then(|(dir, name)| dir.replace(&name, bytes)) {
        Ok(()) => {
            Result::Done { text: format!("wrote {shown} ({} bytes)", bytes.len()), exit_code: None, truncated: false }
        }
        Err(e) => explain(e, "write", shown),
    }
}

fn quoted(s: &str) -> String {
    let short: String = s.chars().take(60).collect();
    if short.len() < s.len() { format!("\"{short}…\"") } else { format!("\"{s}\"") }
}

fn edit(p: &Path, shown: &str, old: &str, new: &str) -> Result {
    let (dir, name) = match crate::pinned::parent(p, false) {
        Ok(d) => d,
        Err(e) => return explain(e, "edit", shown),
    };
    let text = match dir.open_regular(&name) {
        Ok((mut f, _)) => {
            let mut t = String::new();
            if let Err(e) = f.read_to_string(&mut t) {
                return Result::Refused(format!("can't read {shown}: {e}"));
            }
            t
        }
        Err(e) => return explain(e, "edit", shown),
    };
    if old.is_empty() {
        return Result::Refused("the text to replace is empty; use write to create a file".into());
    }
    match text.matches(old).count() {
        0 => Result::Refused(format!("{} does not appear in {shown}", quoted(old))),
        1 => match dir.replace(&name, text.replacen(old, new, 1).as_bytes()) {
            Ok(()) => Result::Done { text: format!("edited {shown}"), exit_code: None, truncated: false },
            Err(e) => explain(e, "edit", shown),
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
    let doomed = if matches!(ended, Ended::Exited(_)) { Vec::new() } else { freeze_tree(root) };
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

/// Stops `root` and every descendant, rescanning until no new ones appear
/// (a stopped process can't fork), and returns the descendants. Without the
/// freeze, a job forked between the scan and the kill would escape.
fn freeze_tree(root: i32) -> Vec<i32> {
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;
    let _ = kill(Pid::from_raw(root), Signal::SIGSTOP);
    let mut frozen: Vec<i32> = Vec::new();
    loop {
        let new: Vec<i32> = descendants(root).into_iter().filter(|p| !frozen.contains(p)).collect();
        if new.is_empty() {
            return frozen;
        }
        for &pid in &new {
            let _ = kill(Pid::from_raw(pid), Signal::SIGSTOP);
        }
        frozen.extend(new);
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
        EffectRequest::Mcp { server, tool, arguments } => R::Mcp {
            server: server.clone(),
            tool: tool.clone(),
            arguments: cas.put(&serde_json::to_vec(arguments).map_err(io::Error::other)?)?,
        },
    })
}
