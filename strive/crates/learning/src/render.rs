//! A work session's journal as the judge reads it: one block per thing that
//! happened, each under its entry's seq, within a budget of characters.
//!
//! What a budget can't hold is left out whole, in favor of cited entries
//! first, then the user's prompts, then the rest in journal order. Each gap
//! is marked, so the judge knows what it wasn't shown.

use std::collections::HashMap;

use strive_proto::{Decision, Digest, EffectOutcome, EffectRecord, Entry, Event, TurnEnd};

/// How much of one prompt, reply or output a block holds, in characters.
const PROMPT: usize = 3000;
const REPLY: usize = 2000;
const OUTPUT: usize = 2000;
const READ: usize = 300;
const CHANGE: usize = 400;
/// The least a block cut to fit a budget keeps.
const LEAST: usize = 200;

/// `text` within `max` characters, keeping its start and its end (a
/// command's error is usually at its end) and saying how much was cut.
pub fn cut(text: &str, max: usize) -> String {
    let len = text.chars().count();
    if len <= max {
        return text.to_string();
    }
    let head = max * 2 / 5;
    let tail = max - head;
    let start: String = text.chars().take(head).collect();
    let end: String = text.chars().skip(len - tail).collect();
    format!("{start}\n[... {} characters cut ...]\n{end}", len - max)
}

fn indent(text: &str) -> String {
    text.trim_end().lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")
}

/// Text from the content store; a note in its place if it's gone.
type Blob<'a> = &'a dyn Fn(&Digest) -> Option<String>;

fn blob_text(blob: Blob, d: &Digest) -> String {
    blob(d).unwrap_or_else(|| "[not in the content store]".into())
}

fn record_text(record: &EffectRecord, blob: Blob) -> String {
    match record {
        EffectRecord::Bash { command, .. } => format!("ran `{command}`"),
        EffectRecord::Check { name, command, .. } => format!("ran the check {name}: `{command}`"),
        EffectRecord::Read { path, offset, .. } => match offset {
            Some(o) => format!("read {path} from line {o}"),
            None => format!("read {path}"),
        },
        EffectRecord::Write { path, bytes, .. } => format!("wrote {path} ({bytes} bytes)"),
        EffectRecord::Edit { path, old_text, new_text } => format!(
            "edited {path}\n  - {}\n  + {}",
            cut(&blob_text(blob, old_text), CHANGE).replace('\n', "\n    "),
            cut(&blob_text(blob, new_text), CHANGE).replace('\n', "\n    ")
        ),
        EffectRecord::Mcp { server, tool, arguments } => {
            format!("called {server}'s {tool} {}", cut(&blob_text(blob, arguments), CHANGE))
        }
    }
}

fn outcome_text(record: Option<&EffectRecord>, outcome: &EffectOutcome, blob: Blob) -> String {
    match outcome {
        EffectOutcome::Refused { reason } => format!("refused: {reason}"),
        EffectOutcome::Interrupted => "cut off: the daemon stopped while it ran".into(),
        EffectOutcome::Done { output, exit_code, truncated } => {
            let exit = exit_code.map_or_else(|| "done".to_string(), |c| format!("exit {c}"));
            let max = if matches!(record, Some(EffectRecord::Read { .. })) { READ } else { OUTPUT };
            let output = blob_text(blob, output);
            if output.trim().is_empty() {
                return format!("{exit}, no output");
            }
            let kept = if *truncated { "\n[the daemon kept only part of this output]" } else { "" };
            format!("{exit}\n{}", indent(&format!("{}{kept}", cut(&output, max))))
        }
    }
}

/// One entry's block; empty for entries a reader learns nothing from.
fn block(entry: &Entry, starts: &HashMap<u64, (u64, &EffectRecord)>, blob: Blob) -> String {
    let at = format!("#{}", entry.seq);
    match &entry.event {
        Event::UserMessage { text, command: None } => format!("{at} user: {}", cut(text, PROMPT)),
        Event::UserMessage { command: Some(c), .. } => {
            format!("{at} user ran /{} {}", c.name, cut(&c.arguments, PROMPT))
        }
        Event::AssistantMessage { text, .. } if text.trim().is_empty() => String::new(),
        Event::AssistantMessage { text, .. } => format!("{at} agent: {}", cut(text.trim(), REPLY)),
        Event::EffectStarted { record, .. } => format!("{at} {}", record_text(record, blob)),
        Event::RuleLoaded { name, file, .. } => format!("{at} strive gave the agent the rule {name} ({file})"),
        Event::ChecksReported { text, .. } => {
            format!("{at} strive told the agent its checks failed: {}", cut(text, REPLY))
        }
        Event::EffectFinished { effect, outcome, .. } => {
            let start = starts.get(effect);
            let of = start.map_or_else(|| format!("effect {effect}"), |(seq, _)| format!("#{seq}"));
            format!("{at} result of {of}: {}", outcome_text(start.map(|(_, r)| *r), outcome, blob))
        }
        Event::ApprovalRequested { description, .. } => format!("{at} asked for approval: {description}"),
        Event::ApprovalDecided { decision, by, .. } => {
            let d = match decision {
                Decision::Allow => "approved",
                Decision::AllowSession => "approved for the session",
                Decision::Deny => "declined",
            };
            format!("{at} {d} by {by}")
        }
        Event::TurnEnded { turn, reason } => match reason {
            TurnEnd::Done => format!("{at} turn {turn} done"),
            TurnEnd::Interrupted => format!("{at} turn {turn} interrupted by the user"),
            TurnEnd::TimedOut { seconds } => format!("{at} turn {turn} stopped at its {seconds}s time limit"),
            TurnEnd::Failed { error } => format!("{at} turn {turn} failed: {error}"),
        },
        Event::Rewound { to, .. } => format!("{at} rewound the files to checkpoint {to}"),
        Event::Compacted { upto_seq, summary } => {
            format!("{at} the conversation up to #{upto_seq} was summarized: {}", cut(summary, REPLY))
        }
        Event::ContextLoaded { instructions, skills, .. } => {
            let files: Vec<&str> = instructions.iter().map(|f| f.path.as_str()).collect();
            let files = if files.is_empty() { "no instruction files".to_string() } else { files.join(", ") };
            let skills = if skills.is_empty() { "none".to_string() } else { skills.join(", ") };
            format!("{at} loaded {files}; skills: {skills}")
        }
        Event::SessionStarted { .. }
        | Event::Recovered { .. }
        | Event::BudgetSet { .. }
        | Event::ModelCallStarted { .. }
        | Event::ModelCallFinished { .. }
        | Event::ApprovalModeSet { .. }
        | Event::Checkpointed { .. }
        | Event::TurnStarted { .. }
        | Event::LearnRequested { .. }
        | Event::LearnSkipped { .. }
        | Event::LearnDismissed { .. }
        | Event::ProposalMade { .. }
        | Event::GateFinished { .. }
        | Event::ProposalDecided { .. }
        | Event::ProposalApplied { .. }
        | Event::ProposalRolledBack { .. }
        | Event::LayoutProposed { .. }
        | Event::ModelSet { .. } => String::new(),
    }
}

/// A session's entries within `budget` characters. Entries whose seq is in
/// `cited` (and the other half of a cited effect) are kept first, then the
/// user's prompts, then the rest from the start.
pub fn render(entries: &[Entry], cited: &[u64], budget: usize, blob: Blob) -> String {
    let mut starts: HashMap<u64, (u64, &EffectRecord)> = HashMap::new();
    let mut ends: HashMap<u64, u64> = HashMap::new();
    for e in entries {
        match &e.event {
            Event::EffectStarted { effect, record, .. } => {
                starts.insert(*effect, (e.seq, record));
            }
            Event::EffectFinished { effect, .. } => {
                ends.insert(*effect, e.seq);
            }
            _ => {}
        }
    }
    // An effect's start and end are one thing: citing either keeps both.
    let is_cited = |e: &Entry| {
        cited.contains(&e.seq)
            || match &e.event {
                Event::EffectStarted { effect, .. } => ends.get(effect).is_some_and(|s| cited.contains(s)),
                Event::EffectFinished { effect, .. } => starts.get(effect).is_some_and(|(s, _)| cited.contains(s)),
                _ => false,
            }
    };
    let blocks: Vec<(u64, u8, String)> = entries
        .iter()
        .map(|e| {
            let rank = if is_cited(e) { 2 } else { u8::from(matches!(e.event, Event::UserMessage { .. })) };
            (e.seq, rank, block(e, &starts, blob))
        })
        .filter(|(_, _, text)| !text.is_empty())
        .collect();
    let mut order: Vec<usize> = (0..blocks.len()).collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(blocks[i].1), blocks[i].0));
    let mut kept: Vec<Option<String>> = vec![None; blocks.len()];
    let mut left = budget;
    for i in order {
        let text = &blocks[i].2;
        let len = text.chars().count() + 1;
        if len <= left {
            kept[i] = Some(text.clone());
            left -= len;
        } else if blocks[i].1 == 2 && left >= LEAST {
            // A cited entry too long for what's left is cut to fit, not dropped.
            kept[i] = Some(cut(text, left.saturating_sub(40).max(LEAST)));
            left = 0;
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut gap: Option<(u64, u64)> = None;
    for (i, (seq, _, _)) in blocks.iter().enumerate() {
        match kept[i].take() {
            Some(text) => {
                if let Some((from, to)) = gap.take() {
                    out.push(left_out(from, to));
                }
                out.push(text);
            }
            None => gap = Some(gap.map_or((*seq, *seq), |(from, _)| (from, *seq))),
        }
    }
    if let Some((from, to)) = gap {
        out.push(left_out(from, to));
    }
    if out.is_empty() {
        return "[nothing to show]".into();
    }
    out.join("\n")
}

fn left_out(from: u64, to: u64) -> String {
    if from == to { format!("[#{from} left out]") } else { format!("[#{from} to #{to} left out]") }
}
