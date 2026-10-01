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
//!
//! An applied proposal is `replaced_by` a later one that changed what it
//! wrote, until that one is rolled back:
//! - a memory proposal, by a later change or remove of its bullet (the
//!   bullet's source names it); a proposal for another bullet never does;
//! - a skill, by a later proposal for the same skill, until that one is
//!   rolled back to its content.

use std::collections::HashMap;

use strive_proto::{
    BulletEdit, Change, Digest, Entry, Event, Gate, GateOutcome, LearnSignal, LearnTrigger, ProposalDecision,
    ProposalState, ProposalStatus, Verdict,
};

/// What an accepted proposal wrote: the file before (none: it didn't
/// exist) and after, what it did to its bullet for memory, and when.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Applied {
    pub before: Option<Digest>,
    pub after: Digest,
    pub bullet: Option<BulletEdit>,
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
    // The signs of the latest request, when it was a yes to the offer.
    let mut offered: Option<Vec<LearnSignal>> = None;
    let mut live = Live::default();
    for e in entries {
        let find = |out: &mut Vec<(ProposalState, Marks)>, id: u64| out.iter().position(|(s, _)| s.id == id);
        match &e.event {
            Event::LearnRequested { trigger: t, signals, offer, .. } => {
                trigger.clone_from(t);
                offered = offer.unwrap_or(false).then(|| signals.clone().unwrap_or_default());
            }
            Event::ProposalMade { proposal, before, .. } => out.push((
                ProposalState {
                    id: e.seq,
                    made_at_ms: e.ts_ms,
                    proposal: proposal.clone(),
                    before: *before,
                    bullet: None,
                    status: ProposalStatus::Checking,
                    gates: Vec::new(),
                    trigger: trigger.clone(),
                    offered: offered.clone(),
                    replaced_by: None,
                    can_roll_back: false,
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
                    gates.sort_by_key(|g| crate::ORDER.iter().position(|x| *x == g.gate));
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
            Event::ProposalApplied { proposal, before, after, bullet } => {
                if let Some(i) = find(&mut out, *proposal) {
                    let applied = Applied { before: *before, after: *after, bullet: bullet.clone(), at_ms: e.ts_ms };
                    out[i].1.applied = Some(applied);
                    // What it did stays its diff, rolled back or not.
                    out[i].0.bullet.clone_from(bullet);
                    live.applied(&mut out, i);
                }
            }
            Event::ProposalRolledBack { proposal, .. } => {
                if let Some(i) = find(&mut out, *proposal) {
                    out[i].1.rolled_back = true;
                    live.rolled_back(&mut out, i);
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
            | Event::LearnDismissed { .. }
            | Event::LayoutProposed { .. }
            | Event::ChecksReported { .. }
            | Event::RuleLoaded { .. }
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

/// Per skill file, the applied proposal whose content it last had: what
/// marks one skill proposal replaced by another.
#[derive(Default)]
struct Live(HashMap<String, u64>);

impl Live {
    /// `out[i]` was applied: over the bullet its change or remove names
    /// (memory), or over whatever applied proposal its file had (a skill).
    fn applied(&mut self, out: &mut [(ProposalState, Marks)], i: usize) {
        let id = out[i].0.id;
        let old = match (&out[i].0.proposal.change, out[i].1.applied.as_ref().and_then(|a| a.bullet.as_ref())) {
            // A line can name any number; only an applied proposal's bullet is replaced.
            (Change::Memory(_), Some(BulletEdit::Changed { old: line, .. } | BulletEdit::Removed { line, .. })) => {
                crate::memory::source(line)
                    .filter(|s| out.iter().any(|(p, m)| p.id == *s && m.applied.is_some() && !m.rolled_back))
            }
            (Change::Memory(_), Some(BulletEdit::Added { .. }) | None) => None,
            (
                Change::Skill { .. }
                | Change::Check { .. }
                | Change::Command { .. }
                | Change::Rule { .. }
                | Change::Extension { .. },
                _,
            ) => {
                let Ok(path) = crate::relative_path(&out[i].0.proposal.change.artifact()) else { return };
                self.0.insert(path, id)
            }
        };
        if let Some(old) = old
            && let Some(j) = out.iter().position(|(s, _)| s.id == old && old != id)
        {
            out[j].0.replaced_by = Some(id);
        }
    }

    /// `out[i]` was rolled back: the memory proposal whose bullet it
    /// changed has it back; the skill proposal it replaced is back if the
    /// rollback restored that one's content.
    fn rolled_back(&mut self, out: &mut [(ProposalState, Marks)], i: usize) {
        let id = out[i].0.id;
        if let Change::Memory(_) = out[i].0.proposal.change {
            for (s, _) in out.iter_mut().filter(|(s, m)| s.replaced_by == Some(id) && !m.rolled_back) {
                s.replaced_by = None;
            }
            return;
        }
        let before = out[i].1.applied.as_ref().and_then(|a| a.before);
        let Ok(path) = crate::relative_path(&out[i].0.proposal.change.artifact()) else { return };
        let back = out.iter().position(|(s, m)| {
            s.replaced_by == Some(id) && !m.rolled_back && m.applied.as_ref().map(|a| Some(a.after)) == Some(before)
        });
        match back {
            Some(j) => {
                out[j].0.replaced_by = None;
                self.0.insert(path, out[j].0.id);
            }
            None if self.0.get(&path) == Some(&id) => {
                self.0.remove(&path);
            }
            None => {}
        }
    }
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
    } else if gates.iter().any(|g| matches!(g.gate, Gate::Static | Gate::Tests) && g.verdict == Verdict::Fail) {
        ProposalStatus::Failed
    } else if crate::GATES.iter().all(|gate| gates.iter().any(|g| g.gate == *gate)) {
        ProposalStatus::Ready
    } else {
        ProposalStatus::Checking
    }
}
