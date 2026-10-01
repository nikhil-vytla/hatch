//! A rule's file (ADR-0025): `.strive/rules/<name>.md`, the format Claude
//! Code reads from `.claude/rules`. Optional frontmatter (`description`,
//! `paths`), then the guidance. A rule with `paths` is given to the agent
//! the first time in a session it reads or changes a file they match; one
//! without is given to every session, as `AGENTS.md` is.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleFile {
    pub description: Option<String>,
    /// Globs relative to the workspace; empty means every session.
    pub paths: Vec<String>,
    /// The guidance, trimmed.
    pub body: String,
}

const FIELDS: [&str; 2] = ["description", "paths"];

/// The rule in `text`, or every way it falls short. `paths` is
/// comma-separated on its line, or a YAML list on the lines after it
/// (`  - "src/**/*.ts"`), as Claude Code writes it. `strict` refuses
/// fields strive doesn't read, as for a file strive writes.
pub fn parse(text: &str, strict: bool) -> Result<RuleFile, Vec<String>> {
    let (block, body) = match text.strip_prefix("---\n") {
        None => ("", text),
        Some(rest) => match rest.find("\n---") {
            None => return Err(vec!["the rule's frontmatter has no closing ---".into()]),
            Some(end) => (&rest[..end], &rest[end + 4..]),
        },
    };
    let mut problems = Vec::new();
    let mut description = None;
    let mut paths: Vec<String> = Vec::new();
    let mut seen: Vec<&str> = Vec::new();
    // The field a list item belongs to: `paths` only.
    let mut listing = false;
    for line in block.lines().filter(|l| !l.trim().is_empty()) {
        if let Some(item) = line.trim_start().strip_prefix("- ") {
            if listing {
                paths.push(unquote(item.trim()).to_string());
            } else if strict {
                problems.push(format!("the list item {line:?} doesn't belong to paths"));
            }
            continue;
        }
        listing = false;
        let Some((key, value)) = line.split_once(':') else {
            if strict {
                problems.push(format!("the frontmatter line {line:?} isn't `field: value`"));
            }
            continue;
        };
        let key = key.trim();
        let Some(&known) = FIELDS.iter().find(|f| **f == key) else {
            if strict {
                problems
                    .push(format!("the frontmatter has an unknown field {key:?}; fields are {}", FIELDS.join(", ")));
            }
            continue;
        };
        if seen.contains(&known) {
            problems.push(format!("the frontmatter gives {known} twice"));
            continue;
        }
        seen.push(known);
        let value = unquote(value.trim());
        if known == "description" {
            description = Some(value.to_string()).filter(|v| !v.is_empty());
        } else if value.is_empty() {
            listing = true;
        } else {
            paths.extend(value.split(',').map(|p| unquote(p.trim()).to_string()));
        }
    }
    paths.retain(|p| !p.is_empty());
    for p in &paths {
        if p.starts_with('/') || p.split('/').any(|c| c == "..") {
            problems.push(format!("the path {p:?} must be relative to the workspace, without .."));
        } else if globset::Glob::new(p).is_err() {
            problems.push(format!("the path {p:?} isn't a glob"));
        }
    }
    let body = body.trim().to_string();
    if body.is_empty() {
        problems.push("it has no guidance after its frontmatter".into());
    }
    if problems.is_empty() { Ok(RuleFile { description, paths, body }) } else { Err(problems) }
}

fn unquote(s: &str) -> &str {
    s.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(s)
}

/// Whether `file`, relative to the workspace, matches one of `globs`: `*`
/// and `?` within a path component, `**` across them, `{a,b}` either. A
/// glob that doesn't parse matches nothing.
pub fn matches(globs: &[String], file: &str) -> bool {
    globs.iter().any(|g| {
        globset::GlobBuilder::new(g).literal_separator(true).build().is_ok_and(|g| g.compile_matcher().is_match(file))
    })
}
