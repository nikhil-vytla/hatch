//! How memory bullets fare in use: which ones a session was given, which the
//! agent cited (`[uses m42]`), and what followed a cite. Cites are the
//! agent's own word, so they're shown beside what the daemon saw happen
//! after them, never alone.

use std::collections::{BTreeMap, BTreeSet};

use strive_proto::{BulletUsage, Entry, Event, TurnEnd, UsageNote};

/// The latest troubles kept per bullet.
const NOTES: usize = 5;

/// The bullets memory names as `[mN]`, as sessions are given it, under any
/// list marker.
pub fn given(memory: &str) -> BTreeSet<u64> {
    memory
        .lines()
        .filter_map(|l| {
            let item = ["- ", "* ", "+ "].iter().find_map(|m| l.trim_start().strip_prefix(m))?;
            item.strip_prefix("[m")?.split_once(']')?.0.parse().ok()
        })
        .collect()
}

/// The bullets a reply cites: every `mN` inside a `[uses ...]`.
pub fn cited(text: &str) -> BTreeSet<u64> {
    let mut out = BTreeSet::new();
    let mut rest = text;
    while let Some(at) = rest.find("[uses ") {
        let after = &rest[at + "[uses ".len()..];
        let Some(end) = after.find(']') else { break };
        for word in after[..end].split(|c: char| c == ',' || c.is_whitespace()) {
            if let Some(n) = word.strip_prefix('m').and_then(|n| n.parse().ok()) {
                out.insert(n);
            }
        }
        rest = &after[end..];
    }
    out
}

/// Adds one work session's use of the bullets it was given to `out`.
pub fn tally(session: &str, entries: &[Entry], given: &BTreeSet<u64>, out: &mut BTreeMap<u64, BulletUsage>) {
    for &bullet in given {
        let u = out.entry(bullet).or_insert_with(|| BulletUsage {
            bullet,
            sessions: 0,
            cited: 0,
            clean: 0,
            trouble: 0,
            last_cited_ms: None,
            notes: Vec::new(),
        });
        u.sessions += 1;
    }
    // Bullets cited since the last prompt, when, and the first trouble after.
    let mut cites: BTreeMap<u64, u64> = BTreeMap::new();
    let mut trouble: Option<(u64, u64, String)> = None;
    let mut ended = false;
    let note = |trouble: &mut Option<(u64, u64, String)>, e: &Entry, what: String| {
        if trouble.is_none() {
            *trouble = Some((e.seq, e.ts_ms, what));
        }
    };
    for e in entries {
        match &e.event {
            Event::UserMessage { text, command } => {
                // The first prompt after a turn: a correction is trouble for what that turn cited.
                let typed = command.as_ref().map_or(text.as_str(), |c| c.arguments.as_str());
                if ended && crate::signals::is_correction(typed) {
                    note(&mut trouble, e, format!("the user corrected it: {}", excerpt(typed)));
                }
                settle(session, &mut cites, &mut trouble, ended, out);
                ended = false;
            }
            Event::AssistantMessage { text, .. } => {
                for b in cited(text).into_iter().filter(|b| given.contains(b)) {
                    cites.entry(b).or_insert(e.ts_ms);
                }
            }
            Event::ApprovalDecided { decision: strive_proto::Decision::Deny, .. } => {
                note(&mut trouble, e, "the user declined an approval".into());
            }
            Event::Rewound { to, .. } => {
                note(&mut trouble, e, format!("the files were rewound to checkpoint {to}"));
            }
            Event::ChecksReported { text, .. } => {
                note(&mut trouble, e, format!("a check failed: {}", excerpt(text.lines().nth(2).unwrap_or(text))));
            }
            Event::TurnEnded { turn, reason } => {
                ended = true;
                match reason {
                    TurnEnd::Done => {}
                    TurnEnd::Interrupted => note(&mut trouble, e, format!("turn {turn} was interrupted")),
                    TurnEnd::TimedOut { .. } => note(&mut trouble, e, format!("turn {turn} ran out of time")),
                    TurnEnd::Failed { .. } => note(&mut trouble, e, format!("turn {turn} failed")),
                }
            }
            _ => {}
        }
    }
    settle(session, &mut cites, &mut trouble, ended, out);
}

/// Counts the cites since the last prompt as clean or troubled, if their
/// turn ended; a turn cut off with the session counts as neither.
fn settle(
    session: &str,
    cites: &mut BTreeMap<u64, u64>,
    trouble: &mut Option<(u64, u64, String)>,
    ended: bool,
    out: &mut BTreeMap<u64, BulletUsage>,
) {
    for (b, at) in std::mem::take(cites) {
        let Some(u) = out.get_mut(&b) else { continue };
        if !ended && trouble.is_none() {
            continue;
        }
        u.cited += 1;
        u.last_cited_ms = u.last_cited_ms.max(Some(at));
        match trouble {
            None => u.clean += 1,
            Some((seq, at_ms, what)) => {
                u.trouble += 1;
                u.notes.push(UsageNote { session: session.to_string(), seq: *seq, at_ms: *at_ms, what: what.clone() });
                // Latest last, whichever order sessions are tallied in.
                u.notes.sort_by_key(|n| n.at_ms);
                if u.notes.len() > NOTES {
                    u.notes.remove(0);
                }
            }
        }
    }
    *trouble = None;
}

fn excerpt(text: &str) -> String {
    let line = text.lines().next().unwrap_or_default().trim();
    if line.chars().count() > 120 {
        format!("{}…", line.chars().take(119).collect::<String>())
    } else {
        line.to_string()
    }
}
