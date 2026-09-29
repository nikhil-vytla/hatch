//! Project context for the agent: instruction files and skills.
//!
//! Instructions come from `AGENTS.md` (or `CLAUDE.md` where a directory has
//! no `AGENTS.md`) in each directory from the repository root down to the
//! workspace, after a global `~/.strive/AGENTS.md`. Outside a repository
//! only the workspace itself is read. A line `@path` inlines that file once;
//! a cycle, or a file not on the list below, stays as text.
//!
//! Skills are folders with a `SKILL.md` whose frontmatter names and
//! describes them, found in the workspace's `.strive/skills` and
//! `.claude/skills` and in `~/.strive/skills`. The agent is given the list
//! and reads a skill's file when it applies.
//!
//! Last comes the project's learned memory, `.strive/memory.md`, labeled as
//! reviewed: it changes only when a person accepts a learner's proposal.
//!
//! Everything read here is on one list, [`SHAPING`], which the approval gate
//! and the sandbox guard (`effects`). A file is read only if its real path
//! is on it, so a symlink or an import that leads elsewhere is skipped: an
//! edit there would change what sessions are told, with no one asked.

use std::fs;
use std::path::{Path, PathBuf};

use strive_proto::{Artifact, InstructionFile, SkillInfo};

const FILE_LIMIT: usize = 64 * 1024;
const TOTAL_LIMIT: usize = 128 * 1024;
const IMPORT_DEPTH: usize = 5;

/// Instruction file names; in a directory with both, the first wins.
const INSTRUCTION_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
const CLAUDE_SKILLS: &str = ".claude/skills";

/// What changing a file on the list does, for the person asked about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shapes {
    /// Every session is told what it says.
    Instructions,
    /// Told too, and changed through review (ADR-0016).
    Learned,
    /// How strive runs sessions in the project.
    Settings,
}

/// Every file or directory in a project that shapes the sessions started
/// there: what the loader gives them, and the project's settings. Named by
/// last components, at any depth under the project's root, since a session
/// may start in any of its directories. Nothing else in a project is loaded.
/// strive's home adds only its `AGENTS.md` and `skills`, and the agent can't
/// write anything there.
pub const SHAPING: [(&str, Shapes); 6] = [
    (INSTRUCTION_FILES[0], Shapes::Instructions),
    (INSTRUCTION_FILES[1], Shapes::Instructions),
    (CLAUDE_SKILLS, Shapes::Instructions),
    (strive_learning::MEMORY_PATH, Shapes::Learned),
    (strive_learning::SKILLS_DIR, Shapes::Learned),
    (crate::settings::PROJECT_SETTINGS, Shapes::Settings),
];

/// Where the list is anchored: the repository's root, or the workspace
/// outside one.
pub fn project_root(workspace: &Path) -> PathBuf {
    workspace.ancestors().find(|d| d.join(".git").exists()).unwrap_or(workspace).to_path_buf()
}

/// Whether `real`, under `root`, is at or inside `pattern` (components
/// joined by `/`) anywhere below it. Case is ignored: on a case-insensitive
/// volume `.CLAUDE/Skills` is `.claude/skills`.
pub fn matches(root: &Path, real: &Path, pattern: &str) -> bool {
    let Ok(inside) = real.strip_prefix(root) else { return false };
    let parts: Vec<String> = inside.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    let want: Vec<String> = pattern.split('/').map(str::to_lowercase).collect();
    parts.windows(want.len()).any(|w| w == want.as_slice())
}

/// The entry on the list `real` is, if any.
pub fn shapes(root: &Path, real: &Path) -> Option<Shapes> {
    SHAPING.iter().find(|(pattern, _)| matches(root, real, pattern)).map(|(_, s)| *s)
}

pub struct Context {
    pub instructions: Vec<InstructionFile>,
    pub skills: Vec<SkillInfo>,
}

/// The project's root and strive's home, canonical: what a real path is
/// checked against.
struct Anchors {
    root: PathBuf,
    home: PathBuf,
}

impl Anchors {
    /// Whether the loader may read `real`: on the list under the project's
    /// root, or strive home's `AGENTS.md` or skills.
    fn listed(&self, real: &Path) -> bool {
        if real.starts_with(&self.home) {
            return real == self.home.join("AGENTS.md") || real.starts_with(self.home.join("skills"));
        }
        shapes(&self.root, real).is_some()
    }
}

pub fn load(workspace: &Path, strive_home: &Path) -> Context {
    let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let at = Anchors { root: canonical(&project_root(workspace)), home: canonical(strive_home) };
    Context { instructions: instructions(workspace, strive_home, &at), skills: skills(workspace, strive_home, &at) }
}

fn instructions(workspace: &Path, strive_home: &Path, at: &Anchors) -> Vec<InstructionFile> {
    let mut files: Vec<PathBuf> = Vec::new();
    let global = strive_home.join("AGENTS.md");
    if global.is_file() {
        files.push(global);
    }
    let root = project_root(workspace);
    let mut dirs: Vec<&Path> = workspace.ancestors().take_while(|a| a.starts_with(&root)).collect();
    dirs.reverse();
    for dir in dirs {
        if let Some(f) = INSTRUCTION_FILES.iter().map(|n| dir.join(n)).find(|p| p.is_file()) {
            files.push(f);
        }
    }
    let mut total = 0;
    let mut out = Vec::new();
    for path in files {
        let mut stack = Vec::new();
        let Some(mut text) = expand(&path, at, &mut stack) else { continue };
        if text.len() > FILE_LIMIT {
            text = format!("{}\n[... cut at {} KiB]", truncate(&text, FILE_LIMIT), FILE_LIMIT / 1024);
        }
        if total + text.len() > TOTAL_LIMIT {
            break;
        }
        total += text.len();
        out.push(InstructionFile { path: path.display().to_string(), text });
    }
    if let Some(memory) = memory(workspace, at).filter(|m| total + m.text.len() <= TOTAL_LIMIT) {
        out.push(memory);
    }
    out
}

/// How the agent is told what `.strive/memory.md` is.
const MEMORY_LABEL: &str = "Reviewed memory: what strive learned from earlier sessions in this project. \
A person reviewed and accepted each change. Follow it as you follow the instructions above; where the user \
asks otherwise, the user wins.";

/// The project's learned memory, labeled. Its `@` lines stay as text: only
/// what a person reviewed is given, not files it points to.
fn memory(workspace: &Path, at: &Anchors) -> Option<InstructionFile> {
    let path = workspace.join(strive_learning::MEMORY_PATH);
    let real = really_at(workspace, Path::new(strive_learning::MEMORY_PATH))?;
    if !at.listed(&real) {
        return None;
    }
    let mut text = read_regular(&real)?;
    if text.len() > FILE_LIMIT {
        text = format!("{}\n[... cut at {} KiB]", truncate(&text, FILE_LIMIT), FILE_LIMIT / 1024);
    }
    Some(InstructionFile { path: path.display().to_string(), text: format!("{MEMORY_LABEL}\n\n{text}") })
}

/// For the learner: the project's memory and skills, each file whole and
/// exactly as it is, so it can propose a whole new one. Only files a
/// proposal could replace: regular, reached without a symlink, outside
/// strive's home, and small enough to give whole.
pub fn learned(workspace: &Path, strive_home: &Path) -> Vec<(Artifact, String)> {
    let mut artifacts = vec![Artifact::Memory];
    if let Ok(entries) = fs::read_dir(workspace.join(".strive/skills")) {
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|n| strive_learning::valid_skill_name(n))
            .collect();
        names.sort();
        artifacts.extend(names.into_iter().map(|name| Artifact::Skill { name }));
    }
    // None of strive's home, not even its global skills: a proposal can't
    // write there (a project at `~` has it as its `.strive`).
    let home = strive_home.canonicalize().unwrap_or_else(|_| strive_home.to_path_buf());
    let mut total = 0;
    let mut out = Vec::new();
    for artifact in artifacts {
        let Ok(relative) = strive_learning::relative_path(&artifact) else { continue };
        let path = workspace.join(relative);
        let Some(real) = path.canonicalize().ok().filter(|r| *r == path && !r.starts_with(&home)) else { continue };
        let Some(text) = read_whole(&real, FILE_LIMIT) else { continue };
        if total + text.len() > TOTAL_LIMIT {
            break;
        }
        total += text.len();
        out.push((artifact, text));
    }
    out
}

/// A learned file's real path, only if it is really at `relative` in the
/// workspace, reached without a symlink. Learned files are labeled reviewed,
/// so not even a link to another listed file stands in for one.
fn really_at(workspace: &Path, relative: &Path) -> Option<PathBuf> {
    let path = workspace.canonicalize().ok()?.join(relative);
    let real = path.canonicalize().ok()?;
    (real == path).then_some(real)
}

/// A regular file's whole text, if it's UTF-8 and at most `limit` bytes.
fn read_whole(path: &Path, limit: usize) -> Option<String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let f = fs::OpenOptions::new().read(true).custom_flags(nix::fcntl::OFlag::O_NONBLOCK.bits()).open(path).ok()?;
    let meta = f.metadata().ok()?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return None;
    }
    let mut text = String::new();
    // One byte past the limit shows a file that grew since its metadata.
    f.take(limit as u64 + 1).read_to_string(&mut text).ok()?;
    (text.len() <= limit).then_some(text)
}

fn truncate(s: &str, n: usize) -> &str {
    let mut end = n.min(s.len());
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// A regular file's text. Opened without blocking and checked once open, so
/// a FIFO (or a device) put where a file should be is skipped, not waited on.
fn read_regular(path: &Path) -> Option<String> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = fs::OpenOptions::new().read(true).custom_flags(nix::fcntl::OFlag::O_NONBLOCK.bits()).open(path).ok()?;
    if !f.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    f.read_to_string(&mut text).ok()?;
    Some(text)
}

/// A listed file's text with its `@path` lines inlined where they name
/// listed files too.
fn expand(path: &Path, at: &Anchors, stack: &mut Vec<PathBuf>) -> Option<String> {
    let real = path.canonicalize().ok()?;
    if !at.listed(&real) {
        return None;
    }
    let text = read_regular(&real)?;
    if stack.len() >= IMPORT_DEPTH {
        return Some(text);
    }
    stack.push(real.clone());
    let dir = real.parent().unwrap_or(Path::new("/")).to_path_buf();
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let Some(target) =
                line.trim().strip_prefix('@').filter(|t| !t.is_empty() && !t.contains(char::is_whitespace))
            else {
                return line.to_string();
            };
            let target = Path::new(target);
            let resolved = if target.is_absolute() { target.to_path_buf() } else { dir.join(target) };
            match resolved.canonicalize() {
                Ok(r) if !stack.contains(&r) && r.is_file() => {
                    expand(&r, at, stack).map_or_else(|| line.to_string(), |t| t.trim_end().to_string())
                }
                _ => line.to_string(),
            }
        })
        .collect();
    stack.pop();
    Some(lines.join("\n"))
}

fn skills(workspace: &Path, strive_home: &Path, at: &Anchors) -> Vec<SkillInfo> {
    let mut found: Vec<SkillInfo> = Vec::new();
    let learned = workspace.join(strive_learning::SKILLS_DIR);
    for root in [learned.clone(), workspace.join(CLAUDE_SKILLS), strive_home.join("skills")] {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let file = dir.join("SKILL.md");
            let real = if root == learned {
                let Some(name) = dir.file_name() else { continue };
                really_at(workspace, &Path::new(strive_learning::SKILLS_DIR).join(name).join("SKILL.md"))
            } else {
                file.canonicalize().ok()
            };
            let readable = real.filter(|real| at.listed(real));
            let Some((name, description)) =
                readable.and_then(|r| read_regular(&r)).as_deref().and_then(strive_learning::frontmatter)
            else {
                continue;
            };
            if !found.iter().any(|s| s.name == name) {
                found.push(SkillInfo { name, description, path: file.display().to_string() });
            }
        }
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}
