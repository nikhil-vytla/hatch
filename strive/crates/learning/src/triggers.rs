//! What a learning session's journal says about automatic runs (ADR-0020):
//! which signs were already acted on, how many runs started lately, whether
//! a run is going, and the latest run that didn't start.

use strive_proto::{Entry, Event, ProposalStatus, SkippedRun};

/// The highest seq of `session`'s signs that an automatic run was started
/// for. Signs at or below it were studied (or are being studied), so a
/// later scan asks only for what came after. A skipped run acts on nothing:
/// its signs are found again next time.
pub fn acted_on(learning: &[Entry], session: &str) -> u64 {
    learning
        .iter()
        .filter_map(|e| match &e.event {
            Event::LearnRequested { trigger: Some(t), .. } => Some(t),
            _ => None,
        })
        .flat_map(|t| t.signals.iter())
        .filter(|s| s.session == session)
        .map(|s| s.seq)
        .max()
        .unwrap_or(0)
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
