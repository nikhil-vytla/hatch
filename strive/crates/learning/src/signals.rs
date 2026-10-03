//! The pre-filter for automatic learning (ADR-0020): signs in a work
//! session's journal that something is worth learning, found without a
//! model. Only a session with a sign starts a learner run on its own.
//!
//! Each sign is anchored at the entry that completes it, so scanning a
//! longer journal of the same session finds the same signs plus new ones
//! with higher seqs. A caller that remembers the highest seq it acted on
//! can ask for only what came after.

use strive_proto::{Decision, EffectOutcome, EffectRecord, Entry, Event, LearnSignal, SignalKind, TurnEnd};

/// The most signs one scan returns: the earliest, so a later scan past the
/// last one returned picks up the rest.
pub const LIMIT: usize = 20;
/// The longest excerpt a sign carries, in characters.
pub const DETAIL_LIMIT: usize = 120;
/// How much of a prompt is read for correction phrasing, in characters.
pub const PROMPT_SCAN: usize = 200;
/// The longest command a `failedThenPassed` sign is found for: longer ones
/// are rarely a plain check someone would rerun.
pub const COMMAND_LIMIT: usize = 300;

/// A prompt that opens with one of these words reads as a correction.
const OPENERS: [&[&str]; 14] = [
    &["no"],
    &["nope"],
    &["wrong"],
    &["stop"],
    &["undo"],
    &["revert"],
    &["actually"],
    &["wait"],
    &["instead"],
    &["don't"],
    &["do", "not"],
    &["not", "that"],
    &["that's", "not"],
    &["that", "is", "not"],
];

/// Openers that aren't corrections after all.
const NOT_OPENERS: [&[&str]; 4] = [&["no", "problem"], &["no", "worries"], &["no", "rush"], &["no", "thanks"]];

/// A prompt holding one of these word sequences anywhere in what is read
/// reads as a correction.
const PHRASES: [&[&str]; 20] = [
    &["that's", "wrong"],
    &["that", "is", "wrong"],
    &["not", "what", "i"],
    &["i", "said"],
    &["i", "meant"],
    &["i", "asked", "you"],
    &["you", "didn't"],
    &["you", "did", "not"],
    &["you", "shouldn't"],
    &["you", "should", "not"],
    &["should", "have"],
    &["shouldn't", "have"],
    &["why", "did", "you"],
    &["please", "don't"],
    &["not", "correct"],
    &["incorrect"],
    &["you", "broke"],
    &["you", "forgot"],
    &["still", "failing"],
    &["doesn't", "work"],
];

/// The signs in one work session's journal with a seq above `after`, in
/// journal order, at most `LIMIT`.
pub fn scan(session: &str, entries: &[Entry], after: u64) -> Vec<LearnSignal> {
    let mut found: Vec<(u64, SignalKind, String)> = Vec::new();
    // Whether the next prompt is the first after a turn ended.
    let mut after_turn = false;
    let mut asked: Vec<(u64, &str)> = Vec::new();
    for e in entries {
        match &e.event {
            Event::TurnEnded { turn, reason } => {
                after_turn = true;
                match reason {
                    TurnEnd::Done => {}
                    TurnEnd::Interrupted => {
                        found.push((e.seq, SignalKind::Interrupted, format!("turn {turn} was interrupted")));
                    }
                    TurnEnd::TimedOut { seconds } => {
                        found.push((
                            e.seq,
                            SignalKind::TurnFailed,
                            format!("turn {turn} ran out of time at {seconds}s"),
                        ));
                    }
                    TurnEnd::Failed { error } => {
                        found.push((e.seq, SignalKind::TurnFailed, format!("turn {turn} failed: {}", excerpt(error))));
                    }
                }
            }
            Event::TurnStarted { .. } => after_turn = false,
            Event::UserMessage { text, command, .. } => {
                // What the person typed: a command's arguments, not the prompt it stands for.
                let typed = command.as_ref().map_or(text.as_str(), |c| c.arguments.as_str());
                if std::mem::take(&mut after_turn) && is_correction(typed) {
                    found.push((e.seq, SignalKind::Correction, excerpt(typed)));
                }
            }
            Event::ApprovalRequested { effect, description, .. } => asked.push((*effect, description)),
            Event::ApprovalDecided { effect, decision: Decision::Deny, .. } => {
                let what = asked.iter().rev().find(|(id, _)| id == effect).map_or("an action", |(_, d)| d);
                found.push((e.seq, SignalKind::Declined, excerpt(what)));
            }
            _ => {}
        }
    }
    for (seq, command) in failed_then_passed(entries) {
        found.push((seq, SignalKind::FailedThenPassed, excerpt(&command)));
    }
    found.sort_by_key(|(seq, ..)| *seq);
    found
        .into_iter()
        .filter(|(seq, ..)| *seq > after)
        .take(LIMIT)
        .map(|(seq, kind, detail)| LearnSignal { session: session.to_string(), seq, kind, detail })
        .collect()
}

/// Each turn's first command that failed and that the session later ran
/// again, the same command, with exit 0: the passing run's seq, and the
/// command.
fn failed_then_passed(entries: &[Entry]) -> Vec<(u64, String)> {
    // Bash effects started in a turn: (effect, turn, command).
    let mut started: Vec<(u64, usize, String)> = Vec::new();
    // Commands that ran to an exit: (turn, command, exit, seq).
    let mut runs: Vec<(usize, String, i32, u64)> = Vec::new();
    let mut turns = 0;
    for e in entries {
        match &e.event {
            Event::TurnStarted { .. } => turns += 1,
            Event::EffectStarted { effect, record: EffectRecord::Bash { command, .. }, .. } if turns > 0 => {
                started.push((*effect, turns, command.trim().to_string()));
            }
            Event::EffectFinished { effect, outcome: EffectOutcome::Done { exit_code: Some(exit), .. }, .. } => {
                if let Some((_, turn, command)) = started.iter().find(|(id, ..)| id == effect) {
                    runs.push((*turn, command.clone(), *exit, e.seq));
                }
            }
            _ => {}
        }
    }
    let mut found: Vec<(usize, u64, String)> = Vec::new();
    for (turn, command, _, failed) in runs.iter().filter(|r| r.2 != 0 && !r.1.is_empty() && r.1.len() <= COMMAND_LIMIT)
    {
        if found.iter().any(|(t, ..)| t == turn) {
            continue;
        }
        if let Some((.., passed)) = runs.iter().find(|r| r.3 > *failed && r.2 == 0 && r.1 == *command) {
            found.push((*turn, *passed, command.clone()));
        }
    }
    found.into_iter().map(|(_, seq, command)| (seq, command)).collect()
}

/// Whether a prompt reads as correcting what the agent just did: it opens
/// with a word like "no" or "actually", or holds a phrase like "I said" or
/// "you didn't", within its first `PROMPT_SCAN` characters. Crude on
/// purpose: a false alarm costs one capped learner run, and the learner
/// decides whether there's a lesson.
pub fn is_correction(text: &str) -> bool {
    let head: String = text.chars().take(PROMPT_SCAN).collect::<String>().to_lowercase().replace('\u{2019}', "'");
    let words: Vec<&str> =
        head.split(|c: char| !(c.is_alphanumeric() || c == '\'')).filter(|w| !w.is_empty()).collect();
    let opens = |p: &[&str]| words.len() >= p.len() && words[..p.len()] == *p;
    if OPENERS.iter().any(|p| opens(p)) && !NOT_OPENERS.iter().any(|p| opens(p)) {
        return true;
    }
    PHRASES.iter().any(|p| words.windows(p.len()).any(|w| w == *p))
}

/// One line of at most `DETAIL_LIMIT` characters.
fn excerpt(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= DETAIL_LIMIT {
        return line;
    }
    let cut: String = line.chars().take(DETAIL_LIMIT - 1).collect();
    format!("{cut}…")
}

/// A sign as a person reads it: "a correction", "a declined approval".
pub fn kind_name(kind: SignalKind) -> &'static str {
    match kind {
        SignalKind::Correction => "a correction",
        SignalKind::Interrupted => "an interrupted turn",
        SignalKind::Declined => "a declined approval",
        SignalKind::FailedThenPassed => "a command that failed, then passed",
        SignalKind::TurnFailed => "a failed turn",
    }
}

/// One session's signs counted, each kind where it first came: "2
/// corrections and a command that failed, then passed". Empty when there
/// are none.
pub fn summary(signals: &[LearnSignal]) -> String {
    let mut counts: Vec<(SignalKind, usize)> = Vec::new();
    for s in signals {
        match counts.iter_mut().find(|(k, _)| *k == s.kind) {
            Some((_, n)) => *n += 1,
            None => counts.push((s.kind, 1)),
        }
    }
    let parts: Vec<String> = counts
        .into_iter()
        .map(|(kind, n)| if n == 1 { kind_name(kind).to_string() } else { format!("{n} {}", plural_name(kind)) })
        .collect();
    match parts.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A kind's name after a count above one.
fn plural_name(kind: SignalKind) -> &'static str {
    match kind {
        SignalKind::Correction => "corrections",
        SignalKind::Interrupted => "interrupted turns",
        SignalKind::Declined => "declined approvals",
        SignalKind::FailedThenPassed => "commands that failed, then passed",
        SignalKind::TurnFailed => "failed turns",
    }
}

/// A trigger's signs in one line, for a list: "a correction and an
/// interrupted turn in session 01J…".
pub fn describe(signals: &[LearnSignal]) -> String {
    let mut kinds: Vec<&str> = Vec::new();
    for s in signals {
        let name = kind_name(s.kind);
        if !kinds.contains(&name) {
            kinds.push(name);
        }
    }
    let mut sessions: Vec<&str> = signals.iter().map(|s| s.session.as_str()).collect();
    sessions.sort_unstable();
    sessions.dedup();
    let what = match kinds.as_slice() {
        [] => "no signs".to_string(),
        [one] => (*one).to_string(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    format!("{what} in session {}", sessions.join(", "))
}
