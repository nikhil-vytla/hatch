//! Proposal status, folded from a learning journal.

use strive_learning::{Applied, fold};
use strive_proto::{Artifact, Digest, Entry, Event, Gate, Proposal, ProposalDecision, ProposalStatus, Verdict};

fn proposal(summary: &str) -> Proposal {
    Proposal {
        artifact: Artifact::Memory,
        content: "m".into(),
        summary: summary.into(),
        rationale: "r".into(),
        evidence: vec![],
        prediction: "p".into(),
        watch: None,
    }
}

fn digest(b: u8) -> Digest {
    Digest::from_bytes([b; 32])
}

/// A journal from events, numbered from 1 with times 1000 apart.
fn journal(events: Vec<Event>) -> Vec<Entry> {
    events.into_iter().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: seq * 1000, event }).collect()
}

fn made(summary: &str, before: Option<Digest>) -> Event {
    Event::ProposalMade { call_id: None, proposal: proposal(summary), before, mode: None }
}

fn gate(proposal: u64, gate: Gate, verdict: Verdict) -> Event {
    Event::GateFinished { proposal, gate, verdict, detail: format!("{gate:?}") }
}

fn passed(proposal: u64) -> Vec<Event> {
    vec![
        gate(proposal, Gate::Static, Verdict::Pass),
        gate(proposal, Gate::Judge, Verdict::Skipped),
        gate(proposal, Gate::Replay, Verdict::Skipped),
    ]
}

fn decided(proposal: u64, decision: ProposalDecision) -> Event {
    Event::ProposalDecided { proposal, decision, by: "test".into(), automatic: None }
}

fn statuses(events: Vec<Event>) -> Vec<(u64, ProposalStatus)> {
    fold(&journal(events)).into_iter().map(|f| (f.state.id, f.state.status)).collect()
}

fn started() -> Event {
    Event::SessionStarted { format: 1, cwd: "/p".into(), strive_version: "0".into(), kind: None }
}

#[test]
fn a_proposal_is_identified_by_its_entry_and_keeps_what_was_proposed() {
    let folded = fold(&journal(vec![started(), made("first", Some(digest(1))), made("second", None)]));
    assert_eq!(folded.len(), 2);
    assert_eq!((folded[0].state.id, folded[0].state.made_at_ms), (2, 2000));
    assert_eq!(folded[0].state.proposal.summary, "first");
    assert_eq!(folded[0].state.before, Some(digest(1)));
    assert_eq!((folded[1].state.id, folded[1].state.before), (3, None));
}

#[test]
fn a_proposal_is_checking_until_every_gate_has_a_verdict() {
    let mut events = vec![started(), made("m", None)];
    assert_eq!(statuses(events.clone()), vec![(2, ProposalStatus::Checking)]);
    events.push(gate(2, Gate::Static, Verdict::Pass));
    events.push(gate(2, Gate::Judge, Verdict::Skipped));
    assert_eq!(statuses(events.clone()), vec![(2, ProposalStatus::Checking)], "replay has no verdict yet");
    events.push(gate(2, Gate::Replay, Verdict::Skipped));
    assert_eq!(statuses(events), vec![(2, ProposalStatus::Ready)]);
}

#[test]
fn any_failed_gate_fails_it_even_before_the_rest_finish() {
    let events = vec![started(), made("m", None), gate(2, Gate::Static, Verdict::Fail)];
    assert_eq!(statuses(events), vec![(2, ProposalStatus::Failed)]);
    let mut events = vec![started(), made("m", None)];
    events.extend(passed(2));
    events.push(gate(2, Gate::Judge, Verdict::Fail));
    assert_eq!(statuses(events), vec![(2, ProposalStatus::Failed)], "a gate run again replaces its outcome");
}

#[test]
fn a_gate_run_again_replaces_the_earlier_outcome() {
    let mut events = vec![started(), made("m", None), gate(2, Gate::Static, Verdict::Fail)];
    events.extend(passed(2));
    let folded = fold(&journal(events));
    assert_eq!(folded[0].state.status, ProposalStatus::Ready);
    assert_eq!(folded[0].state.gates.len(), 3);
}

#[test]
fn decisions_and_writes_set_the_status() {
    let mut events = vec![started(), made("a", None), made("b", None), made("c", None), made("d", None)];
    for id in 2..=5 {
        events.extend(passed(id));
    }
    events.push(decided(2, ProposalDecision::Reject));
    events.push(decided(3, ProposalDecision::Accept));
    events.push(decided(4, ProposalDecision::Accept));
    events.push(Event::ProposalApplied { proposal: 4, before: None, after: digest(4) });
    let applied_at = events.len() as u64 * 1000;
    events.push(decided(5, ProposalDecision::Accept));
    events.push(Event::ProposalApplied { proposal: 5, before: Some(digest(1)), after: digest(5) });
    events.push(Event::ProposalRolledBack { proposal: 5, by: "test".into() });
    let folded = fold(&journal(events));
    let got: Vec<(u64, ProposalStatus, Option<Applied>)> =
        folded.iter().map(|f| (f.state.id, f.state.status, f.applied)).collect();
    assert_eq!(
        got,
        vec![
            (2, ProposalStatus::Rejected, None),
            (3, ProposalStatus::Stale, None),
            (4, ProposalStatus::Applied, Some(Applied { before: None, after: digest(4), at_ms: applied_at })),
            (5, ProposalStatus::RolledBack, None),
        ]
    );
}

/// What a person undid for a file is what the judge is shown and what the
/// `gated` mode won't accept again: only rolled-back proposals, and only
/// those for the same file.
#[test]
fn rolled_back_lists_what_was_undone_for_the_same_file_only() {
    let skill = |summary: &str| Event::ProposalMade {
        call_id: None,
        proposal: Proposal { artifact: Artifact::Skill { name: "release".into() }, ..proposal(summary) },
        before: None,
        mode: None,
    };
    let mut events = vec![started(), made("undone", None), made("kept", None), skill("other file"), made("open", None)];
    for id in 2..=5 {
        events.extend(passed(id));
    }
    for id in 2..=4 {
        events.push(decided(id, ProposalDecision::Accept));
        events.push(Event::ProposalApplied { proposal: id, before: None, after: digest(9) });
    }
    events.push(Event::ProposalRolledBack { proposal: 2, by: "test".into() });
    events.push(Event::ProposalRolledBack { proposal: 4, by: "test".into() });
    let folded = fold(&journal(events));
    let undone: Vec<&str> =
        strive_learning::rolled_back(&folded, &Artifact::Memory).iter().map(|s| s.proposal.summary.as_str()).collect();
    assert_eq!(undone, vec!["undone"]);
    let skill = Artifact::Skill { name: "release".into() };
    let undone: Vec<&str> =
        strive_learning::rolled_back(&folded, &skill).iter().map(|s| s.proposal.summary.as_str()).collect();
    assert_eq!(undone, vec!["other file"]);
}

/// A person reads the status the protocol names, as words: the desktop app
/// and the CLI show the same thing for one proposal.
#[test]
fn a_status_reads_as_its_wire_name_in_words() {
    use ProposalStatus::{Applied, Checking, Failed, Ready, Rejected, RolledBack, Stale};
    for status in [Checking, Ready, Failed, Rejected, Applied, Stale, RolledBack] {
        let wire = serde_json::to_value(status).unwrap();
        let words = wire.as_str().unwrap().chars().fold(String::new(), |mut out, c| {
            if c.is_ascii_uppercase() {
                out.push(' ');
            }
            out.push(c.to_ascii_lowercase());
            out
        });
        assert_eq!(strive_learning::status_name(status), words, "{status:?}");
    }
}

#[test]
fn records_about_unknown_proposals_change_nothing() {
    let mut events = vec![started(), made("m", None)];
    events.extend(passed(2));
    events.push(gate(9, Gate::Static, Verdict::Fail));
    events.push(decided(9, ProposalDecision::Reject));
    events.push(Event::ProposalApplied { proposal: 9, before: None, after: digest(9) });
    events.push(Event::ProposalRolledBack { proposal: 9, by: "test".into() });
    let folded = fold(&journal(events));
    assert_eq!(folded.len(), 1);
    assert_eq!((folded[0].state.status, folded[0].applied), (ProposalStatus::Ready, None));
    assert_eq!(folded[0].state.gates.len(), 3);
}

/// Checks are listed in the order they run, whatever order their verdicts
/// were journaled in (a replay skip can be journaled before the judge's).
#[test]
fn gates_are_listed_in_the_order_they_run() {
    let events = vec![
        started(),
        made("m", None),
        gate(2, Gate::Replay, Verdict::Skipped),
        gate(2, Gate::Static, Verdict::Pass),
        gate(2, Gate::Judge, Verdict::Pass),
    ];
    let folded = fold(&journal(events));
    let order: Vec<Gate> = folded[0].state.gates.iter().map(|g| g.gate).collect();
    assert_eq!(order, vec![Gate::Static, Gate::Judge, Gate::Replay]);
}
