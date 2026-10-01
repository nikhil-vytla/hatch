//! An extension's directory (ADR-0027): `.strive/extensions/<name>/`, an
//! `extension.json` declaring its tools and the TypeScript that runs them.
//! The daemon's loader and the static gate read it here, so a directory
//! the gate passed is one the loader runs.

use serde::Deserialize;

/// The most an extension's files may hold together, in bytes.
pub const LIMIT: usize = 64 * 1024;
/// The most files an extension may have.
pub const FILES: usize = 32;
/// The longest tool name.
pub const TOOL_NAME_LIMIT: usize = 40;

pub use strive_proto::ExtensionFile as File;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub name: String,
    pub description: String,
    pub tools: Vec<Tool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tool {
    pub name: String,
    pub description: String,
    /// The JSON Schema of its arguments: an object.
    pub parameters: serde_json::Value,
}

/// A tool's name: 1 to 40 of `a-z`, `0-9` and `_`, starting with a letter.
pub fn valid_tool_name(name: &str) -> bool {
    (1..=TOOL_NAME_LIMIT).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase())
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// The extension `name` in `files`, or every way it falls short.
pub fn parse(name: &str, files: &[File]) -> Result<Manifest, Vec<String>> {
    let mut problems = Vec::new();
    if files.len() > FILES {
        problems.push(format!("it has {} files; at most {FILES}", files.len()));
    }
    let total: usize = files.iter().map(|f| f.content.len()).sum();
    if total > LIMIT {
        problems.push(format!("its files hold {total} bytes; the limit is {LIMIT}"));
    }
    for f in files {
        problems.extend(path_problem(&f.path));
    }
    if !files.iter().any(|f| f.path == "index.ts") {
        problems.push("it has no index.ts".into());
    }
    let manifest = match files.iter().find(|f| f.path == "extension.json") {
        None => {
            problems.push("it has no extension.json".into());
            None
        }
        Some(f) => match serde_json::from_str::<Manifest>(&f.content) {
            Err(e) => {
                problems.push(format!("extension.json doesn't read: {e}"));
                None
            }
            Ok(m) => Some(m),
        },
    };
    if let Some(m) = &manifest {
        if m.name != name {
            problems.push(format!("extension.json names it {:?}, not {name:?}", m.name));
        }
        if m.description.trim().is_empty() {
            problems.push("extension.json gives no description".into());
        }
        if m.tools.is_empty() {
            problems.push("extension.json declares no tools".into());
        }
        for (i, t) in m.tools.iter().enumerate() {
            if !valid_tool_name(&t.name) {
                problems.push(format!(
                    "the tool name {:?} isn't 1 to {TOOL_NAME_LIMIT} of a-z, 0-9 and _, starting with a letter",
                    t.name
                ));
            }
            if m.tools[..i].iter().any(|o| o.name == t.name) {
                problems.push(format!("the tool {:?} is declared twice", t.name));
            }
            if t.description.trim().is_empty() {
                problems.push(format!("the tool {:?} has no description", t.name));
            }
            if t.parameters.get("type").and_then(serde_json::Value::as_str) != Some("object") {
                problems.push(format!(
                    "the tool {:?}'s parameters must be a JSON Schema with \"type\": \"object\"",
                    t.name
                ));
            }
        }
    }
    match manifest {
        Some(m) if problems.is_empty() => Ok(m),
        _ => Err(problems),
    }
}

/// What's wrong with a file's path, if anything: it stays inside the
/// directory, isn't hidden or a dependency, and is TypeScript, JSON or
/// Markdown.
fn path_problem(path: &str) -> Option<String> {
    let parts: Vec<&str> = path.split('/').collect();
    // An empty path, and one starting with `/`, have an empty component too.
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return Some(format!("the path {path:?} must be relative, inside the extension"));
    }
    if parts.iter().any(|p| p.starts_with('.')) {
        return Some(format!("the path {path:?} is hidden"));
    }
    if parts.contains(&"node_modules") {
        return Some(format!("the path {path:?} is a dependency; an extension carries none"));
    }
    let allowed = [".ts", ".json", ".md"];
    if !allowed.iter().any(|e| path.ends_with(e)) {
        return Some(format!("the path {path:?} isn't a .ts, .json or .md file"));
    }
    None
}

/// The files as a person or the judge reads them: each under its path, by path.
pub fn shown(files: &[File]) -> String {
    let mut sorted: Vec<&File> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    sorted.iter().map(|f| format!("=== {} ===\n{}", f.path, f.content.trim_end())).collect::<Vec<_>>().join("\n\n")
}

/// The files as one sequence of bytes, by path: what an extension's digest
/// is of, so the same files are the same extension.
pub fn canonical(files: &[File]) -> Vec<u8> {
    let mut sorted: Vec<&File> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    serde_json::to_vec(&sorted).unwrap_or_default()
}
