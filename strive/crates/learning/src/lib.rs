//! Trusted learning's pure parts (ADR-0016):
//! - where a proposal's artifact lives in the project;
//! - the static gate's checks of a proposal's own text;
//! - a proposal's status, folded from the learning session's journal;
//! - the judge's rubric, request and strict reading of its answer, and how
//!   a work session is rendered for it;
//! - memory as bullets, and one proposal's operation on one of them;
//! - memory lines that may be stale;
//! - triggers (ADR-0020): the pre-filter's signs in a work journal, and
//!   what the learning journal says about automatic runs.
//!
//! The daemon adds what needs the machine: the path as it resolves on
//! disk, the file's digest, and whether the evidence's sessions exist.

pub mod check_file;
mod checks;
pub mod command_file;
pub mod extension_dir;
mod fold;
pub mod judge;
pub mod memory;
pub mod render;
pub mod rule_file;
pub mod signals;
pub mod stale;
pub mod triggers;
pub mod usage;

pub use checks::{Finding, Rule, check, frontmatter, verdict};
pub use fold::{Applied, Folded, fold};

use strive_proto::{Artifact, Gate, ProposalState, ProposalStatus};

/// Where memory lives, relative to the project.
pub const MEMORY_PATH: &str = ".strive/memory.md";
/// Where skills live, relative to the project: `<name>/SKILL.md` each.
pub const SKILLS_DIR: &str = ".strive/skills";
/// The most a memory file may hold, in bytes.
pub const MEMORY_LIMIT: usize = 16 * 1024;
/// The most a skill's SKILL.md may hold, in bytes.
pub const SKILL_LIMIT: usize = 32 * 1024;
/// The longest skill name, and check name.
pub const SKILL_NAME_LIMIT: usize = 40;
/// Where checks live, relative to the project: `<name>.md` each (ADR-0023).
pub const CHECKS_DIR: &str = ".strive/checks";
/// The most a check's file may hold, in bytes.
pub const CHECK_LIMIT: usize = 4 * 1024;
/// Where slash commands live, relative to the project: `<name>.md` each (ADR-0024).
pub const COMMANDS_DIR: &str = ".strive/commands";
/// The most a command's file may hold, in bytes.
pub const COMMAND_LIMIT: usize = 16 * 1024;
/// Where extensions live, relative to the project: a directory each (ADR-0027).
pub const EXTENSIONS_DIR: &str = ".strive/extensions";
/// Where a work session drafts an extension before proposing it (ADR-0027).
pub const DRAFTS_DIR: &str = ".strive/drafts/extensions";
/// Where rules live, relative to the project: `<name>.md` each (ADR-0025).
pub const RULES_DIR: &str = ".strive/rules";
/// The most a rule's file may hold, in bytes.
pub const RULE_LIMIT: usize = 16 * 1024;

/// Every check a proposal goes through, in order. A proposal is ready once
/// each has a verdict and the static one didn't fail: the judge advises, and
/// a person may accept past its fail.
pub const GATES: [Gate; 2] = [Gate::Static, Gate::Judge];

/// The order gates are shown in: an extension's tests (ADR-0027) come with
/// its proposal, between the static gate and the judge. A failed one fails
/// the proposal, as a failed static gate does.
pub const ORDER: [Gate; 3] = [Gate::Static, Gate::Tests, Gate::Judge];

/// Proposals for the same file as `artifact` that were applied and then
/// rolled back, oldest first. A person undid each, so the judge is shown
/// them.
pub fn rolled_back<'a>(folded: &'a [Folded], artifact: &Artifact) -> Vec<&'a ProposalState> {
    let Ok(path) = relative_path(artifact) else { return Vec::new() };
    folded
        .iter()
        .map(|f| &f.state)
        .filter(|s| {
            s.status == ProposalStatus::RolledBack
                && relative_path(&s.proposal.change.artifact()).is_ok_and(|p| p == path)
        })
        .collect()
}

/// 1 to 40 of `a-z`, `0-9` and `-`: a name that is one path component and
/// can't be `.` or `..`.
pub fn valid_skill_name(name: &str) -> bool {
    (1..=SKILL_NAME_LIMIT).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The artifact's path inside the project, or why it has none.
pub fn relative_path(artifact: &Artifact) -> Result<String, String> {
    match artifact {
        Artifact::Memory => Ok(MEMORY_PATH.into()),
        Artifact::Skill { name } if valid_skill_name(name) => Ok(format!("{SKILLS_DIR}/{name}/SKILL.md")),
        Artifact::Skill { name } => {
            Err(format!("the skill name {name:?} isn't 1 to {SKILL_NAME_LIMIT} of a-z, 0-9 and -"))
        }
        Artifact::Check { name } if valid_skill_name(name) => Ok(format!("{CHECKS_DIR}/{name}.md")),
        Artifact::Check { name } => {
            Err(format!("the check name {name:?} isn't 1 to {SKILL_NAME_LIMIT} of a-z, 0-9 and -"))
        }
        Artifact::Command { name } if valid_skill_name(name) => Ok(format!("{COMMANDS_DIR}/{name}.md")),
        Artifact::Rule { name } if valid_skill_name(name) => Ok(format!("{RULES_DIR}/{name}.md")),
        Artifact::Extension { name } if valid_skill_name(name) => Ok(format!("{EXTENSIONS_DIR}/{name}")),
        Artifact::Extension { name } => {
            Err(format!("the extension name {name:?} isn't 1 to {SKILL_NAME_LIMIT} of a-z, 0-9 and -"))
        }
        Artifact::Rule { name } => {
            Err(format!("the rule name {name:?} isn't 1 to {SKILL_NAME_LIMIT} of a-z, 0-9 and -"))
        }
        Artifact::Command { name } => {
            Err(format!("the command name {name:?} isn't 1 to {SKILL_NAME_LIMIT} of a-z, 0-9 and -"))
        }
    }
}

/// A status as a person reads it.
pub fn status_name(status: ProposalStatus) -> &'static str {
    match status {
        ProposalStatus::Checking => "checking",
        ProposalStatus::Ready => "ready",
        ProposalStatus::Failed => "failed",
        ProposalStatus::Rejected => "rejected",
        ProposalStatus::Applied => "applied",
        ProposalStatus::Stale => "stale",
        ProposalStatus::RolledBack => "rolled back",
    }
}

/// The most a whole-file artifact's file may hold, in bytes.
pub fn file_limit(artifact: &Artifact) -> usize {
    match artifact {
        Artifact::Memory => MEMORY_LIMIT,
        Artifact::Skill { .. } => SKILL_LIMIT,
        Artifact::Check { .. } => CHECK_LIMIT,
        Artifact::Command { .. } => COMMAND_LIMIT,
        Artifact::Rule { .. } => RULE_LIMIT,
        Artifact::Extension { .. } => extension_dir::LIMIT,
    }
}

/// How a person reads the artifact: `memory`, or `skill <name>`.
pub fn describe(artifact: &Artifact) -> String {
    match artifact {
        Artifact::Memory => "memory".into(),
        Artifact::Skill { name } => format!("skill {name}"),
        Artifact::Check { name } => format!("check {name}"),
        Artifact::Command { name } => format!("command /{name}"),
        Artifact::Rule { name } => format!("rule {name}"),
        Artifact::Extension { name } => format!("extension {name}"),
    }
}
