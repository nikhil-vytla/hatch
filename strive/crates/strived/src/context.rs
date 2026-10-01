//! Project context for the agent: instruction files and skills.
//!
//! Instructions come from `AGENTS.md` (or `CLAUDE.md` where a directory has
//! no `AGENTS.md`) in each directory from the repository root down to the
//! workspace, after a global `~/.strive/AGENTS.md`. Outside a repository
//! only the workspace itself is read. A line `@path` inlines that file once
//! if its real path is in the project; a cycle, a path outside the project,
//! or one more than five imports deep stays as text.
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
//! and the sandbox guard (`effects`), or imported by a file on it, which
//! they guard too ([`imports`]). Any other file is read only if its real
//! path is on the list, so a symlink that leads elsewhere is skipped: an
//! edit there would change what sessions are told, with no one asked.

use std::fs;
use std::path::{Path, PathBuf};

use strive_proto::{Artifact, CheckInfo, CommandInfo, InstructionFile, SkillInfo};

const FILE_LIMIT: usize = 64 * 1024;
const TOTAL_LIMIT: usize = 128 * 1024;
const IMPORT_DEPTH: usize = 5;

/// Instruction file names; in a directory with both, the first wins.
const INSTRUCTION_FILES: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];
const CLAUDE_SKILLS: &str = ".claude/skills";
const CLAUDE_COMMANDS: &str = ".claude/commands";
const CLAUDE_RULES: &str = ".claude/rules";

/// What changing a file on the list does, for the person asked about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shapes {
    /// Every session is told what it says; a person may allow changes to
    /// one for the rest of a session.
    Instructions,
    /// Every session is offered them.
    Skills,
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
pub const SHAPING: [(&str, Shapes); 11] = [
    (INSTRUCTION_FILES[0], Shapes::Instructions),
    (INSTRUCTION_FILES[1], Shapes::Instructions),
    (CLAUDE_SKILLS, Shapes::Skills),
    (CLAUDE_COMMANDS, Shapes::Skills),
    (CLAUDE_RULES, Shapes::Skills),
    (strive_learning::COMMANDS_DIR, Shapes::Learned),
    (strive_learning::RULES_DIR, Shapes::Learned),
    (strive_learning::MEMORY_PATH, Shapes::Learned),
    (strive_learning::SKILLS_DIR, Shapes::Learned),
    (strive_learning::CHECKS_DIR, Shapes::Learned),
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
    pub checks: Vec<CheckInfo>,
    /// Imports not loaded, each a line for a person saying which and why.
    pub skipped: Vec<String>,
}

/// What reading the instruction files found besides their text.
#[derive(Default)]
struct Found {
    imports: Vec<Import>,
    skipped: Vec<String>,
}

/// A path in the project an instruction file imports, whether or not it
/// was inlined: guarded as the instruction file is, since what is there
/// (or is put there) is told to later sessions.
pub struct Import {
    pub path: PathBuf,
    /// The importing file, as shown to a person.
    pub by: String,
}

/// The project's root and strive's home, canonical: what a real path is
/// checked against.
struct Anchors {
    root: PathBuf,
    home: PathBuf,
}

impl Anchors {
    fn new(workspace: &Path, strive_home: &Path) -> Self {
        let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
        Self { root: canonical(&project_root(workspace)), home: canonical(strive_home) }
    }

    /// Whether the loader may read `real`: on the list under the project's
    /// root, or strive home's `AGENTS.md`, skills or commands.
    fn listed(&self, real: &Path) -> bool {
        if real.starts_with(&self.home) {
            return real == self.home.join("AGENTS.md")
                || real.starts_with(self.home.join("skills"))
                || real.starts_with(self.home.join("commands"));
        }
        shapes(&self.root, real).is_some()
    }

    /// Whether an import of `path` stays in what the gate and the sandbox
    /// guard: the project, minus strive's home.
    fn inside(&self, path: &Path) -> bool {
        path.starts_with(&self.root) && path != self.root && (!path.starts_with(&self.home) || self.listed(path))
    }

    fn shown(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap_or(path).display().to_string()
    }
}

pub fn load(workspace: &Path, strive_home: &Path) -> Context {
    let at = Anchors::new(workspace, strive_home);
    let mut found = Found::default();
    let instructions = instructions(workspace, strive_home, &at, &mut found);
    let skills = skills(workspace, strive_home, &at);
    let checks = checks(workspace, &at, &mut found.skipped);
    Context { instructions, skills, checks, skipped: found.skipped }
}

/// The project's checks (ADR-0023): each `.strive/checks/<name>.md` that
/// reads as a check named for its file. One that doesn't is noted in
/// `skipped` with why, so a person who wrote it finds out.
fn checks(workspace: &Path, at: &Anchors, skipped: &mut Vec<String>) -> Vec<CheckInfo> {
    let Ok(entries) = fs::read_dir(workspace.join(strive_learning::CHECKS_DIR)) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".md")).map(str::to_string))
        .collect();
    names.sort();
    let mut out = Vec::new();
    for name in names {
        match check_at(workspace, at, &name) {
            Ok((c, _)) => out.push(CheckInfo { name: c.name, description: c.description, paths: c.paths }),
            Err(why) => skipped.push(format!("{}/{name}.md was not loaded: {why}", strive_learning::CHECKS_DIR)),
        }
    }
    out
}

/// The slash commands a session can run (ADR-0024), each with the prompt it
/// stands for: `.strive/commands` (reached without a symlink, and read as
/// strictly as the static gate reads a proposed one), then `.claude/commands`
/// and `~/.strive/commands`. The first of a name wins.
pub fn commands(workspace: &Path, strive_home: &Path) -> Vec<(CommandInfo, String)> {
    let at = Anchors::new(workspace, strive_home);
    let learned = workspace.join(strive_learning::COMMANDS_DIR);
    let mut found: Vec<(CommandInfo, String)> = Vec::new();
    for root in [learned.clone(), workspace.join(CLAUDE_COMMANDS), strive_home.join("commands")] {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        let mut names: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".md")).map(str::to_string))
            .filter(|n| strive_learning::valid_skill_name(n))
            .collect();
        names.sort();
        for name in names {
            if found.iter().any(|(c, _)| c.name == name) {
                continue;
            }
            let file = root.join(format!("{name}.md"));
            let real = if root == learned {
                really_at(workspace, &Path::new(strive_learning::COMMANDS_DIR).join(format!("{name}.md")))
            } else {
                file.canonicalize().ok()
            };
            let Some(text) = real.filter(|r| at.listed(r)).and_then(|r| read_whole(&r, strive_learning::COMMAND_LIMIT))
            else {
                continue;
            };
            let Ok(c) = strive_learning::command_file::parse(&text, root == learned) else { continue };
            let info = CommandInfo {
                name,
                description: c.description,
                argument_hint: c.argument_hint,
                path: file.display().to_string(),
            };
            found.push((info, c.body));
        }
    }
    found
}

/// A check as its file says now, and the file's text.
type Check = (strive_learning::check_file::CheckFile, String);

/// The check `name` as its file says now, for the daemon to run.
pub fn check(workspace: &Path, strive_home: &Path, name: &str) -> Result<Check, String> {
    check_at(workspace, &Anchors::new(workspace, strive_home), name)
}

fn check_at(workspace: &Path, at: &Anchors, name: &str) -> Result<Check, String> {
    let artifact = Artifact::Check { name: name.to_string() };
    let relative = strive_learning::relative_path(&artifact)?;
    // Reviewed as learned files are, so reached without a symlink.
    let real = really_at(workspace, Path::new(&relative))
        .filter(|r| at.listed(r))
        .ok_or_else(|| "it isn't a file in the project reached without a symlink".to_string())?;
    let text = read_whole(&real, strive_learning::CHECK_LIMIT).ok_or_else(|| {
        format!("it isn't a regular UTF-8 file of at most {} KiB", strive_learning::CHECK_LIMIT / 1024)
    })?;
    let c = strive_learning::check_file::parse(&text).map_err(|p| p.join("; "))?;
    if c.name != name {
        return Err(format!("its frontmatter names it {:?}", c.name));
    }
    Ok((c, text))
}

/// What the project's instruction files import, as `load` finds it. Only
/// guarded files import, so this changes only as a person allows.
pub fn imports(workspace: &Path, strive_home: &Path) -> Vec<Import> {
    let mut found = Found::default();
    instructions(workspace, strive_home, &Anchors::new(workspace, strive_home), &mut found);
    found.imports
}

fn instructions(workspace: &Path, strive_home: &Path, at: &Anchors, found: &mut Found) -> Vec<InstructionFile> {
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
        let Some(real) = path.canonicalize().ok().filter(|r| at.listed(r)) else { continue };
        let Some(mut text) = expand(&real, at, &mut Vec::new(), found) else { continue };
        if text.len() > FILE_LIMIT {
            text = format!("{}\n[... cut at {} KiB]", truncate(&text, FILE_LIMIT), FILE_LIMIT / 1024);
        }
        if total + text.len() > TOTAL_LIMIT {
            break;
        }
        total += text.len();
        out.push(InstructionFile { path: path.display().to_string(), text });
    }
    // Rules without paths are for every session, after the instruction files.
    for rule in rules_at(workspace, at).into_iter().filter(|r| r.paths.is_empty()) {
        if total + rule.body.len() > TOTAL_LIMIT {
            break;
        }
        total += rule.body.len();
        out.push(InstructionFile { path: rule.file.display().to_string(), text: rule.body });
    }
    if let Some(memory) = memory(workspace, at).filter(|m| total + m.text.len() <= TOTAL_LIMIT) {
        out.push(memory);
    }
    out
}

/// A rule as loaded (ADR-0025).
pub struct Rule {
    pub name: String,
    /// Its file, as the agent is told it.
    pub file: PathBuf,
    /// Globs relative to the workspace; empty for every session.
    pub paths: Vec<String>,
    pub body: String,
}

/// The project's rules: `.strive/rules` (reached without a symlink, and read
/// strictly), then `.claude/rules` (read leniently). The first of a name wins.
pub fn rules(workspace: &Path, strive_home: &Path) -> Vec<Rule> {
    rules_at(workspace, &Anchors::new(workspace, strive_home))
}

fn rules_at(workspace: &Path, at: &Anchors) -> Vec<Rule> {
    let learned = workspace.join(strive_learning::RULES_DIR);
    let mut found: Vec<Rule> = Vec::new();
    for root in [learned.clone(), workspace.join(CLAUDE_RULES)] {
        for name in md_names(&root) {
            if found.iter().any(|r| r.name == name) {
                continue;
            }
            let file = root.join(format!("{name}.md"));
            let real = if root == learned {
                really_at(workspace, &Path::new(strive_learning::RULES_DIR).join(format!("{name}.md")))
            } else {
                file.canonicalize().ok()
            };
            let Some(text) = real.filter(|r| at.listed(r)).and_then(|r| read_whole(&r, strive_learning::RULE_LIMIT))
            else {
                continue;
            };
            let Ok(r) = strive_learning::rule_file::parse(&text, root == learned) else { continue };
            found.push(Rule { name, file, paths: r.paths, body: r.body });
        }
    }
    found
}

/// The names of the `.md` files in `dir` that name a command, check or
/// rule (1 to 40 of `a-z`, `0-9` and `-`), sorted.
fn md_names(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".md")).map(str::to_string))
        .filter(|n| strive_learning::valid_skill_name(n))
        .collect();
    names.sort();
    names
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
    // A bullet's source comment is for review and the learner, not the
    // agent: it costs tokens and says nothing a session acts on.
    let mut text = strive_learning::memory::parse(&read_regular(&real)?).for_sessions();
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
    artifacts.extend(
        md_names(&workspace.join(strive_learning::COMMANDS_DIR)).into_iter().map(|name| Artifact::Command { name }),
    );
    artifacts.extend(
        md_names(&workspace.join(strive_learning::CHECKS_DIR)).into_iter().map(|name| Artifact::Check { name }),
    );
    artifacts
        .extend(md_names(&workspace.join(strive_learning::RULES_DIR)).into_iter().map(|name| Artifact::Rule { name }));
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

/// An instruction file's text (`real` is its canonical path) with each
/// line `@path` outside a code block inlined, if its real path is a file in
/// the project, at most `IMPORT_DEPTH` deep and not a cycle. Every import in
/// the project, inlined or not, joins `found`: the gate and the sandbox
/// guard it, so a file put there later is still one a person allowed. One
/// not inlined, but for a cycle, is noted there with why.
fn expand(real: &Path, at: &Anchors, stack: &mut Vec<PathBuf>, found: &mut Found) -> Option<String> {
    let text = read_regular(real)?;
    let deep = stack.len() >= IMPORT_DEPTH;
    stack.push(real.to_path_buf());
    let dir = real.parent().unwrap_or(Path::new("/")).to_path_buf();
    let by = at.shown(real);
    let mut fenced = false;
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
                fenced = !fenced;
            }
            let Some(target) = trimmed
                .strip_prefix('@')
                .filter(|t| !fenced && !t.is_empty() && !t.contains(char::is_whitespace))
                .map(Path::new)
            else {
                return line.to_string();
            };
            let written = lexical(&if target.is_absolute() { target.to_path_buf() } else { dir.join(target) });
            // Where it is now, and where a file would be made: both guarded.
            let paths = [crate::effects::real_path(&written), Some(written.clone())];
            for path in paths.into_iter().flatten().filter(|p| at.inside(p)) {
                if !found.imports.iter().any(|i| i.path == path) {
                    found.imports.push(Import { path, by: by.clone() });
                }
            }
            let why = match target_of(&dir.join(target), at) {
                // A cycle is the same text twice, not a lost import.
                Ok(r) if stack.contains(&r) => return line.to_string(),
                Ok(_) if deep => format!("it's more than {IMPORT_DEPTH} imports deep"),
                Ok(r) => {
                    return expand(&r, at, stack, found).map_or_else(|| line.to_string(), |t| t.trim_end().to_string());
                }
                Err(Skip::Outside) if at.inside(&written) => "it links outside the project".to_string(),
                Err(Skip::Outside) => "it's outside the project".to_string(),
                Err(Skip::Missing) => "there's no such file".to_string(),
                Err(Skip::NotAFile) => "it isn't a file".to_string(),
            };
            let notice = format!("@{} in {by} was not loaded: {why}", target.display());
            if !found.skipped.contains(&notice) {
                found.skipped.push(notice);
            }
            line.to_string()
        })
        .collect();
    stack.pop();
    Some(lines.join("\n"))
}

/// Why an import isn't inlined.
enum Skip {
    Outside,
    Missing,
    NotAFile,
}

/// The real path of the file `path` imports, if it may be inlined.
fn target_of(path: &Path, at: &Anchors) -> Result<PathBuf, Skip> {
    let real = path.canonicalize().map_err(|_| Skip::Missing)?;
    if !at.inside(&real) {
        return Err(Skip::Outside);
    }
    if !real.is_file() {
        return Err(Skip::NotAFile);
    }
    Ok(real)
}

/// `p` with `.` and `..` resolved by name alone.
fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
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
