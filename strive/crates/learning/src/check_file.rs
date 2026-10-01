//! A check's file (ADR-0023): `.strive/checks/<name>.md`, frontmatter
//! saying what to run and when, then an optional body the agent is shown
//! when the check fails. The daemon's loader and the static gate read it
//! here, so a file the gate passed is one the loader runs.

/// The longest `run` line.
pub const RUN_LIMIT: usize = 500;
/// A check's time limit when its file names none, in seconds.
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// The longest time limit a check may ask for, in seconds.
pub const MAX_TIMEOUT_SECS: u64 = 600;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckFile {
    pub name: String,
    pub description: String,
    /// The command, one line.
    pub run: String,
    /// Globs relative to the workspace; empty means any change.
    pub paths: Vec<String>,
    pub timeout_secs: u64,
    /// What the agent is told when it fails, trimmed; may be empty.
    pub body: String,
}

const FIELDS: [&str; 5] = ["name", "description", "run", "paths", "timeout"];

/// The check in `text`, or every way it falls short, each a phrase a
/// person reads ("it has no run line").
pub fn parse(text: &str) -> Result<CheckFile, Vec<String>> {
    let Some(rest) = text.strip_prefix("---\n") else {
        return Err(vec!["a check must start with --- frontmatter giving its name, description and run".into()]);
    };
    let Some(end) = rest.find("\n---") else {
        return Err(vec!["the check's frontmatter has no closing ---".into()]);
    };
    let (block, after) = (&rest[..end], &rest[end + 4..]);
    let body = after.strip_prefix('\n').unwrap_or(after).trim().to_string();
    let mut problems = Vec::new();
    let mut seen: Vec<(&str, String)> = Vec::new();
    for line in block.lines().filter(|l| !l.trim().is_empty()) {
        let Some((key, value)) = line.split_once(':') else {
            problems.push(format!("the frontmatter line {line:?} isn't `field: value`"));
            continue;
        };
        let key = key.trim();
        let Some(&known) = FIELDS.iter().find(|f| **f == key) else {
            problems.push(format!("the frontmatter has an unknown field {key:?}; fields are {}", FIELDS.join(", ")));
            continue;
        };
        if seen.iter().any(|(k, _)| *k == known) {
            problems.push(format!("the frontmatter gives {known} twice"));
            continue;
        }
        let value = value.trim();
        let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value);
        seen.push((known, value.to_string()));
    }
    let field = |k: &str| seen.iter().find(|(key, _)| *key == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    let name = field("name");
    let description = field("description");
    let run = field("run");
    for (what, value) in [("name", &name), ("description", &description), ("run", &run)] {
        if value.is_none() {
            problems.push(format!("it has no {what}"));
        }
    }
    if let Some(run) = &run
        && run.len() > RUN_LIMIT
    {
        problems.push(format!("its run line is {} characters; the limit is {RUN_LIMIT}", run.len()));
    }
    let paths: Vec<String> = field("paths")
        .map(|v| v.split(',').map(str::trim).filter(|p| !p.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    for p in &paths {
        if p.starts_with('/') || p.split('/').any(|c| c == "..") {
            problems.push(format!("the path {p:?} must be relative to the workspace, without .."));
        }
    }
    let timeout_secs = match field("timeout") {
        None => DEFAULT_TIMEOUT_SECS,
        Some(v) => match v.strip_suffix('s').unwrap_or(&v).parse::<u64>() {
            Ok(n) if (1..=MAX_TIMEOUT_SECS).contains(&n) => n,
            _ => {
                problems.push(format!("its timeout {v:?} must be seconds from 1 to {MAX_TIMEOUT_SECS}"));
                DEFAULT_TIMEOUT_SECS
            }
        },
    };
    match (name, description, run) {
        (Some(name), Some(description), Some(run)) if problems.is_empty() => {
            Ok(CheckFile { name, description, run, paths, timeout_secs, body })
        }
        _ => Err(problems),
    }
}
