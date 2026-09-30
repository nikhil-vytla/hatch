//! `.strive/memory.md` as bullets (ADR-0022): parsing and writing it
//! exactly, applying one proposal's operation to one bullet, and undoing it.
//!
//! The file stays plain markdown. A bullet the learner wrote ends with
//! `<!-- strive:#42 -->`, naming the proposal that last wrote it; a bullet a
//! person wrote has no comment. Every other line is kept as it is, and a
//! file parsed and written unchanged is the same bytes.
//!
//! An operation touches only the bullet it names: every other line is
//! carried over as it was, so a proposal can't hide an edit elsewhere.

use std::collections::HashMap;

use strive_proto::{BulletEdit, MemoryItem, MemoryOp, ProposalStatus};

use crate::{Finding, Folded, Rule};

/// The longest bullet, in characters.
pub const BULLET_LIMIT: usize = 500;

/// The file, line by line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Memory {
    lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Line {
    /// Without its line ending.
    body: String,
    /// `\n`, `\r\n`, or empty for a last line without one.
    eol: String,
    bullet: Option<Bullet>,
}

impl Line {
    fn new(body: String, eol: String) -> Self {
        let bullet = bullet(&body);
        Self { body, eol, bullet }
    }

    /// The indent, the marker and the space after it; empty if it isn't a bullet.
    fn prefix(&self) -> &str {
        &self.body[..self.bullet.as_ref().map_or(0, |b| b.prefix)]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Bullet {
    /// The length of the indent, the marker and the space after it.
    prefix: usize,
    /// Without the prefix, the source comment or trailing space.
    text: String,
    source: Option<u64>,
}

/// How an operation names a bullet: `#42`, its source, or a hand-written
/// bullet's exact text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ref<'a> {
    Source(u64),
    Text(&'a str),
}

impl<'a> Ref<'a> {
    fn parse(s: &'a str) -> Self {
        let s = s.trim();
        // Digits only: `#+3` is text, though `+3` parses. `#` alone fails to parse.
        match s.strip_prefix('#').filter(|n| n.bytes().all(|b| b.is_ascii_digit())) {
            Some(n) => n.parse().map_or(Ref::Text(s), Ref::Source),
            None => Ref::Text(s),
        }
    }

    /// How the file names `b`: by its source, or by its text if a person wrote it.
    fn of(b: &'a Bullet) -> Self {
        b.source.map_or(Ref::Text(&b.text), Ref::Source)
    }

    fn matches(self, b: &Bullet) -> bool {
        match self {
            Ref::Source(n) => b.source == Some(n),
            Ref::Text(t) => b.source.is_none() && b.text == t,
        }
    }
}

impl std::fmt::Display for Ref<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Ref::Source(n) => write!(f, "#{n}"),
            Ref::Text(t) => write!(f, "{t:?}"),
        }
    }
}

/// Why a bullet wasn't found once.
enum Miss {
    None,
    Many,
}

/// Parses a memory file. It never fails: what isn't a bullet is a line.
pub fn parse(text: &str) -> Memory {
    let mut lines = Vec::new();
    let mut fenced = false;
    for raw in text.split_inclusive('\n') {
        let (body, eol) = match raw.strip_suffix("\r\n") {
            Some(b) => (b, "\r\n"),
            None => raw.strip_suffix('\n').map_or((raw, ""), |b| (b, "\n")),
        };
        let trimmed = body.trim_start();
        let fence = trimmed.starts_with("```") || trimmed.starts_with("~~~");
        let mut line = Line::new(body.to_string(), eol.to_string());
        // A list in a code block is code.
        if fenced || fence {
            line.bullet = None;
        }
        fenced ^= fence;
        lines.push(line);
    }
    Memory { lines }
}

/// A line as a bullet: an indent, `-`, `*` or `+`, then space and text.
fn bullet(body: &str) -> Option<Bullet> {
    let after = body.trim_start_matches([' ', '\t']).strip_prefix(['-', '*', '+'])?;
    let text = after.trim_start_matches([' ', '\t']);
    if text.len() == after.len() {
        return None;
    }
    let prefix = body.len() - text.len();
    let (text, source) = sourced(text);
    (!text.is_empty()).then(|| Bullet { prefix, text: text.to_string(), source })
}

/// A bullet's text and the source its trailing `<!-- strive:#N -->` names.
fn sourced(text: &str) -> (&str, Option<u64>) {
    let t = text.trim_end();
    let comment = t.rfind("<!--").and_then(|at| {
        let n = t[at + 4..].strip_suffix("-->")?.trim().strip_prefix("strive:#")?;
        let n = n.bytes().all(|b| b.is_ascii_digit()).then(|| n.parse::<u64>().ok()).flatten()?;
        Some((at, n))
    });
    match comment {
        Some((at, n)) => (t[..at].trim_end(), Some(n)),
        None => (t, None),
    }
}

/// Runs of whitespace as one space: what "the same bullet" compares.
fn normal(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Memory {
    /// The file's text: exactly what was parsed, with any edits.
    pub fn write(&self) -> String {
        let mut out = String::new();
        for l in &self.lines {
            out.push_str(&l.body);
            out.push_str(&l.eol);
        }
        out
    }

    /// The file as a work session is given it: bullets without their
    /// source comments.
    pub fn for_sessions(&self) -> String {
        let mut out = String::new();
        for l in &self.lines {
            match &l.bullet {
                Some(b) if b.source.is_some() => {
                    out.push_str(l.prefix());
                    out.push_str(&b.text);
                }
                _ => out.push_str(&l.body),
            }
            out.push_str(&l.eol);
        }
        out
    }

    /// Each line: a bullet with its source, or the line as it is.
    pub fn items(&self) -> Vec<MemoryItem> {
        self.lines
            .iter()
            .map(|l| match &l.bullet {
                Some(b) => MemoryItem::Bullet { text: b.text.clone(), source: b.source, outside_review: false },
                None => MemoryItem::Line { text: l.body.clone() },
            })
            .collect()
    }

    fn bullets(&self) -> impl Iterator<Item = (usize, &Bullet)> {
        self.lines.iter().enumerate().filter_map(|(i, l)| l.bullet.as_ref().map(|b| (i, b)))
    }

    /// The one bullet `r` names.
    fn find(&self, r: Ref) -> Result<(usize, &Bullet), Miss> {
        let mut found = self.bullets().filter(|(_, b)| r.matches(b));
        match (found.next(), found.next()) {
            (Some(one), None) => Ok(one),
            (None, _) => Err(Miss::None),
            (Some(_), Some(_)) => Err(Miss::Many),
        }
    }

    /// The one bullet `r` names, or why it names none, for the learner.
    fn named(&self, r: Ref) -> Result<(usize, &Bullet), String> {
        match self.find(r) {
            Ok(found) => Ok(found),
            Err(Miss::Many) => Err(format!("more than one bullet in memory is {r}, so it doesn't name one")),
            Err(Miss::None) => {
                let learned = match r {
                    Ref::Text(t) => self.bullets().find_map(|(_, b)| b.source.filter(|_| b.text == t)),
                    Ref::Source(_) => None,
                };
                Err(match learned {
                    Some(n) => format!("proposal #{n} wrote the bullet {r}; name it \"#{n}\""),
                    None => format!("memory has no bullet {r}"),
                })
            }
        }
    }

    /// The first line ending the file uses; `\n` if it has none.
    fn eol(&self) -> String {
        self.lines.iter().map(|l| l.eol.as_str()).find(|e| !e.is_empty()).unwrap_or("\n").to_string()
    }

    /// Puts `body` in as line `at`. A file that didn't end with a line
    /// ending still doesn't.
    fn insert(&mut self, at: usize, body: String) {
        let mut eol = self.eol();
        if at == self.lines.len()
            && let Some(last) = self.lines.last_mut()
            && last.eol.is_empty()
        {
            last.eol = std::mem::take(&mut eol);
        }
        self.lines.insert(at, Line::new(body, eol));
    }

    /// Takes line `at` out. When it was the last line and had no line
    /// ending, the new last line has none either.
    fn remove(&mut self, at: usize) -> Line {
        let line = self.lines.remove(at);
        if at == self.lines.len()
            && line.eol.is_empty()
            && let Some(last) = self.lines.last_mut()
        {
            last.eol.clear();
        }
        line
    }

    /// Replaces line `at`'s text, keeping its line ending.
    fn replace(&mut self, at: usize, body: String) {
        let eol = std::mem::take(&mut self.lines[at].eol);
        self.lines[at] = Line::new(body, eol);
    }

    /// The last line before `at` that isn't blank, if any, and how many
    /// blank lines lie between.
    fn follows(&self, at: usize) -> (Option<String>, u32) {
        let blank = |l: &Line| l.body.trim().is_empty();
        let gap = self.lines[..at].iter().rev().take_while(|l| blank(l)).count();
        let follows = self.lines[..at - gap].last().map(|l| l.body.clone());
        (follows, u32::try_from(gap).unwrap_or(u32::MAX))
    }

    /// Where a bullet goes back: `gap` blank lines past `follows` (as far as
    /// blank lines go), or after the last bullet if `follows` is gone.
    fn restore_at(&self, follows: Option<&str>, gap: u32) -> usize {
        let start = match follows {
            None => 0,
            Some(f) => match self.lines.iter().position(|l| l.body == f) {
                Some(i) => i + 1,
                None => return self.end(),
            },
        };
        let blanks = self.lines[start..].iter().take_while(|l| l.body.trim().is_empty()).count();
        start + blanks.min(usize::try_from(gap).unwrap_or(usize::MAX))
    }

    /// Where a new bullet goes when none is named: after the last bullet,
    /// or at the end of a file with none.
    fn end(&self) -> usize {
        self.bullets().last().map_or(self.lines.len(), |(i, _)| i + 1)
    }

    /// Whether a bullet reads as `line` does: its text and its source.
    fn has(&self, line: &str) -> bool {
        bullet(line).is_some_and(|want| self.bullets().any(|(_, b)| b.text == want.text && b.source == want.source))
    }
}

/// A bullet's line: its prefix, its text, and the proposal that wrote it.
fn line(prefix: &str, text: &str, id: u64) -> String {
    format!("{prefix}{text} <!-- strive:#{id} -->")
}

/// An operation's effect on the file as it is now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    /// The file with it applied.
    pub text: String,
    pub edit: BulletEdit,
    /// False when the file already had it: an accept a crash cut off after
    /// its write, which a retry records without writing.
    pub written: bool,
}

/// Applies proposal `id`'s operation to the file as it is `now`, given the
/// file as the learner saw it (`shown`). For change and remove, the bullet
/// must still read as it did then; edits elsewhere don't matter. The error
/// says why it's stale.
pub fn apply(now: &str, shown: &str, op: &MemoryOp, id: u64) -> Result<Applied, String> {
    let mut m = parse(now);
    let (edit, written) = edit(&mut m, &parse(shown), op, id)?;
    let text = m.write();
    if written && text.len() > crate::MEMORY_LIMIT {
        return Err(format!("memory would be {} bytes, over the limit of {}", text.len(), crate::MEMORY_LIMIT));
    }
    Ok(Applied { text, edit, written })
}

/// The one-bullet diff proposal `id`'s operation makes to the file the
/// learner saw; none if it doesn't apply there.
pub fn preview(shown: &str, op: &MemoryOp, id: u64) -> Option<BulletEdit> {
    let seen = parse(shown);
    edit(&mut seen.clone(), &seen, op, id).ok().map(|(e, _)| e)
}

/// Does `op` to `m`: what it did to its bullet, and whether it wrote
/// anything (false: `m` already has it).
fn edit(m: &mut Memory, seen: &Memory, op: &MemoryOp, id: u64) -> Result<(BulletEdit, bool), String> {
    match op {
        MemoryOp::Add { text, after } => {
            let text = text.trim();
            match m.find(Ref::Source(id)) {
                Ok((i, b)) if b.text == text => {
                    return Ok((BulletEdit::Added { line: m.lines[i].body.clone() }, false));
                }
                Ok(_) | Err(Miss::Many) => return Err(format!("memory already has a bullet from #{id}")),
                Err(Miss::None) => {}
            }
            if let Some((_, b)) = m.bullets().find(|(_, b)| normal(&b.text) == normal(text)) {
                return Err(format!("memory already has the bullet {:?}", b.text));
            }
            let at = after.as_deref().and_then(|a| m.find(Ref::parse(a)).ok()).map(|(i, _)| i);
            let prefix = match at {
                Some(i) => m.lines[i].prefix().to_string(),
                None => m
                    .lines
                    .iter()
                    .rev()
                    .find(|l| l.bullet.is_some() && !l.body.starts_with([' ', '\t']))
                    .map_or_else(|| "- ".to_string(), |l| l.prefix().to_string()),
            };
            let new = line(&prefix, text, id);
            m.insert(at.map_or_else(|| m.end(), |i| i + 1), new.clone());
            Ok((BulletEdit::Added { line: new }, true))
        }
        MemoryOp::Change { bullet, text } => {
            let text = text.trim();
            let (at, was) = seen.named(Ref::parse(bullet))?;
            if was.text == text {
                return Err(format!("it leaves the bullet {} as it is", Ref::of(was)));
            }
            match m.find(Ref::of(was)) {
                Ok((i, b)) if b.text == was.text => {
                    let old = m.lines[i].body.clone();
                    let new = line(m.lines[i].prefix(), text, id);
                    m.replace(i, new.clone());
                    Ok((BulletEdit::Changed { old, new }, true))
                }
                Ok(_) | Err(Miss::Many) => Err(changed_since(was)),
                Err(Miss::None) => match m.find(Ref::Source(id)) {
                    Ok((i, b)) if b.text == text => Ok((
                        BulletEdit::Changed { old: seen.lines[at].body.clone(), new: m.lines[i].body.clone() },
                        false,
                    )),
                    Ok(_) | Err(Miss::None | Miss::Many) => Err(changed_since(was)),
                },
            }
        }
        MemoryOp::Remove { bullet } => {
            let (at, was) = seen.named(Ref::parse(bullet))?;
            match m.find(Ref::of(was)) {
                Ok((i, b)) if b.text == was.text => {
                    let (follows, gap) = m.follows(i);
                    Ok((BulletEdit::Removed { line: m.remove(i).body, follows, gap }, true))
                }
                Ok(_) | Err(Miss::Many) => Err(changed_since(was)),
                Err(Miss::None) => {
                    let (follows, gap) = seen.follows(at);
                    Ok((BulletEdit::Removed { line: seen.lines[at].body.clone(), follows, gap }, false))
                }
            }
        }
    }
}

fn changed_since(was: &Bullet) -> String {
    format!("the bullet {} changed since the learner saw it", Ref::of(was))
}

/// Undoes what proposal `id` did to its bullet in the file as it is `now`:
/// the file to write, or none if it's already undone (a rollback a crash
/// cut off after its write). Refused only when that bullet changed since;
/// the error says how.
pub fn undo(now: &str, edit: &BulletEdit, id: u64) -> Result<Option<String>, String> {
    let mut m = parse(now);
    let wrote = |line: &str| bullet(line).map(|b| b.text);
    match edit {
        BulletEdit::Added { line } => match m.find(Ref::Source(id)) {
            Ok((i, b)) if Some(&b.text) == wrote(line).as_ref() => {
                m.remove(i);
                Ok(Some(m.write()))
            }
            Ok(_) => Err(format!("the bullet #{id} added has been edited since")),
            Err(Miss::Many) => Err(format!("more than one bullet in memory is #{id}")),
            Err(Miss::None) => Ok(None),
        },
        BulletEdit::Changed { old, new } => match m.find(Ref::Source(id)) {
            Ok((i, b)) if Some(&b.text) == wrote(new).as_ref() => {
                m.replace(i, old.clone());
                Ok(Some(m.write()))
            }
            Ok(_) => Err(format!("the bullet #{id} changed has been edited since")),
            Err(Miss::Many) => Err(format!("more than one bullet in memory is #{id}")),
            Err(Miss::None) if m.has(old) => Ok(None),
            Err(Miss::None) => Err(format!("the bullet #{id} changed is gone from memory")),
        },
        BulletEdit::Removed { line, follows, gap } => {
            if m.has(line) {
                return Ok(None);
            }
            let at = m.restore_at(follows.as_deref(), *gap);
            m.insert(at, line.clone());
            Ok(Some(m.write()))
        }
    }
}

/// What's wrong with `op` against the file as the learner saw it: its
/// text's form and length, the bullets it names, a duplicate, and the size
/// of the file it would leave.
pub fn check(shown: &str, op: &MemoryOp) -> Vec<Finding> {
    let mut found = Vec::new();
    if let MemoryOp::Add { text, .. } | MemoryOp::Change { text, .. } = op {
        let text = text.trim();
        if text.is_empty() {
            found.push(Finding::new(Rule::Form, "the bullet has no text"));
        }
        if text.contains(['\n', '\r']) {
            found.push(Finding::new(Rule::Form, "a bullet is one line; this one has a line break"));
        }
        if bullet(text).is_some() {
            found.push(Finding::new(Rule::Form, "give the bullet's text without its marker (`- `)"));
        }
        let chars = text.chars().count();
        if chars > BULLET_LIMIT {
            found.push(Finding::new(
                Rule::Size,
                format!("the bullet is {chars} characters; the limit is {BULLET_LIMIT}"),
            ));
        }
    }
    let seen = parse(shown);
    if let MemoryOp::Add { after: Some(after), .. } = op
        && let Err(why) = seen.named(Ref::parse(after))
    {
        found.push(Finding::new(Rule::Bullet, format!("after: {why}")));
    }
    let mut m = seen.clone();
    match edit(&mut m, &seen, op, u64::MAX) {
        Ok(_) => {
            let bytes = m.write().len();
            if bytes > crate::MEMORY_LIMIT {
                found.push(Finding::new(
                    Rule::Size,
                    format!("memory would be {bytes} bytes; the limit is {}", crate::MEMORY_LIMIT),
                ));
            }
        }
        Err(why) => found.push(Finding::new(Rule::Bullet, why)),
    }
    found
}

/// The memory as it is `now`, each bullet with a source marked when that
/// source isn't an applied proposal which left it reading so: changed
/// outside review.
pub fn view(now: &str, folded: &[Folded]) -> Vec<MemoryItem> {
    let left: HashMap<u64, String> = folded
        .iter()
        .filter(|f| f.state.status == ProposalStatus::Applied)
        .filter_map(|f| match f.applied.as_ref()?.bullet.as_ref()? {
            BulletEdit::Added { line } | BulletEdit::Changed { new: line, .. } => {
                Some((f.state.id, bullet(line)?.text))
            }
            BulletEdit::Removed { .. } => None,
        })
        .collect();
    parse(now)
        .items()
        .into_iter()
        .map(|item| match item {
            MemoryItem::Bullet { text, source: Some(n), .. } => {
                let outside_review = left.get(&n) != Some(&text);
                MemoryItem::Bullet { text, source: Some(n), outside_review }
            }
            other @ (MemoryItem::Bullet { .. } | MemoryItem::Line { .. }) => other,
        })
        .collect()
}

/// The proposal a line of the file names as its bullet's source.
pub fn source(line: &str) -> Option<u64> {
    bullet(line)?.source
}
