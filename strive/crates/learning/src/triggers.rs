//! What a learning session's journal says about automatic runs (ADR-0020):
//! which signs were already acted on, how many runs started lately, whether
//! a run is going, and the latest run that didn't start.

use strive_proto::{CallOutcome, Entry, Event, ProposalStatus, SkippedRun, TriggerKind};

/// The highest seq of `session`'s signs that were dealt with: a run was
/// asked for them, by a trigger or by a person, or a person dismissed the
/// offer to learn from them. Signs at or below it were studied (or are
/// being studied, or aren't wanted), so a later scan or offer looks only
/// past it. A skipped run acts on nothing: its signs are found again next
/// time.
pub fn acted_on(learning: &[Entry], session: &str) -> u64 {
    let mut mark = 0;
    for e in learning {
        let seqs: Vec<u64> = match &e.event {
            Event::LearnRequested { trigger, signals, .. } => trigger
                .iter()
                .flat_map(|t| t.signals.iter())
                .chain(signals.iter().flatten())
                .filter(|s| s.session == session)
                .map(|s| s.seq)
                .collect(),
            Event::LearnDismissed { session: s, through } if s == session => vec![*through],
            _ => Vec::new(),
        };
        mark = seqs.into_iter().fold(mark, u64::max);
    }
    mark
}

/// What a learner run has cost in this project on average: everything the
/// learning session spent (the learner's calls and the judge's) over the
/// turns that called a model. None before the first such turn.
pub fn cost_per_run(learning: &[Entry]) -> Option<u64> {
    let (mut spent, mut runs, mut in_turn, mut called) = (0u64, 0u64, false, false);
    for e in learning {
        match &e.event {
            Event::TurnStarted { .. } => (in_turn, called) = (true, false),
            Event::ModelCallStarted { .. } => called |= in_turn,
            Event::ModelCallFinished { outcome, .. } => spent = spent.saturating_add(charged(outcome)),
            Event::TurnEnded { .. } => {
                runs += u64::from(in_turn && called);
                in_turn = false;
            }
            _ => {}
        }
    }
    (runs > 0).then(|| spent.div_ceil(runs))
}

/// What a finished call was charged: `Broken` is charged its reservation.
fn charged(outcome: &CallOutcome) -> u64 {
    match outcome {
        CallOutcome::Complete { cost_usd_micros, .. } | CallOutcome::Broken { cost_usd_micros, .. } => *cost_usd_micros,
        CallOutcome::Rejected { .. } => 0,
    }
}

/// Automatic runs requested at or after `since_ms`.
pub fn automatic_since(learning: &[Entry], since_ms: u64) -> usize {
    learning
        .iter()
        .filter(|e| e.ts_ms >= since_ms && matches!(e.event, Event::LearnRequested { trigger: Some(_), .. }))
        .count()
}

/// `busy`'s reason while a request no turn has finished is in the journal.
pub const RUN_GOING: &str = "a learner run is still going";
/// `busy`'s reason while a proposal is `checking`.
pub const CHECKS_GOING: &str = "a proposal's checks are still going";

/// Why an automatic run shouldn't start now, if it shouldn't: a request
/// that no turn has finished, or a proposal whose checks haven't.
pub fn busy(learning: &[Entry]) -> Option<&'static str> {
    // A request is finished once a turn that took it (`throughSeq` at or
    // past it, so journaled after it) has ended.
    let asked = learning.iter().rev().find(|e| matches!(e.event, Event::LearnRequested { .. })).map(|e| e.seq);
    if let Some(asked) = asked {
        let mut taking: Option<u64> = None;
        let mut done = false;
        for e in learning.iter().filter(|e| e.seq > asked) {
            match &e.event {
                Event::TurnStarted { turn, through_seq } if through_seq.unwrap_or(e.seq) >= asked => {
                    taking = Some(*turn);
                }
                Event::TurnEnded { turn, .. } if Some(*turn) == taking => done = true,
                _ => {}
            }
        }
        if !done {
            return Some(RUN_GOING);
        }
    }
    if crate::fold(learning).iter().any(|f| f.state.status == ProposalStatus::Checking) {
        return Some(CHECKS_GOING);
    }
    None
}

/// Sessions whose scan found signs while a run or checks were going, to scan
/// again once nothing is: each one's latest skip was for being busy, and no
/// automatic request named it since. Oldest skip first, with its trigger's
/// kind. A skip for another reason (the daily cap, no key) isn't retried: the
/// session's next idle scan finds its signs again.
pub fn waiting(learning: &[Entry]) -> Vec<(String, TriggerKind)> {
    let mut latest: Vec<(String, Option<TriggerKind>)> = Vec::new();
    let mut set = |session: &str, retry: Option<TriggerKind>| {
        latest.retain(|(s, _)| s != session);
        latest.push((session.to_string(), retry));
    };
    for e in learning {
        match &e.event {
            Event::LearnRequested { trigger: Some(t), .. } => {
                for s in &t.signals {
                    set(&s.session, None);
                }
            }
            Event::LearnSkipped { trigger, reason } => {
                let busy = reason == RUN_GOING || reason == CHECKS_GOING;
                for s in &trigger.signals {
                    set(&s.session, busy.then_some(trigger.kind));
                }
            }
            _ => {}
        }
    }
    latest.into_iter().filter_map(|(s, retry)| Some((s, retry?))).collect()
}

/// The latest automatic run that didn't start, unless one started after it.
pub fn skipped(learning: &[Entry]) -> Option<SkippedRun> {
    for e in learning.iter().rev() {
        match &e.event {
            Event::LearnRequested { trigger: Some(_), .. } => return None,
            Event::LearnSkipped { trigger, reason } => {
                return Some(SkippedRun { at_ms: e.ts_ms, reason: reason.clone(), trigger: trigger.clone() });
            }
            _ => {}
        }
    }
    None
}
