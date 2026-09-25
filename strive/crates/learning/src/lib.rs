//! Trusted learning's pure parts (ADR-0016):
//! - where a proposal's artifact lives in the project;
//! - the static gate's checks of a proposal's own text;
//! - a proposal's status, folded from the learning session's journal;
//! - the judge gate's rubric, request and strict reading of its answer,
//!   and how a work session is rendered for it.
//!
//! The daemon adds what needs the machine: the path as it resolves on
//! disk, the file's digest, and whether the evidence's sessions exist.

mod checks;
mod fold;
pub mod judge;
pub mod render;

pub use checks::{Finding, Rule, check, frontmatter, verdict};
pub use fold::{Applied, Folded, fold};

use strive_proto::{Artifact, Gate, ProposalStatus};

/// Where memory lives, relative to the project.
pub const MEMORY_PATH: &str = ".strive/memory.md";
/// Where skills live, relative to the project: `<name>/SKILL.md` each.
pub const SKILLS_DIR: &str = ".strive/skills";
/// The most a memory file may hold, in bytes.
pub const MEMORY_LIMIT: usize = 16 * 1024;
/// The most a skill's SKILL.md may hold, in bytes.
pub const SKILL_LIMIT: usize = 32 * 1024;
/// The longest skill name.
pub const SKILL_NAME_LIMIT: usize = 40;

/// Every gate a proposal goes through, in cascade order. A proposal is
/// ready once each has a verdict and none failed.
pub const GATES: [Gate; 3] = [Gate::Static, Gate::Judge, Gate::Replay];

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
    }
}

/// The most the artifact's file may hold, in bytes.
pub fn size_limit(artifact: &Artifact) -> usize {
    match artifact {
        Artifact::Memory => MEMORY_LIMIT,
        Artifact::Skill { .. } => SKILL_LIMIT,
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

/// How a person reads the artifact: `memory`, or `skill <name>`.
pub fn describe(artifact: &Artifact) -> String {
    match artifact {
        Artifact::Memory => "memory".into(),
        Artifact::Skill { name } => format!("skill {name}"),
    }
}
