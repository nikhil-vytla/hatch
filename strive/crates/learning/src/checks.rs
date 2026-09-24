//! The static gate's checks of a proposal's own text. Cheap and certain:
//! each finding names the rule and what broke it, so a person can see why
//! a proposal failed without reading the checks.
//!
//! The phrase lists are deliberately broad. A false alarm costs a person a
//! look; a missed instruction to bypass approvals would reach every later
//! session's agent.

use strive_proto::{Artifact, Proposal, Verdict};

/// A static-gate rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    /// The artifact must resolve inside the project's `.strive/`.
    Path,
    Size,
    /// A skill's frontmatter; a one-line summary; a rationale and a prediction.
    Form,
    Secret,
    /// Instructions that would weaken strive's safeguards.
    Weakening,
    /// The evidence must name real work sessions of the project.
    Evidence,
}

impl Rule {
    pub fn name(self) -> &'static str {
        match self {
            Rule::Path => "path",
            Rule::Size => "size",
            Rule::Form => "form",
            Rule::Secret => "secrets",
            Rule::Weakening => "safeguards",
            Rule::Evidence => "evidence",
        }
    }
}

/// One broken rule, and how.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub rule: Rule,
    pub detail: String,
}

impl Finding {
    pub fn new(rule: Rule, detail: impl Into<String>) -> Self {
        Self { rule, detail: detail.into() }
    }
}

/// The checks that need only the proposal: the path's name, size, form,
/// secrets (patterns, and `known` values such as stored API keys), weakening
/// instructions, and that some evidence is named at all.
pub fn check(p: &Proposal, known: &[String]) -> Vec<Finding> {
    let mut found = Vec::new();
    if let Err(why) = crate::relative_path(&p.artifact) {
        found.push(Finding::new(Rule::Path, why));
    }
    let limit = crate::size_limit(&p.artifact);
    if p.content.len() > limit {
        found.push(Finding::new(
            Rule::Size,
            format!("{} is {} bytes; the limit is {limit}", crate::describe(&p.artifact), p.content.len()),
        ));
    }
    found.extend(form(p).into_iter().map(|d| Finding::new(Rule::Form, d)));
    // The summary and rationale are shown to people, not given to the
    // agent, but a key in them would still sit in the journal.
    for (what, text) in [("content", &p.content), ("summary", &p.summary), ("rationale", &p.rationale)] {
        if let Some(kind) = secret(text, known) {
            found.push(Finding::new(Rule::Secret, format!("the {what} holds what looks like {kind}")));
        }
    }
    found.extend(weakening(&p.content).into_iter().map(|d| Finding::new(Rule::Weakening, d)));
    if p.evidence.is_empty() {
        found.push(Finding::new(Rule::Evidence, "it names no sessions as evidence"));
    }
    found
}

/// The gate's verdict and the detail a person reads.
pub fn verdict(findings: &[Finding]) -> (Verdict, String) {
    if findings.is_empty() {
        return (Verdict::Pass, "path, size, form, secrets, safeguards and evidence are fine".into());
    }
    let lines: Vec<String> = findings.iter().map(|f| format!("{}: {}", f.rule.name(), f.detail)).collect();
    (Verdict::Fail, lines.join("; "))
}

fn form(p: &Proposal) -> Vec<String> {
    let mut out = Vec::new();
    if p.summary.trim().is_empty() || p.summary.trim().contains('\n') {
        out.push("the summary must be one line".to_string());
    }
    if p.rationale.trim().is_empty() {
        out.push("it gives no rationale".to_string());
    }
    if p.prediction.trim().is_empty() {
        out.push("it makes no prediction to check later".to_string());
    }
    if let Artifact::Skill { name } = &p.artifact {
        match frontmatter(&p.content) {
            None => out.push(
                "a skill must start with --- frontmatter giving its name and a description of when to use it"
                    .to_string(),
            ),
            Some((named, _)) if named != *name => {
                out.push(format!("the skill's frontmatter names it {named:?}, not {name:?}"));
            }
            Some(_) => {}
        }
    }
    out
}

/// `name` and `description` from a SKILL.md's leading `---` block, both
/// present and non-empty.
pub fn frontmatter(text: &str) -> Option<(String, String)> {
    let body = text.strip_prefix("---\n")?;
    let block = &body[..body.find("\n---")?];
    let field = |key: &str| {
        block.lines().find_map(|l| {
            let v = l.strip_prefix(key)?.strip_prefix(':')?.trim();
            let v = v.strip_prefix('"').and_then(|v| v.strip_suffix('"')).unwrap_or(v);
            (!v.is_empty()).then(|| v.to_string())
        })
    };
    Some((field("name")?, field("description")?))
}

/// Characters a token (an API key, say) is made of.
fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '_'
}

/// Well-known credential shapes: a prefix, then at least `min` token
/// characters, at least one a digit (real keys are random; words aren't).
const SHAPES: &[(&str, usize, &str)] = &[
    ("sk-", 20, "an Anthropic or OpenAI API key"),
    ("ghp_", 30, "a GitHub token"),
    ("gho_", 30, "a GitHub token"),
    ("ghu_", 30, "a GitHub token"),
    ("ghs_", 30, "a GitHub token"),
    ("ghr_", 30, "a GitHub token"),
    ("github_pat_", 20, "a GitHub token"),
    ("xoxb-", 10, "a Slack token"),
    ("xoxp-", 10, "a Slack token"),
    ("xoxa-", 10, "a Slack token"),
    ("xoxr-", 10, "a Slack token"),
    ("xoxs-", 10, "a Slack token"),
    ("AIza", 30, "a Google API key"),
    ("AKIA", 16, "an AWS access key"),
];

/// What kind of secret `text` seems to hold, if any. Never the secret itself.
fn secret(text: &str, known: &[String]) -> Option<&'static str> {
    // Short values would match by chance; no real key is this short.
    if known.iter().any(|k| k.len() >= 8 && text.contains(k.as_str())) {
        return Some("one of strive's stored API keys");
    }
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY-----") {
        return Some("a private key");
    }
    SHAPES.iter().find(|(prefix, min, _)| shaped(text, prefix, *min)).map(|(_, _, kind)| *kind)
}

/// Whether `prefix` starts a token (not mid-word) followed by `min` or more
/// token characters, one of them a digit.
fn shaped(text: &str, prefix: &str, min: usize) -> bool {
    text.match_indices(prefix).any(|(at, _)| {
        let starts_token = text[..at].chars().next_back().is_none_or(|c| !token_char(c));
        let rest: Vec<char> = text[at + prefix.len()..].chars().take_while(|&c| token_char(c)).collect();
        starts_token && rest.len() >= min && rest.iter().any(char::is_ascii_digit)
    })
}

/// Phrases that would weaken strive, by what they'd do. Matched in
/// lowercase, with runs of whitespace as one space.
const WEAKENING: &[(&str, &[&str])] = &[
    (
        "bypasses approvals",
        &[
            "bypass approval",
            "bypass the approval",
            "skip approval",
            "skip the approval",
            "avoid approval",
            "disable approval",
            "without approval",
            "without asking for approval",
            "without asking for permission",
            "without asking permission",
            "auto-approve",
            "approve your own",
            "approve it yourself",
            "approve them yourself",
            "full-auto",
            "fullauto",
            "--approvals",
            "/approvals",
            "approval mode",
            "allowsession",
        ],
    ),
    (
        "weakens the sandbox",
        &[
            "sandbox-exec",
            "bwrap",
            "bubblewrap",
            "unsandboxed",
            "disable the sandbox",
            "disable sandbox",
            "bypass the sandbox",
            "bypass sandbox",
            "escape the sandbox",
            "outside the sandbox",
            "without the sandbox",
            "without a sandbox",
            "sandbox off",
            "sandbox: off",
            "\"sandbox\"",
            "dangerously",
        ],
    ),
    (
        "changes strive's own state or settings",
        &[
            "~/.strive",
            "$home/.strive",
            "${home}/.strive",
            "strive_home",
            "strive_host",
            "strive_socket",
            "credentials.json",
            "journal.key",
            "journal.jsonl",
            "strived",
            ".strive/settings",
            "strive's settings",
            "strive settings",
            "strive auth",
            "strive stop",
            // Memory and skills change only through review.
            ".strive/memory",
            ".strive/skills",
        ],
    ),
    (
        "tells the agent to ignore the user or its instructions",
        &[
            "ignore the user",
            "ignore user",
            "ignore what the user",
            "disregard the user",
            "disregard user",
            "ignore previous instructions",
            "ignore all previous",
            "ignore prior instructions",
            "ignore your instructions",
            "ignore the instructions",
            "ignore agents.md",
            "ignore claude.md",
            "don't tell the user",
            "do not tell the user",
            "without telling the user",
            "hide this from the user",
            "hide it from the user",
        ],
    ),
];

/// Programs that run a script piped to them.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish", "python", "python3", "perl", "ruby", "node"];

/// What in `text` would weaken strive, one line per kind found.
fn weakening(text: &str) -> Vec<String> {
    let normal = text.replace(['\u{2019}', '\u{2018}'], "'").to_lowercase();
    let flat = normal.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: Vec<String> = WEAKENING
        .iter()
        .filter_map(|(what, phrases)| phrases.iter().find(|p| flat.contains(*p)).map(|p| format!("it {what} ({p:?})")))
        .collect();
    if let Some(line) = normal.lines().find(|l| pipes_to_shell(l)) {
        out.push(format!("it installs by piping a download to a shell ({:?})", line.trim()));
    }
    out
}

/// `curl … | sh`, `wget … | sudo bash`, `sh <(curl …)`, `$(curl …)`.
fn pipes_to_shell(line: &str) -> bool {
    let downloads = |s: &str| s.contains("curl") || s.contains("wget");
    if !downloads(line) {
        return false;
    }
    if ["<(curl", "<(wget", "$(curl", "$(wget", "`curl", "`wget"].iter().any(|p| line.contains(p)) {
        return true;
    }
    let parts: Vec<&str> = line.split('|').collect();
    parts.iter().enumerate().skip(1).any(|(i, part)| {
        let fetched = parts[..i].iter().any(|p| downloads(p));
        let program = part.split_whitespace().find(|w| *w != "sudo" && !w.starts_with('-'));
        fetched && program.is_some_and(|p| SHELLS.contains(&p.rsplit('/').next().unwrap_or(p)))
    })
}
