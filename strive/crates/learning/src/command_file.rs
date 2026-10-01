//! A slash command's file (ADR-0024): `.strive/commands/<name>.md`, the
//! format Claude Code reads from `.claude/commands`. Optional frontmatter
//! (`description`, `argument-hint`), then the prompt it stands for, where
//! `$ARGUMENTS` is what follows `/name` and `$1` to `$9` its words.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandFile {
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// The prompt, trimmed.
    pub body: String,
}

const FIELDS: [&str; 2] = ["description", "argument-hint"];

/// The command in `text`, or every way it falls short. `strict` refuses
/// frontmatter fields strive doesn't read, as for a file strive writes; a
/// file written for another tool (`.claude/commands`) may have more.
pub fn parse(text: &str, strict: bool) -> Result<CommandFile, Vec<String>> {
    let (block, body) = match text.strip_prefix("---\n") {
        None => ("", text),
        Some(rest) => match rest.find("\n---") {
            None => return Err(vec!["the command's frontmatter has no closing ---".into()]),
            // The body is trimmed below, so the closing line's newline goes with it.
            Some(end) => (&rest[..end], &rest[end + 4..]),
        },
    };
    let mut problems = Vec::new();
    let mut seen: Vec<(&str, String)> = Vec::new();
    for line in block.lines().filter(|l| !l.trim().is_empty()) {
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
        if seen.iter().any(|(k, _)| *k == known) {
            problems.push(format!("the frontmatter gives {known} twice"));
            continue;
        }
        let value = value.trim();
        let value = value.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(value);
        seen.push((known, value.to_string()));
    }
    let body = body.trim().to_string();
    if body.is_empty() {
        problems.push("it has no prompt after its frontmatter".into());
    }
    let field = |k: &str| seen.iter().find(|(key, _)| *key == k).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    if problems.is_empty() {
        Ok(CommandFile { description: field("description"), argument_hint: field("argument-hint"), body })
    } else {
        Err(problems)
    }
}

/// The prompt `/name arguments` stands for. Arguments a prompt doesn't
/// place (no `$ARGUMENTS` or `$1`-`$9`) are added after it, so none are
/// lost. One pass over the prompt: what the arguments say is never
/// expanded itself.
pub fn expand(body: &str, arguments: &str) -> String {
    let arguments = arguments.trim();
    let words: Vec<&str> = arguments.split_whitespace().collect();
    let mut out = String::with_capacity(body.len() + arguments.len());
    let mut placed = false;
    // Each piece after a `$` starts with what that `$` names, if anything.
    let mut pieces = body.split('$');
    out.push_str(pieces.next().unwrap_or_default());
    for piece in pieces {
        if let Some(tail) = piece.strip_prefix("ARGUMENTS") {
            out.push_str(arguments);
            out.push_str(tail);
            placed = true;
        } else if let Some(d) = piece.chars().next().and_then(|c| c.to_digit(10)).filter(|d| *d >= 1) {
            out.push_str(words.get(d as usize - 1).copied().unwrap_or(""));
            // An ASCII digit is one byte.
            out.push_str(&piece[1..]);
            placed = true;
        } else {
            out.push('$');
            out.push_str(piece);
        }
    }
    if !placed && !arguments.is_empty() {
        out.push_str("\n\n");
        out.push_str(arguments);
    }
    out
}

/// A prompt that names a command: its name and what follows it, when it
/// starts with `/` and a name of 1 to 40 of `a-z`, `0-9` and `-`.
pub fn invoked(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix('/')?;
    let (name, arguments) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    crate::valid_skill_name(name).then_some((name, arguments))
}
