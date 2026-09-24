//! Project context for the agent: instruction files and skills.
//!
//! Instructions come from `AGENTS.md` (or `CLAUDE.md` where a directory has
//! no `AGENTS.md`) in each directory from the repository root down to the
//! workspace, after a global `~/.strive/AGENTS.md`. Outside a repository
//! only the workspace itself is read. A line `@path` inlines that file once;
//! a cycle, or anything inside strive's home, stays as text.
//!
//! Skills are folders with a `SKILL.md` whose frontmatter names and
//! describes them, found in the workspace's `.strive/skills` and
//! `.claude/skills` and in `~/.strive/skills`. The agent is given the list
//! and reads a skill's file when it applies.
//!
//! Last comes the project's learned memory, `.strive/memory.md`, labeled as
//! reviewed: it changes only when a person accepts a learner's proposal.

use std::fs;
use std::path::{Path, PathBuf};

use strive_proto::{Artifact, InstructionFile, SkillInfo};

const FILE_LIMIT: usize = 64 * 1024;
const TOTAL_LIMIT: usize = 128 * 1024;
const IMPORT_DEPTH: usize = 5;

pub struct Context {
    pub instructions: Vec<InstructionFile>,
    pub skills: Vec<SkillInfo>,
}

pub fn load(workspace: &Path, strive_home: &Path) -> Context {
    Context { instructions: instructions(workspace, strive_home), skills: skills(workspace, strive_home) }
}

fn repo_root(workspace: &Path) -> Option<PathBuf> {
    workspace.ancestors().find(|d| d.join(".git").exists()).map(Path::to_path_buf)
}

fn instructions(workspace: &Path, strive_home: &Path) -> Vec<InstructionFile> {
    let mut files: Vec<PathBuf> = Vec::new();
    let global = strive_home.join("AGENTS.md");
    if global.is_file() {
        files.push(global);
    }
    let dirs: Vec<PathBuf> = match repo_root(workspace) {
        Some(root) => {
            let mut d: Vec<PathBuf> =
                workspace.ancestors().take_while(|a| a.starts_with(&root)).map(Path::to_path_buf).collect();
            d.reverse();
            d
        }
        None => vec![workspace.to_path_buf()],
    };
    for dir in dirs {
        if let Some(f) = ["AGENTS.md", "CLAUDE.md"].iter().map(|n| dir.join(n)).find(|p| p.is_file()) {
            files.push(f);
        }
    }
    let mut total = 0;
    let mut out = Vec::new();
    for path in files {
        let mut stack = Vec::new();
        let Some(mut text) = expand(&path, strive_home, &mut stack) else { continue };
        if text.len() > FILE_LIMIT {
            text = format!("{}\n[... cut at {} KiB]", truncate(&text, FILE_LIMIT), FILE_LIMIT / 1024);
        }
        if total + text.len() > TOTAL_LIMIT {
            break;
        }
        total += text.len();
        out.push(InstructionFile { path: path.display().to_string(), text });
    }
    if let Some(memory) = memory(workspace, strive_home).filter(|m| total + m.text.len() <= TOTAL_LIMIT) {
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
fn memory(workspace: &Path, strive_home: &Path) -> Option<InstructionFile> {
    let path = workspace.join(strive_learning::MEMORY_PATH);
    let real = path.canonicalize().ok()?;
    if !allowed(&real, strive_home) {
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

/// Whether a file's real path is one the agent may be given: nothing of
/// strive's own state (keys, credentials, journals) but the global
/// instructions and skills, however the path leads there.
fn allowed(real: &Path, strive_home: &Path) -> bool {
    let home = strive_home.canonicalize().unwrap_or_else(|_| strive_home.to_path_buf());
    !real.starts_with(&home) || real == home.join("AGENTS.md") || real.starts_with(home.join("skills"))
}

/// A file's text with its `@path` lines inlined.
fn expand(path: &Path, strive_home: &Path, stack: &mut Vec<PathBuf>) -> Option<String> {
    let real = path.canonicalize().ok()?;
    if !allowed(&real, strive_home) {
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
                Ok(r) if !stack.contains(&r) && !r.starts_with(strive_home) && r.is_file() => {
                    expand(&r, strive_home, stack).map_or_else(|| line.to_string(), |t| t.trim_end().to_string())
                }
                _ => line.to_string(),
            }
        })
        .collect();
    stack.pop();
    Some(lines.join("\n"))
}

fn skills(workspace: &Path, strive_home: &Path) -> Vec<SkillInfo> {
    let mut found: Vec<SkillInfo> = Vec::new();
    for root in [workspace.join(".strive/skills"), workspace.join(".claude/skills"), strive_home.join("skills")] {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let file = dir.join("SKILL.md");
            let readable = file.canonicalize().ok().filter(|real| allowed(real, strive_home));
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
