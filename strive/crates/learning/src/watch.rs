//! Watches (ADR-0019): a proposal's prediction in a form the daemon checks
//! on each later work session without a model.
//!
//! A session, to a watch, is its steps in order: each prompt, and each
//! command that ran with its output and exit. A watch matches steps by
//! case-insensitive substrings, so evaluating one is a single pass over at
//! most [`STEP_LIMIT`] steps and a bounded amount of output, whatever the
//! learner wrote. What that bound leaves unread can't confirm anything: an
//! outcome that depends on it is "not applicable".

use std::collections::{BTreeMap, HashMap};

use strive_proto::{
    Digest, EffectOutcome, EffectRecord, Entry, Event, ExitMatch, Expect, PredictionTally, StepMatch, Watch,
    WatchOutcome,
};

/// The longest string a step pattern may hold, in bytes.
pub const TEXT_LIMIT: usize = 200;
/// The most steps of one session a check reads.
pub const STEP_LIMIT: usize = 2000;
/// The most of one command's output a check reads, in bytes: its start and
/// its end, half each.
pub const OUTPUT_SCAN: usize = 256 * 1024;
/// The most output of one session a check reads in all, in bytes.
pub const TOTAL_SCAN: usize = 8 * 1024 * 1024;
/// How many of the latest sessions a watch applied to decide whether it's holding.
pub const RECENT: usize = 10;
/// The fewest contradictions among those that mark it not holding.
pub const NOT_HOLDING_AT: u32 = 3;

/// What's wrong with a watch's form, one line each; empty when it's fine.
pub fn problems(w: &Watch) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(when) = &w.when {
        pattern(when, "when", &mut out);
    }
    match &w.expect {
        Expect::Never { step } | Expect::Any { step } => pattern(step, "the expected step", &mut out),
        Expect::First { of, is } => {
            pattern(of, "first's of", &mut out);
            pattern(is, "first's is", &mut out);
            if of.prompt.is_some() != is.prompt.is_some() {
                out.push("first's of and is can't both match one step: one is a prompt, the other a command".into());
            }
        }
    }
    out
}

fn pattern(m: &StepMatch, what: &str, out: &mut Vec<String>) {
    let commandish = m.command.is_some() || m.output.is_some() || m.exit.is_some();
    if m.prompt.is_none() && !commandish {
        out.push(format!("{what} names nothing to match: give a prompt, or a command, output or exit"));
    }
    if m.prompt.is_some() && commandish {
        out.push(format!("{what} mixes a prompt with a command's fields; a step is one or the other"));
    }
    for (field, text) in [("prompt", &m.prompt), ("command", &m.command), ("output", &m.output)] {
        let Some(text) = text else { continue };
        if text.trim().is_empty() {
            out.push(format!("{what}'s {field} is empty"));
        } else if text.len() > TEXT_LIMIT {
            out.push(format!("{what}'s {field} is {} bytes; the limit is {TEXT_LIMIT}", text.len()));
        } else if text.contains(['\n', '\r']) {
            out.push(format!("{what}'s {field} holds a line break; match one line"));
        }
    }
}

/// Every string in a watch, for the checks that read all of a proposal's text.
pub fn strings(w: &Watch) -> Vec<&str> {
    let mut patterns: Vec<&StepMatch> = w.when.iter().collect();
    match &w.expect {
        Expect::Never { step } | Expect::Any { step } => patterns.push(step),
        Expect::First { of, is } => patterns.extend([of, is]),
    }
    patterns.into_iter().flat_map(|m| [&m.prompt, &m.command, &m.output]).filter_map(|t| t.as_deref()).collect()
}

/// A watch as a person reads it.
pub fn describe(w: &Watch) -> String {
    let expect = match &w.expect {
        Expect::Never { step } => format!("never {}", step_text(step)),
        Expect::Any { step } => format!("at least once, {}", step_text(step)),
        Expect::First { of, is } => format!("the first step that is {} is also {}", step_text(of), step_text(is)),
    };
    match &w.when {
        Some(when) => format!("in sessions with {}: {expect}", step_text(when)),
        None => format!("in every session: {expect}"),
    }
}

fn step_text(m: &StepMatch) -> String {
    if let Some(p) = &m.prompt {
        return format!("a prompt containing {:?}", p.trim());
    }
    let mut parts = vec!["a command".to_string()];
    if let Some(c) = &m.command {
        parts.push(format!("containing {:?}", c.trim()));
    }
    if let Some(o) = &m.output {
        parts.push(format!("whose output contains {:?}", o.trim()));
    }
    match m.exit {
        Some(ExitMatch::Zero) => parts.push("that exited 0".into()),
        Some(ExitMatch::NonZero) => parts.push("that failed".into()),
        None => {}
    }
    parts.join(" ")
}

/// One session's reading of a watch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    /// The session was read up to this entry, its last `turnEnded`.
    pub through_seq: u64,
    pub outcome: WatchOutcome,
    pub detail: String,
}

enum Step<'a> {
    Prompt { seq: u64, text: &'a str },
    Command { seq: u64, command: &'a str, output: Digest, exit: Option<i32> },
}

impl Step<'_> {
    fn text(&self) -> String {
        match self {
            Step::Prompt { seq, text } => format!("#{seq} the prompt {:?}", crate::render::cut(text.trim(), 120)),
            Step::Command { seq, command, exit, .. } => {
                let exit = exit.map_or_else(|| "stopped".to_string(), |c| format!("exit {c}"));
                format!("#{seq} ran `{}` ({exit})", crate::render::cut(command.trim(), 120))
            }
        }
    }
}

/// Reads outputs from the content store within the check's bounds, once each.
struct Outputs<'f> {
    get: &'f mut dyn FnMut(&Digest) -> Option<Vec<u8>>,
    /// Each output lowercased and whether that's all of it; none if it
    /// couldn't be read.
    seen: HashMap<Digest, Option<(String, bool)>>,
    left: usize,
    /// Something the check needed wasn't read in full.
    cut: bool,
}

impl Outputs<'_> {
    /// Whether the output holds `needle` (lowercase). None if it can't tell:
    /// the output wasn't read, or only part of it and the needle isn't there.
    fn holds(&mut self, d: &Digest, needle: &str) -> Option<bool> {
        if !self.seen.contains_key(d) {
            let read = if self.left == 0 { None } else { (self.get)(d) };
            let text = read.map(|bytes| {
                let limit = OUTPUT_SCAN.min(self.left);
                let whole = bytes.len() <= limit;
                let kept = if whole {
                    bytes
                } else {
                    // An error is usually at the end, so keep both ends.
                    let (head, tail) = (limit / 2, limit - limit / 2);
                    let mut kept = bytes[..head].to_vec();
                    kept.push(b'\n');
                    kept.extend_from_slice(&bytes[bytes.len() - tail..]);
                    kept
                };
                self.left -= kept.len().min(self.left);
                (String::from_utf8_lossy(&kept).to_lowercase(), whole)
            });
            self.seen.insert(*d, text);
        }
        let found = match self.seen.get(d) {
            Some(Some((text, whole))) => match (text.contains(needle), whole) {
                (true, _) => Some(true),
                (false, true) => Some(false),
                (false, false) => None,
            },
            Some(None) | None => None,
        };
        self.cut |= found.is_none();
        found
    }
}

/// At most `max` bytes of the start of `text`, ending on a character boundary.
fn head(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// Whether `needle` is in `text`, ignoring case. A pasted log can make a
/// prompt or a heredoc a command huge, so only the start is read, and a miss
/// there is unknown rather than a no.
fn find(text: &str, needle: &str, outputs: &mut Outputs) -> Option<bool> {
    let read = head(text, OUTPUT_SCAN);
    if read.to_lowercase().contains(&needle.trim().to_lowercase()) {
        Some(true)
    } else if read.len() < text.len() {
        outputs.cut = true;
        None
    } else {
        Some(false)
    }
}

/// Whether `step` matches `m`; none if that depends on output that wasn't read.
fn matches(step: &Step, m: &StepMatch, outputs: &mut Outputs) -> Option<bool> {
    match step {
        Step::Prompt { text, .. } => {
            let commandish = m.command.is_some() || m.output.is_some() || m.exit.is_some();
            let Some(p) = m.prompt.as_deref().filter(|_| !commandish) else { return Some(false) };
            find(text, p, outputs)
        }
        Step::Command { command, output, exit, .. } => {
            if m.prompt.is_some() {
                return Some(false);
            }
            if let Some(c) = m.command.as_deref() {
                match find(command, c, outputs) {
                    Some(true) => {}
                    other => return other,
                }
            }
            let exited = match m.exit {
                None => true,
                Some(ExitMatch::Zero) => *exit == Some(0),
                Some(ExitMatch::NonZero) => *exit != Some(0),
            };
            if !exited {
                return Some(false);
            }
            // Read last: it's the only part that costs anything.
            match &m.output {
                None => Some(true),
                Some(o) => outputs.holds(output, &o.trim().to_lowercase()),
            }
        }
    }
}

/// The watch read on one work session's journal, up to its last ended turn;
/// none if no turn has ended. `output` fetches a command's output from the
/// content store; it's called only for outputs a pattern needs, and at most
/// [`TOTAL_SCAN`] bytes of them are read.
pub fn check(w: &Watch, entries: &[Entry], output: &mut dyn FnMut(&Digest) -> Option<Vec<u8>>) -> Option<Checked> {
    let through = entries.iter().rev().find(|e| matches!(e.event, Event::TurnEnded { .. }))?.seq;
    let mut steps = Vec::new();
    let mut started: HashMap<u64, (u64, &str)> = HashMap::new();
    let mut cut_steps = false;
    for e in entries.iter().take_while(|e| e.seq <= through) {
        if steps.len() >= STEP_LIMIT {
            cut_steps = true;
            break;
        }
        match &e.event {
            Event::UserMessage { text } => steps.push(Step::Prompt { seq: e.seq, text }),
            Event::EffectStarted { effect, record: EffectRecord::Bash { command, .. }, .. } => {
                started.insert(*effect, (e.seq, command));
            }
            Event::EffectFinished { effect, outcome: EffectOutcome::Done { output, exit_code, .. }, .. } => {
                if let Some((seq, command)) = started.remove(effect) {
                    steps.push(Step::Command { seq, command, output: *output, exit: *exit_code });
                }
            }
            _ => {}
        }
    }
    let mut outputs = Outputs { get: output, seen: HashMap::new(), left: TOTAL_SCAN, cut: false };
    let done = |outcome, detail: String| Some(Checked { through_seq: through, outcome, detail });
    let unread = |outputs: &Outputs| {
        if cut_steps {
            format!("the session was too long to check whole: its first {STEP_LIMIT} steps were read")
        } else if outputs.cut {
            "the output it needed wasn't all read (too large, or not in the content store)".to_string()
        } else {
            String::new()
        }
    };
    if !steps.iter().any(|s| matches!(s, Step::Prompt { .. })) {
        return done(WatchOutcome::NotApplicable, "the session has no prompt".into());
    }
    if let Some(when) = &w.when
        && !steps.iter().any(|s| matches(s, when, &mut outputs) == Some(true))
    {
        let why = unread(&outputs);
        let head = format!("no step is {}", step_text(when));
        return done(WatchOutcome::NotApplicable, if why.is_empty() { head } else { format!("{head}; {why}") });
    }
    let read = steps.len();
    match &w.expect {
        Expect::Never { step } => {
            for s in &steps {
                if matches(s, step, &mut outputs) == Some(true) {
                    return done(WatchOutcome::Contradicted, s.text());
                }
            }
            match unread(&outputs) {
                why if why.is_empty() => done(WatchOutcome::Confirmed, format!("none of its {read} steps matched")),
                why => done(WatchOutcome::NotApplicable, why),
            }
        }
        Expect::Any { step } => {
            for s in &steps {
                if matches(s, step, &mut outputs) == Some(true) {
                    return done(WatchOutcome::Confirmed, s.text());
                }
            }
            match unread(&outputs) {
                why if why.is_empty() => done(WatchOutcome::Contradicted, format!("none of its {read} steps matched")),
                why => done(WatchOutcome::NotApplicable, why),
            }
        }
        Expect::First { of, is } => {
            for s in &steps {
                match matches(s, of, &mut outputs) {
                    Some(false) => {}
                    // An earlier step that can't be read might have been the first.
                    None => break,
                    Some(true) => {
                        return match matches(s, is, &mut outputs) {
                            Some(true) => done(WatchOutcome::Confirmed, s.text()),
                            Some(false) => done(WatchOutcome::Contradicted, s.text()),
                            None => done(WatchOutcome::NotApplicable, unread(&outputs)),
                        };
                    }
                }
            }
            match unread(&outputs) {
                why if why.is_empty() => done(WatchOutcome::NotApplicable, format!("no step is {}", step_text(of))),
                why => done(WatchOutcome::NotApplicable, why),
            }
        }
    }
}

/// A watch's tally from each session's latest outcome, keyed by session id.
/// Ids are ULIDs, so their order is the order the sessions were created in,
/// and "recent" is the last [`RECENT`] of them the watch applied to.
pub fn tally(latest: &BTreeMap<String, WatchOutcome>) -> PredictionTally {
    let mut t = PredictionTally::default();
    for outcome in latest.values() {
        match outcome {
            WatchOutcome::Confirmed => t.confirmed += 1,
            WatchOutcome::Contradicted => t.contradicted += 1,
            WatchOutcome::NotApplicable => t.not_applicable += 1,
        }
    }
    let applied = latest.values().rev().filter(|o| **o != WatchOutcome::NotApplicable).take(RECENT);
    for outcome in applied {
        match outcome {
            WatchOutcome::Confirmed => t.recent_confirmed += 1,
            WatchOutcome::Contradicted => t.recent_contradicted += 1,
            WatchOutcome::NotApplicable => {}
        }
    }
    t.not_holding = t.recent_contradicted >= NOT_HOLDING_AT && t.recent_contradicted > t.recent_confirmed;
    t
}

/// A tally as a person reads it: counts, and whether it's holding.
pub fn tally_text(t: &PredictionTally) -> String {
    let checked = t.confirmed + t.contradicted;
    if checked == 0 {
        return match t.not_applicable {
            0 => "no session has been checked yet".into(),
            n => format!("it hasn't applied to any of the {n} sessions checked"),
        };
    }
    let counts = format!(
        "confirmed in {}, contradicted in {} of {checked} session{}",
        t.confirmed,
        t.contradicted,
        if checked == 1 { "" } else { "s" }
    );
    let counts = match t.not_applicable {
        0 => counts,
        n => format!("{counts} ({n} more it didn't apply to)"),
    };
    if t.not_holding {
        format!(
            "not holding: {counts}; {} of the last {} it applied to contradicted it",
            t.recent_contradicted,
            t.recent_confirmed + t.recent_contradicted
        )
    } else {
        counts
    }
}
