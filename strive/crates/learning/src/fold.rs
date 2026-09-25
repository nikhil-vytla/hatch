//! Proposals as they stand, folded from a learning session's journal.
//!
//! Status, from the ADR:
//! - a proposal is `checking` until every gate has a verdict, `failed` once
//!   any gate fails, and `ready` when every gate passed or was skipped;
//! - a person's reject makes it `rejected`;
//! - an accept followed by `proposalApplied` makes it `applied`; an accept
//!   with nothing written (the file had changed) makes it `stale`;
//! - `proposalRolledBack` makes an applied one `rolledBack`.

use strive_proto::{Digest, Entry, Event, GateOutcome, ProposalDecision, ProposalState, ProposalStatus, Verdict};

/// What an accepted proposal wrote: the file before (none: it didn't
/// exist) and after.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    pub before: Option<Digest>,
    pub after: Digest,
}

/// A proposal's state, plus what rolling it back needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folded {
    pub state: ProposalState,
    /// Set while it's applied (not after a rollback).
    pub applied: Option<Applied>,
}

#[derive(Default)]
struct Marks {
    accepted: bool,
    rejected: bool,
    applied: Option<Applied>,
    rolled_back: bool,
}

/// Every proposal in the journal, oldest first.
pub fn fold(entries: &[Entry]) -> Vec<Folded> {
    let mut out: Vec<(ProposalState, Marks)> = Vec::new();
    for e in entries {
        let find = |out: &mut Vec<(ProposalState, Marks)>, id: u64| out.iter_mut().position(|(s, _)| s.id == id);
        match &e.event {
            Event::ProposalMade { proposal, before, .. } => out.push((
                ProposalState {
                    id: e.seq,
                    made_at_ms: e.ts_ms,
                    proposal: proposal.clone(),
                    before: *before,
                    status: ProposalStatus::Checking,
                    gates: Vec::new(),
                },
                Marks::default(),
            )),
            Event::GateFinished { proposal, gate, verdict, detail } => {
                if let Some(i) = find(&mut out, *proposal) {
                    let gates = &mut out[i].0.gates;
                    // A gate run again (after a restart cut the first run
                    // short, say) replaces its earlier outcome.
                    gates.retain(|g| g.gate != *gate);
                    gates.push(GateOutcome { gate: *gate, verdict: *verdict, detail: detail.clone() });
                }
            }
            Event::ProposalDecided { proposal, decision, .. } => {
                if let Some(i) = find(&mut out, *proposal) {
                    match decision {
                        ProposalDecision::Accept => out[i].1.accepted = true,
                        ProposalDecision::Reject => out[i].1.rejected = true,
                    }
                }
            }
            Event::ProposalApplied { proposal, before, after } => {
                if let Some(i) = find(&mut out, *proposal) {
                    out[i].1.applied = Some(Applied { before: *before, after: *after });
                }
            }
            Event::ProposalRolledBack { proposal, .. } => {
                if let Some(i) = find(&mut out, *proposal) {
                    out[i].1.rolled_back = true;
                }
            }
            Event::SessionStarted { .. }
            | Event::UserMessage { .. }
            | Event::Recovered { .. }
            | Event::BudgetSet { .. }
            | Event::ModelCallStarted { .. }
            | Event::ModelCallFinished { .. }
            | Event::EffectStarted { .. }
            | Event::EffectFinished { .. }
            | Event::ApprovalModeSet { .. }
            | Event::ApprovalRequested { .. }
            | Event::ApprovalDecided { .. }
            | Event::Checkpointed { .. }
            | Event::Rewound { .. }
            | Event::TurnStarted { .. }
            | Event::AssistantMessage { .. }
            | Event::TurnEnded { .. }
            | Event::ContextLoaded { .. }
            | Event::LearnRequested { .. }
            | Event::LayoutProposed { .. }
            | Event::Compacted { .. }
            | Event::ReplayStarted { .. }
            | Event::ReplayFinished { .. }
            | Event::ModelSet { .. } => {}
        }
    }
    out.into_iter()
        .map(|(mut state, marks)| {
            state.status = status(&state.gates, &marks);
            let applied = if marks.rolled_back { None } else { marks.applied };
            Folded { state, applied }
        })
        .collect()
}

fn status(gates: &[GateOutcome], marks: &Marks) -> ProposalStatus {
    if marks.rolled_back {
        ProposalStatus::RolledBack
    } else if marks.applied.is_some() {
        ProposalStatus::Applied
    } else if marks.accepted {
        ProposalStatus::Stale
    } else if marks.rejected {
        ProposalStatus::Rejected
    } else if gates.iter().any(|g| g.verdict == Verdict::Fail) {
        ProposalStatus::Failed
    } else if crate::GATES.iter().all(|gate| gates.iter().any(|g| g.gate == *gate)) {
        ProposalStatus::Ready
    } else {
        ProposalStatus::Checking
    }
}
