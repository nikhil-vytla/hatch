//! Effects: what the daemon does to the machine on the agent's behalf.
//!
//! Every path is resolved against the session's directory and checked
//! against one policy: strive's own state is never readable or writable,
//! writes outside the workspace need approval, and so does every write to
//! the project's learned files (`.strive/memory.md` and `.strive/skills`),
//! which change only through reviewed proposals (ADR-0016). Commands run in
//! the OS sandbox (Seatbelt on macOS, bubblewrap on Linux): writes are
//! confined to the workspace and temp directories, minus the learned files,
//! strive's state is hidden, and the network is off. Where no sandbox is
//! available, every command asks first, and runs unconfined only if a
//! person allows it.

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
    /// Settings chose to run commands unconfined (in a disposable container).
    pub unconfined: bool,
    /// Where sandboxed commands may write besides the workspace, and their
    /// `TMPDIR`. None: the system's temp directories. A replay's scratch
    /// area sets its own, so a project that itself lives under `/tmp` stays
    /// out of a replayed command's reach.
    pub temp: Option<PathBuf>,
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
    /// A learned file, with its path in the project: every session is told
    /// what it says, so the agent changes it only with a person's approval,
    /// whatever the approval mode.
    Learned(PathBuf, String),
    /// A file that runs code outside the sandbox later (see `protected`),
    /// with its path in the project: only a person may approve a change.
    Protected(PathBuf, String),
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
pub struct Target {
    path: Option<PathBuf>,
    /// A command the gate judged sandboxed must run sandboxed, or not at all.
    sandboxed: bool,
}

const fn file(path: PathBuf) -> Target {
    Target { path: Some(path), sandboxed: false }
}

const NOTHING: Target = Target { path: None, sandboxed: false };

impl Target {
    /// The file the effect acts on, if it acts on one.
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

pub fn gate(scope: &Scope, request: &EffectRequest, mode: ApprovalMode) -> (Gate, Target) {
    let change = |verb: &str, path: &str| match resolve(scope, path, true) {
        Access::Denied(why) => (Gate::Deny(why), NOTHING),
        Access::Ask(real) => (Gate::Ask(format!("{verb} outside the workspace: {}", real.display())), file(real)),
        Access::Learned(real, in_project) => {
            let shown = if Path::new(path) == Path::new(&in_project) {
                in_project
            } else {
                format!("{path}, which is {in_project}")
            };
            (
                Gate::Ask(format!(
                    "{verb} {shown}: this changes what every future session in this project is told, without review; \
                     `strive learn` proposes such changes and `strive review` is where a person accepts them"
                )),
                file(real),
            )
        }
        Access::Protected(real, in_project) => (
            Gate::Ask(format!(
                "{verb} {in_project}: files like this run code outside strive's sandbox later (git runs hooks and \
                 reads its config, shells read rc files, editors run tasks), so only a person can approve it"
            )),
            file(real),
        ),
        Access::Allowed(real) if mode == ApprovalMode::Ask => (Gate::Ask(format!("{verb} {path}")), file(real)),
        Access::Allowed(real) => (Gate::Allow, file(real)),
    };
    match request {
        EffectRequest::Read { path, .. } => match resolve(scope, path, false) {
            Access::Denied(why) => (Gate::Deny(why), NOTHING),
            Access::Allowed(real) | Access::Ask(real) | Access::Learned(real, _) | Access::Protected(real, _) => {
                (Gate::Allow, file(real))
            }
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
            (gate, NOTHING)
        }
        EffectRequest::Bash { command, .. } => {
            let sandboxed = !scope.unconfined && sandbox_available();
            let gate = if !sandboxed && !scope.unconfined {
                Gate::Ask(format!("run without a sandbox: {command}"))
            } else if mode == ApprovalMode::FullAuto {
                Gate::Allow
            } else {
                Gate::Ask(format!("run: {command}"))
            };
            (gate, Target { path: None, sandboxed })
        }
    }
}

/// Performs an effect the gate allowed (or a person approved), on the
/// target the gate checked. `cancelled` stops a running command early.
pub fn perform(scope: &Scope, request: &EffectRequest, target: &Target, cancelled: &AtomicBool) -> Result {
    // Cancelled while it waited to run (for a worker, say).
    if cancelled.load(Ordering::SeqCst) {
        return Result::Refused("interrupted before it ran".into());
    }
    let file = || target.path.as_deref().ok_or_else(|| Result::Refused("the effect has no checked path".into()));
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
            let timeout = timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
            bash(scope, command, timeout, target.sandboxed, cancelled)
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
    if writing && let Some(rel) = learned_file(&scope.workspace, &real) {
        return Access::Learned(real, rel);
    }
    if writing && let Some(rel) = protected(&scope.workspace, &real) {
        return Access::Protected(real, rel);
    }
    if writing && !real.starts_with(&scope.workspace) {
        return Access::Ask(real);
    }
    Access::Allowed(real)
}

/// The learned file `real` is, by its path in the project: the memory file,
/// or anything under the skills directory. Case is ignored: on a
/// case-insensitive filesystem `.STRIVE/Memory.md` is the memory file, and
/// on a case-sensitive one asking about it costs one question. A file the
/// project's own `.strive/memory.md` or `.strive/skills` leads to through a
/// symlink counts too, since that is what sessions are given.
/// Files that run code outside the sandbox when the person, not strive,
/// next uses them, anywhere in the project: shells read rc files, git reads
/// `.gitmodules`, ripgrep its config, Claude Code `.mcp.json`. After
/// sandbox-runtime's list.
const PROTECTED_FILES: &[&str] = &[
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
];

/// Directories and files named by their last components, anywhere in the
/// project (nested repositories too): git runs `.git/hooks` and reads
/// `.git/config` (`core.fsmonitor`, aliases); editors run `.vscode` and
/// `.idea` tasks; Claude Code runs `.claude` commands and agents. The rest
/// of `.git` stays writable, so git works in the sandbox.
const PROTECTED_DIRS: &[&[&str]] = &[
    &[".git", "hooks"],
    &[".git", "config"],
    &[".vscode"],
    &[".idea"],
    &[".claude", "commands"],
    &[".claude", "agents"],
];

/// The project path of `real` if it is one of the protected files, or
/// inside a protected directory; compared without case, since on a
/// case-insensitive volume `.GIT/HOOKS` is `.git/hooks`.
fn protected(workspace: &Path, real: &Path) -> Option<String> {
    let in_project = real.strip_prefix(workspace).ok()?;
    let parts: Vec<String> = in_project.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    let named_file = parts.last().is_some_and(|last| PROTECTED_FILES.contains(&last.as_str()));
    let in_dir =
        PROTECTED_DIRS.iter().any(|dir| parts.windows(dir.len()).any(|w| w.iter().zip(*dir).all(|(a, b)| a == b)));
    (named_file || in_dir).then(|| in_project.display().to_string())
}

/// `s` as a Seatbelt regex matching it in any case, each letter a class.
fn any_case(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                regex_escape(&c.to_string())
            }
        })
        .collect()
}

/// `s` with regex metacharacters escaped.
fn regex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if "\\.^$|?*+()[]{}".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Seatbelt rules denying writes to the protected files and directories
/// anywhere under `ws`.
fn protected_rules(ws: &str) -> String {
    let root = regex_escape(ws);
    let mut rules = String::new();
    for name in PROTECTED_FILES {
        let _ = write!(rules, "\n  (regex #\"^{root}(/.*)?/{}$\")", any_case(name));
    }
    for dir in PROTECTED_DIRS {
        let path: Vec<String> = dir.iter().map(|p| any_case(p)).collect();
        let _ = write!(rules, "\n  (regex #\"^{root}(/.*)?/{}(/.*)?$\")", path.join("/"));
    }
    rules
}

fn learned_file(workspace: &Path, real: &Path) -> Option<String> {
    let (memory, skills) = (strive_learning::MEMORY_PATH, strive_learning::SKILLS_DIR);
    if let Ok(rel) = real.strip_prefix(workspace) {
        let lower = rel.to_string_lossy().to_lowercase();
        if lower == memory || lower == skills || lower.starts_with(&format!("{skills}/")) {
            return Some(rel.display().to_string());
        }
    }
    if leads_to(&workspace.join(memory), SYMLINK_HOPS).is_some_and(|m| m == real) {
        return Some(memory.into());
    }
    let rest = real.strip_prefix(leads_to(&workspace.join(skills), SYMLINK_HOPS)?).ok()?;
    Some(Path::new(skills).join(rest).display().to_string())
}

/// As many symlinks as the kernel follows in one path (macOS's MAXSYMLINKS).
const SYMLINK_HOPS: u32 = 32;

/// Where an absolute path leads with every symlink on it followed, even
/// one that dangles: a write there creates what the path will then reach.
/// `..` applies to where the path has led so far, as the kernel does.
/// None past `hops` symlinks in all (a loop, say).
fn leads_to(p: &Path, mut hops: u32) -> Option<PathBuf> {
    follow(p, &mut hops)
}

fn follow(p: &Path, hops: &mut u32) -> Option<PathBuf> {
    let mut out = PathBuf::from("/");
    for part in p.components() {
        match part {
            Component::RootDir | Component::Prefix(_) => out = PathBuf::from("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => {
                let next = out.join(name);
                match fs::read_link(&next) {
                    Ok(target) => {
                        *hops = hops.checked_sub(1)?;
                        out = follow(&out.join(target), hops)?;
                    }
                    Err(_) => out = next,
                }
            }
        }
    }
    Some(out)
}

/// Canonicalizes the longest existing prefix and appends the rest, with `..`
/// resolved lexically only after symlinks in the existing part are followed.
pub fn real_path(p: &Path) -> Option<PathBuf> {
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

/// The user's own temp directory (`confstr(_CS_DARWIN_USER_TEMP_DIR)`),
/// asked of `getconf` once, since the crate forbids `unsafe`.
fn user_temp_dir() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let out = Command::new("/usr/bin/getconf").arg("DARWIN_USER_TEMP_DIR").output().ok()?;
        let text = String::from_utf8(out.stdout).ok()?;
        PathBuf::from(text.trim()).canonicalize().ok()
    })
    .clone()
}

/// Whether commands can run sandboxed here.
pub fn sandbox_available() -> bool {
    if cfg!(target_os = "macos") { Path::new("/usr/bin/sandbox-exec").exists() } else { which("bwrap").is_some() }
}

/// The command that runs `bash -c command` in the sandbox.
fn sandboxed_command(scope: &Scope, command: &str) -> io::Result<Command> {
    let ws = scope.workspace.display();
    let home = scope.strive_home.display();
    let (memory, skills) = (strive_learning::MEMORY_PATH, strive_learning::SKILLS_DIR);
    // Where the learned paths lead, if a symlink takes them elsewhere:
    // Seatbelt matches a write by the path it reaches.
    let memory_target = leads_to(&scope.workspace.join(memory), SYMLINK_HOPS);
    let skills_target = leads_to(&scope.workspace.join(skills), SYMLINK_HOPS);
    if cfg!(target_os = "macos") {
        // The paths go into the profile's string literals: one that would
        // need escaping could end a literal and add rules of its own. The
        // learned paths add only fixed ASCII to the workspace's.
        let unsafe_in_profile = |p: &Path| p.to_string_lossy().chars().any(|c| c == '"' || c == '\\' || c.is_control());
        let targets = memory_target.iter().chain(&skills_target).chain(&scope.temp);
        for p in [&scope.workspace, &scope.strive_home].into_iter().chain(targets) {
            if unsafe_in_profile(p) {
                return Err(io::Error::other(format!(
                    "{} has a quote, backslash or control character in its path, which the macOS sandbox profile can't hold safely",
                    p.display()
                )));
            }
        }
        // A replay's commands write only their own scratch temp directory,
        // so a project under /tmp stays out of reach. Otherwise commands may
        // write /private/tmp, the user's own temp directory, which macOS's
        // tools use whatever TMPDIR says (`mktemp` does), and the daemon's
        // TMPDIR. That one is the person's to set: if the profile can't hold
        // it, it's left out, not refused, and commands are pointed elsewhere.
        let (tmp, temps) = if let Some(own) = &scope.temp {
            (own.clone(), format!(" (subpath \"{}\")", own.display()))
        } else {
            let user_tmp = user_temp_dir().filter(|t| !unsafe_in_profile(t));
            let daemon_tmp = std::env::temp_dir().canonicalize().ok().filter(|t| !unsafe_in_profile(t));
            let tmp = daemon_tmp.clone().or_else(|| user_tmp.clone()).unwrap_or_else(|| PathBuf::from("/private/tmp"));
            let mut temps = String::from(" (subpath \"/private/tmp\")");
            for t in daemon_tmp.iter().chain(&user_tmp) {
                let _ = write!(temps, " (subpath \"{}\")", t.display());
            }
            (tmp, temps)
        };
        let mut linked = String::new();
        if let Some(t) = memory_target {
            let _ = write!(linked, " (literal \"{}\")", t.display());
        }
        if let Some(t) = skills_target {
            let _ = write!(linked, " (subpath \"{}\")", t.display());
        }
        // Learned files change only through review (ADR-0016). Denying
        // `.strive` itself stops a command from moving it aside, or making
        // it, with other files in place; its other files stay writable.
        // Seatbelt compares paths case-insensitively on a case-insensitive
        // volume, so other spellings are covered too.
        let protected = protected_rules(&scope.workspace.to_string_lossy());
        let profile = format!(
            r#"(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write*
  (subpath "{ws}")
  {temps}
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty")
  (regex #"^/dev/fd/") (regex #"^/dev/ttys"))
(deny file-write*
  (literal "{ws}/.strive")
  (literal "{ws}/{memory}")
  (subpath "{ws}/{skills}"){linked}{protected})
(deny file-read* file-write* (subpath "{home}"))
(allow file-read* (subpath "{home}/skills"))"#,
        );
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.args(["-p", &profile, "/bin/bash", "-c", command]);
        // The temp directory the profile allows, so tools that make temp
        // files (mktemp) don't reach for one it denies.
        c.env("TMPDIR", &tmp);
        return Ok(c);
    }
    let bwrap = which("bwrap").ok_or_else(|| io::Error::other("bwrap is gone"))?;
    let mut c = Command::new(bwrap);
    // A private /tmp and /run: the host's hold sockets (the user's D-Bus and
    // systemd, X11, Docker) that can start processes outside the sandbox.
    c.args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", "/run"]);
    c.args(["--bind"]).arg(&scope.workspace).arg(&scope.workspace);
    if let Some(own) = &scope.temp {
        c.args(["--bind"]).arg(own).arg(own);
    }
    // Learned files, where they exist, are read-only: they change only
    // through review (ADR-0016). A bind can't cover a path that doesn't
    // exist yet, so a command can still create a missing one here.
    for p in [memory_target, skills_target].into_iter().flatten() {
        c.args(["--ro-bind-try"]).arg(&p).arg(&p);
    }
    // The protected files and directories at the project's root, where they
    // exist (a bind needs something to bind); nested ones aren't covered here.
    let roots = PROTECTED_FILES.iter().map(|f| scope.workspace.join(f));
    for p in roots.chain(PROTECTED_DIRS.iter().map(|d| d.iter().collect::<PathBuf>()).map(|d| scope.workspace.join(d)))
    {
        c.args(["--ro-bind-try"]).arg(&p).arg(&p);
    }
    c.args(["--tmpfs"]).arg(&scope.strive_home);
    // As on macOS, no Unix sockets: one elsewhere (a Docker daemon under the
    // user's home, say) could start processes outside the sandbox.
    give_seccomp_filter(&mut c)?;
    // Its own PID namespace: every process the command starts dies with it.
    c.args(["--unshare-net", "--unshare-pid", "--die-with-parent", "--", "/bin/bash", "-c", command]);
    // The host's TMPDIR isn't in the sandbox's view; its private /tmp is.
    c.env("TMPDIR", "/tmp");
    Ok(c)
}

/// The descriptor bubblewrap reads its seccomp program from, in the child.
#[cfg(target_os = "linux")]
const SECCOMP_FD: i32 = 3;

/// Hands bubblewrap a seccomp program (on fd 3 of that child alone: the
/// pipe is close-on-exec here, so no other command inherits it) in which,
/// with EPERM:
/// - creating a Unix socket fails;
/// - so does a Unix datagram `socketpair`, which could `sendto` a socket by
///   path (stream pairs stay: runtimes use them to talk to their children);
/// - so does `io_uring_setup`, whose ops create sockets without the syscall.
#[cfg(target_os = "linux")]
fn give_seccomp_filter(c: &mut Command) -> io::Result<()> {
    use command_fds::{CommandFdExt, FdMapping};
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule,
    };
    use std::io::Write as _;
    let bad = |e: &dyn std::fmt::Display| io::Error::other(format!("the seccomp filter: {e}"));
    let arch = std::env::consts::ARCH.try_into().map_err(|e| bad(&e))?;
    let arg = |index, op, value| SeccompCondition::new(index, SeccompCmpArgLen::Dword, op, value).map_err(|e| bad(&e));
    let unix = || arg(0, SeccompCmpOp::Eq, libc::AF_UNIX as u64);
    let dgram = arg(1, SeccompCmpOp::MaskedEq(0xf), libc::SOCK_DGRAM as u64)?;
    let rules = [
        (libc::SYS_socket, vec![SeccompRule::new(vec![unix()?]).map_err(|e| bad(&e))?]),
        (libc::SYS_socketpair, vec![SeccompRule::new(vec![unix()?, dgram]).map_err(|e| bad(&e))?]),
        (libc::SYS_io_uring_setup, vec![]),
    ]
    .into_iter()
    .collect();
    let filter = SeccompFilter::new(rules, SeccompAction::Allow, SeccompAction::Errno(libc::EPERM as u32), arch)
        .map_err(|e| bad(&e))?;
    let mut program: BpfProgram = filter.try_into().map_err(|e| bad(&e))?;
    refuse_x32(&mut program);
    let mut bytes = Vec::with_capacity(program.len() * 8);
    for f in &program {
        bytes.extend(f.code.to_ne_bytes());
        bytes.extend([f.jt, f.jf]);
        bytes.extend(f.k.to_ne_bytes());
    }
    // The program is far smaller than a pipe's buffer, so this doesn't block.
    let (read, write) = nix::unistd::pipe2(nix::fcntl::OFlag::O_CLOEXEC).map_err(io::Error::from)?;
    std::fs::File::from(write).write_all(&bytes)?;
    c.fd_mappings(vec![FdMapping { parent_fd: read, child_fd: SECCOMP_FD }]).map_err(|e| bad(&format!("{e:?}")))?;
    c.arg("--seccomp").arg(SECCOMP_FD.to_string());
    Ok(())
}

/// On x86-64, a syscall number with the x32 bit set passes the filter's
/// architecture check but matches none of its rules (they name native
/// numbers). Refusing every such syscall first closes that way around them;
/// strive runs no x32 programs.
#[cfg(target_os = "linux")]
fn refuse_x32(program: &mut seccompiler::BpfProgram) {
    if cfg!(target_arch = "x86_64") {
        use seccompiler::sock_filter;
        const LOAD_NR: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS, seccomp_data.nr at offset 0
        const JUMP_IF_SET: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
        const RETURN: u16 = 0x06; // BPF_RET | BPF_K
        const X32_BIT: u32 = 0x4000_0000;
        const ERRNO: u32 = 0x0005_0000; // SECCOMP_RET_ERRNO
        let prefix = [
            sock_filter { code: LOAD_NR, jt: 0, jf: 0, k: 0 },
            sock_filter { code: JUMP_IF_SET, jt: 0, jf: 1, k: X32_BIT },
            sock_filter { code: RETURN, jt: 0, jf: 0, k: ERRNO | libc::EPERM.unsigned_abs() },
        ];
        program.splice(0..0, prefix);
    }
}

#[cfg(not(target_os = "linux"))]
#[expect(clippy::unnecessary_wraps, reason = "the same signature as the Linux version")]
fn give_seccomp_filter(_: &mut Command) -> io::Result<()> {
    Ok(())
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

fn bash(scope: &Scope, command: &str, timeout_ms: u64, sandboxed: bool, cancelled: &AtomicBool) -> Result {
    // Without a sandbox the gate always asks, so reaching here unconfined
    // means a person approved exactly that.
    let mut cmd = if sandboxed {
        match sandboxed_command(scope, command) {
            Ok(c) => c,
            // Never fall back to running it unconfined: that wasn't approved.
            Err(e) => return Result::Refused(format!("the sandbox couldn't be set up: {e}")),
        }
    } else {
        let mut c = Command::new("/bin/bash");
        c.args(["-c", command]);
        c
    };
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
    if let Some(own) = &scope.temp {
        cmd.env("TMPDIR", own);
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
    // A fork under way at the kill can finish after the group's members were
    // counted; the new child is still in the group, so kill the group again.
    if !matches!(ended, Ended::Exited(_)) {
        let _ = nix::sys::signal::killpg(nix::unistd::Pid::from_raw(root), nix::sys::signal::Signal::SIGKILL);
    }
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
