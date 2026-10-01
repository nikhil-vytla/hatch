//! Effects: what the daemon does to the machine on the agent's behalf.
//!
//! Every path is resolved against the session's directory and checked
//! against one policy: strive's own state is never readable or writable,
//! writes outside the workspace need approval, and so does every write to a
//! guarded file, whatever the mode: what shapes later sessions (the loader's
//! list, `context::SHAPING`, and what its instruction files import) and what
//! runs code outside the sandbox later (`RUNS_CODE`). A person may allow
//! changes to one instruction file (or import) for the rest of a session.
//! Commands run in the OS sandbox (Seatbelt on macOS, bubblewrap on Linux):
//! writes are confined to the workspace and temp directories, minus the
//! guarded files, strive's state is hidden, and the network is off. Where
//! no sandbox is available, every command asks first, and runs unconfined
//! only if a person allows it.

use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read};
use std::os::unix::process::CommandExt;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use strive_proto::{ApprovalMode, EffectRequest};

use crate::context::Shapes;

/// Where an effect runs.
pub struct Scope {
    /// The session's directory, canonical.
    pub workspace: PathBuf,
    /// strive's home, canonical: never readable or writable by an effect.
    pub strive_home: PathBuf,
    /// Settings chose to run commands unconfined (in a disposable container).
    pub unconfined: bool,
    /// What the project's instruction files import (`context::imports`).
    pub imports: Vec<crate::context::Import>,
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
    /// A guarded file: only a person may approve a change, whatever the
    /// approval mode.
    Guarded(PathBuf, Guard),
    Denied(String),
}

/// Why a file is guarded.
enum Guard {
    Shapes(Shapes),
    /// Imported by this instruction file.
    Imported(String),
    RunsCode,
}

/// Whether an effect may run now, must be asked about, or is refused.
pub enum Gate {
    Allow,
    /// Needs a person's approval; the text describes the effect for them.
    /// With a file, allowing it for the session allows later changes to
    /// that file alone (an instruction file, or one an instruction file
    /// imports), not everything.
    Ask(String, Option<PathBuf>),
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

/// `allowed` are the files a person allowed changes to for the session.
pub fn gate(scope: &Scope, request: &EffectRequest, mode: ApprovalMode, allowed: &[PathBuf]) -> (Gate, Target) {
    let change = |verb: &str, path: &str| match resolve(scope, path, true) {
        Access::Denied(why) => (Gate::Deny(why), NOTHING),
        Access::Ask(real) => (Gate::Ask(format!("{verb} outside the workspace: {}", real.display()), None), file(real)),
        Access::Guarded(real, guard) => {
            let per_file = matches!(guard, Guard::Shapes(Shapes::Instructions) | Guard::Imported(_));
            if per_file && allowed.contains(&real) {
                return (Gate::Allow, file(real));
            }
            let in_project = real.strip_prefix(&scope.workspace).unwrap_or(&real).display().to_string();
            let shown = if Path::new(path) == Path::new(&in_project) {
                in_project
            } else {
                format!("{path}, which is {in_project}")
            };
            let told = "this changes what every future session in this project is told";
            let why = match guard {
                Guard::Shapes(Shapes::Learned) => format!(
                    "{told}, without review; `strive learn` proposes such changes and `strive review` is where a \
                     person accepts them"
                ),
                Guard::Shapes(Shapes::Instructions | Shapes::Skills) => told.to_string(),
                Guard::Imported(by) => format!("it's imported by {by}, so {told}"),
                Guard::Shapes(Shapes::Settings) => {
                    "this changes strive's settings for every future session in this project".to_string()
                }
                Guard::RunsCode => "files like this run code outside strive's sandbox later (git runs hooks and \
                                    reads its config, shells read rc files, editors run tasks, other agents run \
                                    their hooks and MCP servers), so only a person can approve it"
                    .to_string(),
            };
            (Gate::Ask(format!("{verb} {shown}: {why}"), per_file.then(|| real.clone())), file(real))
        }
        Access::Allowed(real) if mode == ApprovalMode::Ask => (Gate::Ask(format!("{verb} {path}"), None), file(real)),
        Access::Allowed(real) => (Gate::Allow, file(real)),
    };
    match request {
        EffectRequest::Read { path, .. } => match resolve(scope, path, false) {
            Access::Denied(why) => (Gate::Deny(why), NOTHING),
            Access::Allowed(real) | Access::Ask(real) | Access::Guarded(real, _) => (Gate::Allow, file(real)),
        },
        EffectRequest::Write { path, .. } => change("write", path),
        EffectRequest::Edit { path, .. } => change("edit", path),
        // A server can do anything its tool does, so only full-auto skips asking.
        EffectRequest::Mcp { server, tool, .. } => {
            let gate = if mode == ApprovalMode::FullAuto {
                Gate::Allow
            } else {
                Gate::Ask(format!("use {server}'s {tool} tool"), None)
            };
            (gate, NOTHING)
        }
        EffectRequest::Bash { command, .. } => {
            let sandboxed = !scope.unconfined && sandbox_available();
            let gate = if !sandboxed && !scope.unconfined {
                Gate::Ask(format!("run without a sandbox: {command}"), None)
            } else if mode == ApprovalMode::FullAuto {
                Gate::Allow
            } else {
                Gate::Ask(format!("run: {command}"), None)
            };
            (gate, Target { path: None, sandboxed })
        }
        // `effect/run` reads a check's file and runs its command as bash,
        // through `check_gate`; a check that reaches here wasn't read.
        EffectRequest::Check { name } => (Gate::Deny(format!("the check {name} wasn't read from its file")), NOTHING),
    }
}

/// The gate for a check's command (ADR-0023). One a person accepted in this
/// exact form (`accepted`: an applied proposal's content, or content a
/// person allowed before) runs in the sandbox in every mode; one no one has
/// asks, as does any without a sandbox. Allowing it for the session allows
/// its file (`path`), never full-auto.
pub fn check_gate(scope: &Scope, name: &str, command: &str, accepted: bool, path: &Path) -> (Gate, Target) {
    let sandboxed = !scope.unconfined && sandbox_available();
    let file = Some(path.to_path_buf());
    let gate = if !sandboxed && !scope.unconfined {
        Gate::Ask(format!("run the check {name} without a sandbox: {command}"), file)
    } else if !accepted {
        Gate::Ask(format!("run the check {name}, which no one has accepted in this form yet: {command}"), file)
    } else {
        Gate::Allow
    };
    (gate, Target { path: None, sandboxed })
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
        EffectRequest::Check { name } => Result::Refused(format!("the check {name} wasn't read from its file")),
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
    if writing && let Some(guard) = guarded(scope, &real) {
        return Access::Guarded(real, guard);
    }
    if writing && !real.starts_with(&scope.workspace) {
        return Access::Ask(real);
    }
    Access::Allowed(real)
}

/// Files that run code outside the sandbox when the person, not strive,
/// next uses them, by last components, anywhere in the project (nested
/// repositories too): shells read rc files, git reads `.gitmodules`, runs
/// `.git/hooks` and reads `.git/config` (`core.fsmonitor`, aliases),
/// ripgrep reads its config, Claude Code `.mcp.json`, editors run `.vscode`
/// and `.idea` tasks, and Claude Code runs `.claude` commands and agents.
/// The rest of `.git` stays writable, so git works in the sandbox. After
/// sandbox-runtime's list, plus paths that other agents' and tools' own
/// incidents proved: Claude Code's project settings and hooks
/// (CVE-2025-59536), Codex's `.codex` and `.agents` config and MCP servers
/// (CVE-2025-61260), Cursor's `.cursor` MCP config and rules (`CurXecute`,
/// `MCPoison`, CVE-2025-59944, which a case variant reached), and Gemini
/// CLI's `.gemini`; direnv's `.envrc`, git hook managers (`.husky`,
/// pre-commit, lefthook), dev containers and npm's `.npmrc` run code too.
const RUNS_CODE: &[&str] = &[
    ".gitconfig",
    ".gitmodules",
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".ripgreprc",
    ".mcp.json",
    ".git/hooks",
    ".git/config",
    ".vscode",
    ".idea",
    ".claude/commands",
    ".claude/agents",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/hooks",
    ".codex",
    ".agents",
    ".gemini",
    ".cursor",
    ".envrc",
    ".husky",
    ".devcontainer",
    ".npmrc",
    ".pre-commit-config.yaml",
    "lefthook.yml",
];

/// Why `real` is guarded, if it is: by its path under the project's root,
/// or as an import, in any case (on a case-insensitive volume `.GIT/HOOKS`
/// is `.git/hooks`). An import that is on a list is guarded as that.
fn guarded(scope: &Scope, real: &Path) -> Option<Guard> {
    use crate::context::{matches, shapes};
    let root = crate::context::project_root(&scope.workspace);
    let lower = |p: &Path| p.to_string_lossy().to_lowercase();
    shapes(&root, real)
        .map(Guard::Shapes)
        .or_else(|| RUNS_CODE.iter().any(|p| matches(&root, real, p)).then_some(Guard::RunsCode))
        .or_else(|| {
            let import = scope.imports.iter().find(|i| lower(&i.path) == lower(real))?;
            Some(Guard::Imported(import.by.clone()))
        })
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

/// Seatbelt rules denying writes to every guarded path anywhere under
/// `root`, matched as `guarded` matches them. The directory holding a listed
/// one (`.strive`, `.claude`) is denied itself too, so a command can't make
/// one elsewhere and move it into place, or move it aside; its other files
/// stay writable. `.git` isn't, so git can still make repositories.
fn guarded_rules(root: &str) -> String {
    let root = regex_escape(root);
    let mut rules = String::new();
    let shaping = crate::context::SHAPING.iter().map(|(p, _)| *p);
    for pattern in shaping.clone().chain(RUNS_CODE.iter().copied()) {
        let path: Vec<String> = pattern.split('/').map(any_case).collect();
        let _ = write!(rules, "\n  (regex #\"^{root}(/.*)?/{}(/.*)?$\")", path.join("/"));
    }
    let mut holders: Vec<&str> = shaping.filter_map(|p| p.rsplit_once('/').map(|(dir, _)| dir)).collect();
    holders.sort_unstable();
    holders.dedup();
    for dir in holders {
        let path: Vec<String> = dir.split('/').map(any_case).collect();
        let _ = write!(rules, "\n  (regex #\"^{root}(/.*)?/{}$\")", path.join("/"));
    }
    rules
}

/// Seatbelt rules denying writes to each import, in any case, and to each
/// directory between it and `root` itself (not what else they hold), so
/// none can be moved aside, made elsewhere and moved into place, or swapped
/// for a symlink. A path the profile can't hold refuses the command.
fn import_rules(root: &Path, imports: &[crate::context::Import]) -> io::Result<String> {
    let mut paths = std::collections::BTreeSet::new();
    for i in imports {
        paths.extend(i.path.ancestors().take_while(|a| a.starts_with(root) && *a != root));
    }
    let mut rules = String::new();
    for p in paths {
        let Ok(inside) = p.strip_prefix(root) else { continue };
        let inside = inside.to_string_lossy();
        if inside.chars().any(|c| c == '"' || c == '\\' || c.is_control()) {
            return Err(io::Error::other(format!(
                "an instruction file imports {}, whose path the macOS sandbox profile can't hold safely",
                p.display()
            )));
        }
        let _ = write!(rules, "\n  (regex #\"^{}/{}$\")", regex_escape(&root.to_string_lossy()), any_case(&inside));
    }
    Ok(rules)
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
    if cfg!(target_os = "macos") {
        // The paths go into the profile's string literals: one that would
        // need escaping could end a literal and add rules of its own. The
        // guarded paths add only fixed ASCII to the project root's, which
        // the workspace's path starts with.
        let unsafe_in_profile = |p: &Path| p.to_string_lossy().chars().any(|c| c == '"' || c == '\\' || c.is_control());
        for p in [&scope.workspace, &scope.strive_home] {
            if unsafe_in_profile(p) {
                return Err(io::Error::other(format!(
                    "{} has a quote, backslash or control character in its path, which the macOS sandbox profile can't hold safely",
                    p.display()
                )));
            }
        }
        // Commands may write /private/tmp, the user's own temp directory,
        // which macOS's tools use whatever TMPDIR says (`mktemp` does), and
        // the daemon's TMPDIR. That one is the person's to set: if the
        // profile can't hold it, it's left out, not refused, and commands are
        // pointed elsewhere.
        let user_tmp = user_temp_dir().filter(|t| !unsafe_in_profile(t));
        let daemon_tmp = std::env::temp_dir().canonicalize().ok().filter(|t| !unsafe_in_profile(t));
        let tmp = daemon_tmp.clone().or_else(|| user_tmp.clone()).unwrap_or_else(|| PathBuf::from("/private/tmp"));
        let mut temps = String::from(" (subpath \"/private/tmp\")");
        for t in daemon_tmp.iter().chain(&user_tmp) {
            let _ = write!(temps, " (subpath \"{}\")", t.display());
        }
        // Anchored at the project's root, not the workspace: the loader reads
        // instruction files above the workspace too, and those can be in a
        // temp directory commands may write.
        let root = crate::context::project_root(&scope.workspace);
        let mut guarded = guarded_rules(&root.to_string_lossy());
        guarded.push_str(&import_rules(&root, &scope.imports)?);
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
(deny file-write*{guarded})
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
    // The guarded files and directories in the workspace itself, where they
    // exist: a bind needs something to bind, so a command can still create a
    // missing one, or change a nested one (see ARCHITECTURE). Above the
    // workspace everything is read-only already.
    let shaping = crate::context::SHAPING.iter().map(|(p, _)| *p);
    for p in shaping.chain(RUNS_CODE.iter().copied()) {
        let p = scope.workspace.join(p);
        c.args(["--ro-bind-try"]).arg(&p).arg(&p);
    }
    for i in &scope.imports {
        c.args(["--ro-bind-try"]).arg(&i.path).arg(&i.path);
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
        // Recorded with the command its file held, once `effect/run` reads it.
        EffectRequest::Check { name } => {
            return Err(io::Error::other(format!("the check {name} must be read from its file before it's recorded")));
        }
    })
}
