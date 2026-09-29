//! Proposals as they stand, folded from a learning session's journal.
//!
//! Status, from the ADR:
//! - a proposal is `checking` until every gate has a verdict, `failed` once
//!   the static gate fails, and `ready` otherwise: the judge's verdict, pass,
//!   fail or skip, is advice a person reads beside the diff;
//! - a person's reject makes it `rejected`;
//! - an accept followed by `proposalApplied` makes it `applied`; an accept
//!   with nothing written (the file had changed) makes it `stale`;
//! - `proposalRolledBack` makes an applied one `rolledBack`.

use strive_proto::{
    Digest, Entry, Event, Gate, GateOutcome, LearnTrigger, ProposalDecision, ProposalState, ProposalStatus, Verdict,
};

/// What an accepted proposal wrote: the file before (none: it didn't
/// exist) and after, and when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    pub before: Option<Digest>,
    pub after: Digest,
    pub at_ms: u64,
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
    // The latest request's trigger: a proposal belongs to the run that was
    // asked for last before it.
    let mut trigger: Option<LearnTrigger> = None;
    for e in entries {
        let find = |out: &mut Vec<(ProposalState, Marks)>, id: u64| out.iter().position(|(s, _)| s.id == id);
        match &e.event {
            Event::LearnRequested { trigger: t, .. } => trigger.clone_from(t),
            Event::ProposalMade { proposal, before, .. } => out.push((
                ProposalState {
                    id: e.seq,
                    made_at_ms: e.ts_ms,
                    proposal: proposal.clone(),
                    before: *before,
                    status: ProposalStatus::Checking,
                    gates: Vec::new(),
                    trigger: trigger.clone(),
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
                    // Listed in the order the checks run, not the order their
                    // verdicts were journaled in.
                    gates.sort_by_key(|g| crate::GATES.iter().position(|x| *x == g.gate));
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
                    out[i].1.applied = Some(Applied { before: *before, after: *after, at_ms: e.ts_ms });
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
            | Event::LearnSkipped { .. }
            | Event::LayoutProposed { .. }
            | Event::Compacted { .. }
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
    } else if gates.iter().any(|g| g.gate == Gate::Static && g.verdict == Verdict::Fail) {
        ProposalStatus::Failed
    } else if crate::GATES.iter().all(|gate| gates.iter().any(|g| g.gate == *gate)) {
        ProposalStatus::Ready
    } else {
        ProposalStatus::Checking
    }
}
