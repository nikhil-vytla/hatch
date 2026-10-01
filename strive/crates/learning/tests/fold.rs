//! Proposal status, folded from a learning journal.

use strive_learning::{Applied, fold};
use strive_proto::{
    Artifact, BulletEdit, Change, Digest, Entry, Event, Gate, MemoryOp, Proposal, ProposalDecision, ProposalStatus,
    Verdict,
};

/// A proposal for the skill `notes`, which changes whole.
fn proposal(summary: &str) -> Proposal {
    Proposal {
        change: Change::Skill { name: "notes".into(), content: "m".into() },
        summary: summary.into(),
        rationale: "r".into(),
        evidence: vec![],
        prediction: "p".into(),
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
    Event::ProposalMade { call_id: None, proposal: proposal(summary), before }
}

fn gate(proposal: u64, gate: Gate, verdict: Verdict) -> Event {
    Event::GateFinished { proposal, gate, verdict, detail: format!("{gate:?}") }
}

fn passed(proposal: u64) -> Vec<Event> {
    vec![gate(proposal, Gate::Static, Verdict::Pass), gate(proposal, Gate::Judge, Verdict::Skipped)]
}

fn decided(proposal: u64, decision: ProposalDecision) -> Event {
    Event::ProposalDecided { proposal, decision, by: "test".into() }
}

fn statuses(events: Vec<Event>) -> Vec<(u64, ProposalStatus)> {
    fold(&journal(events)).into_iter().map(|f| (f.state.id, f.state.status)).collect()
}

fn started() -> Event {
    Event::SessionStarted { format: 1, cwd: "/p".into(), strive_version: "0".into(), kind: None, safe: false }
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
    assert_eq!(statuses(events.clone()), vec![(2, ProposalStatus::Checking)], "the judge has no verdict yet");
    events.push(gate(2, Gate::Judge, Verdict::Skipped));
    assert_eq!(statuses(events), vec![(2, ProposalStatus::Ready)]);
}

#[test]
fn a_static_fail_fails_it_at_once_and_a_judge_fail_leaves_it_ready() {
    let events = vec![started(), made("m", None), gate(2, Gate::Static, Verdict::Fail)];
    assert_eq!(statuses(events), vec![(2, ProposalStatus::Failed)], "before the judge has a verdict");
    let mut events = vec![started(), made("m", None)];
    events.extend(passed(2));
    events.push(gate(2, Gate::Judge, Verdict::Fail));
    assert_eq!(statuses(events), vec![(2, ProposalStatus::Ready)], "the judge advises; a person decides");
}

#[test]
fn a_gate_run_again_replaces_the_earlier_outcome() {
    let mut events = vec![started(), made("m", None), gate(2, Gate::Static, Verdict::Fail)];
    events.extend(passed(2));
    let folded = fold(&journal(events));
    assert_eq!(folded[0].state.status, ProposalStatus::Ready);
    assert_eq!(folded[0].state.gates.len(), 2);
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
    events.push(Event::ProposalApplied { proposal: 4, before: None, after: digest(4), bullet: None });
    let applied_at = events.len() as u64 * 1000;
    events.push(decided(5, ProposalDecision::Accept));
    events.push(Event::ProposalApplied { proposal: 5, before: Some(digest(1)), after: digest(5), bullet: None });
    events.push(Event::ProposalRolledBack { proposal: 5, by: "test".into() });
    let folded = fold(&journal(events));
    let got: Vec<(u64, ProposalStatus, Option<Applied>)> =
        folded.iter().map(|f| (f.state.id, f.state.status, f.applied.clone())).collect();
    assert_eq!(
        got,
        vec![
            (2, ProposalStatus::Rejected, None),
            (3, ProposalStatus::Stale, None),
            (
                4,
                ProposalStatus::Applied,
                Some(Applied { before: None, after: digest(4), bullet: None, at_ms: applied_at })
            ),
            (5, ProposalStatus::RolledBack, None),
        ]
    );
}

/// What a person undid for a file is what the judge is shown: only
/// rolled-back proposals, and only those for the same file.
#[test]
fn rolled_back_lists_what_was_undone_for_the_same_file_only() {
    let skill = |summary: &str| Event::ProposalMade {
        call_id: None,
        proposal: Proposal {
            change: Change::Skill { name: "release".into(), content: "m".into() },
            ..proposal(summary)
        },
        before: None,
    };
    let mut events = vec![started(), made("undone", None), made("kept", None), skill("other file"), made("open", None)];
    for id in 2..=5 {
        events.extend(passed(id));
    }
    for id in 2..=4 {
        events.push(decided(id, ProposalDecision::Accept));
        events.push(Event::ProposalApplied { proposal: id, before: None, after: digest(9), bullet: None });
    }
    events.push(Event::ProposalRolledBack { proposal: 2, by: "test".into() });
    events.push(Event::ProposalRolledBack { proposal: 4, by: "test".into() });
    let folded = fold(&journal(events));
    let undone: Vec<&str> = strive_learning::rolled_back(&folded, &Artifact::Skill { name: "notes".into() })
        .iter()
        .map(|s| s.proposal.summary.as_str())
        .collect();
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
    events.push(Event::ProposalApplied { proposal: 9, before: None, after: digest(9), bullet: None });
    events.push(Event::ProposalRolledBack { proposal: 9, by: "test".into() });
    let folded = fold(&journal(events));
    assert_eq!(folded.len(), 1);
    assert_eq!((folded[0].state.status, folded[0].applied.clone()), (ProposalStatus::Ready, None));
    assert_eq!(folded[0].state.gates.len(), 2);
}

/// Checks are listed in the order they run, whatever order their verdicts
/// were journaled in (a static check a crash cut short runs again after
/// the judge's verdict is in).
#[test]
fn gates_are_listed_in_the_order_they_run() {
    let events =
        vec![started(), made("m", None), gate(2, Gate::Judge, Verdict::Pass), gate(2, Gate::Static, Verdict::Pass)];
    let folded = fold(&journal(events));
    let order: Vec<Gate> = folded[0].state.gates.iter().map(|g| g.gate).collect();
    assert_eq!(order, vec![Gate::Static, Gate::Judge]);
}

/// A later accept for the same file writes over an applied proposal: it's
/// marked replaced by that one, and back in place once that one is rolled
/// back to it. A proposal for another file is untouched.
#[test]
fn a_later_accept_for_the_same_file_replaces_an_applied_proposal() {
    let skill = Event::ProposalMade {
        call_id: None,
        proposal: Proposal {
            change: Change::Skill { name: "release".into(), content: "m".into() },
            ..proposal("skill")
        },
        before: None,
    };
    let mut events = vec![started(), made("first", None), made("second", Some(digest(2))), skill];
    for id in 2..=4 {
        events.extend(passed(id));
    }
    for (id, before, after) in [(2, None, digest(2)), (4, None, digest(4)), (3, Some(digest(2)), digest(3))] {
        events.push(decided(id, ProposalDecision::Accept));
        events.push(Event::ProposalApplied { proposal: id, before, after, bullet: None });
    }
    let replaced = |events: &[Event]| -> Vec<(u64, ProposalStatus, Option<u64>)> {
        fold(&journal(events.to_vec())).iter().map(|f| (f.state.id, f.state.status, f.state.replaced_by)).collect()
    };
    assert_eq!(
        replaced(&events),
        vec![
            (2, ProposalStatus::Applied, Some(3)),
            (3, ProposalStatus::Applied, None),
            (4, ProposalStatus::Applied, None)
        ]
    );
    events.push(Event::ProposalRolledBack { proposal: 3, by: "test".into() });
    assert_eq!(
        replaced(&events),
        vec![
            (2, ProposalStatus::Applied, None),
            (3, ProposalStatus::RolledBack, None),
            (4, ProposalStatus::Applied, None)
        ],
        "rolling back #3 put #2's content back"
    );
}

/// Where a proposal's run came from: the signs a person said yes to, for
/// the proposals of that run only.
#[test]
fn a_proposal_from_a_yes_to_the_offer_carries_the_signs_it_named() {
    let sign = strive_proto::LearnSignal {
        session: "A".into(),
        seq: 4,
        kind: strive_proto::SignalKind::Correction,
        detail: "no, use bun".into(),
    };
    let asked = |offer: Option<bool>| Event::LearnRequested {
        sessions: vec!["A".into()],
        trigger: None,
        signals: Some(vec![sign.clone()]),
        offer,
    };
    let events = vec![started(), asked(Some(true)), made("offered", None), asked(None), made("asked", None)];
    let folded = fold(&journal(events));
    assert_eq!(folded[0].state.offered, Some(vec![sign.clone()]));
    assert_eq!(folded[1].state.offered, None, "a person named the session without the offer");
}

fn skill_made(name: &str) -> Event {
    Event::ProposalMade {
        call_id: None,
        proposal: Proposal { change: Change::Skill { name: name.into(), content: "m".into() }, ..proposal(name) },
        before: None,
    }
}

fn accepted(id: u64, before: Option<Digest>, after: Digest) -> Vec<Event> {
    vec![decided(id, ProposalDecision::Accept), Event::ProposalApplied { proposal: id, before, after, bullet: None }]
}

fn rolled_back(id: u64) -> Event {
    Event::ProposalRolledBack { proposal: id, by: "test".into() }
}

fn replaced_by(events: &[Event]) -> Vec<(u64, Option<u64>)> {
    fold(&journal(events.to_vec())).iter().map(|f| (f.state.id, f.state.replaced_by)).collect()
}

/// Only the proposal that last wrote the same file is replaced, however the
/// proposals are ordered: an earlier one for another file isn't.
#[test]
fn only_the_same_files_proposal_is_replaced() {
    // #2 the skill release, #3 and #4 notes; #2 applied first.
    let mut events = vec![started(), skill_made("release"), made("first", None), made("second", Some(digest(3)))];
    for id in 2..=4 {
        events.extend(passed(id));
    }
    events.extend(accepted(2, None, digest(2)));
    events.extend(accepted(3, None, digest(3)));
    events.extend(accepted(4, Some(digest(3)), digest(4)));
    assert_eq!(replaced_by(&events), vec![(2, None), (3, Some(4)), (4, None)]);
}

/// Rolling back puts back what the file held before it. When that isn't the
/// replaced proposal's content (a person edited the file in between), that
/// proposal stays replaced, and no other proposal takes its place: a later
/// accept replaces nothing that was rolled back.
#[test]
fn a_rollback_to_a_hand_edit_restores_no_proposal() {
    // #2 notes; #3 release, whose content happens to be digest 9; #4 notes
    // accepted over a hand edit (digest 9), not over #2's content.
    let mut events = vec![started(), made("first", None), skill_made("release"), made("second", Some(digest(9)))];
    for id in 2..=4 {
        events.extend(passed(id));
    }
    events.extend(accepted(2, None, digest(2)));
    events.extend(accepted(3, None, digest(9)));
    events.extend(accepted(4, Some(digest(9)), digest(4)));
    events.push(rolled_back(4));
    assert_eq!(replaced_by(&events), vec![(2, Some(4)), (3, None), (4, None)], "#2's content wasn't put back");
    // A new notes proposal accepted now writes over the hand edit: nothing is replaced by it.
    events.push(made("third", Some(digest(9))));
    events.extend(passed(event_count(&events)));
    events.extend(accepted(event_count(&events) - 2, Some(digest(9)), digest(5)));
    let after = replaced_by(&events);
    assert!(after.iter().all(|(id, by)| *id == 2 || by.is_none()), "{after:?}");
}

/// A rollback of a proposal that is no longer the file's live one leaves the
/// live one tracked: a later accept still marks it replaced.
#[test]
fn rolling_back_an_older_proposal_keeps_the_live_one_tracked() {
    let mut events = vec![started(), made("first", None), made("second", Some(digest(2)))];
    for id in 2..=3 {
        events.extend(passed(id));
    }
    events.extend(accepted(2, None, digest(2)));
    events.extend(accepted(3, Some(digest(2)), digest(3)));
    // A recovered rollback of #2, journaled after #3 was accepted.
    events.push(rolled_back(2));
    events.push(made("third", Some(digest(3))));
    let third = event_count(&events);
    events.extend(passed(third));
    events.extend(accepted(third, Some(digest(3)), digest(6)));
    let after = replaced_by(&events);
    assert!(after.contains(&(3, Some(third))), "#3 was live, so the next accept replaced it: {after:?}");
}

/// The seq of the last event: `journal` numbers events from 1.
fn event_count(events: &[Event]) -> u64 {
    events.len() as u64
}

fn memory_made(op: MemoryOp) -> Event {
    Event::ProposalMade {
        call_id: None,
        proposal: Proposal { change: Change::Memory(op), ..proposal("memory") },
        before: None,
    }
}

fn wrote(id: u64, bullet: BulletEdit) -> Vec<Event> {
    vec![
        decided(id, ProposalDecision::Accept),
        Event::ProposalApplied { proposal: id, before: None, after: digest(1), bullet: Some(bullet) },
    ]
}

/// A memory proposal is replaced only by a later change or remove of its
/// own bullet: its source names it. One for another bullet never does, and
/// rolling back the one that replaced it gives it its bullet back.
#[test]
fn a_memory_proposal_is_replaced_by_a_later_change_of_its_own_bullet_only() {
    let add = |t: &str| memory_made(MemoryOp::Add { text: t.into(), after: None });
    let mut events = vec![started(), add("a"), add("b")];
    events.push(memory_made(MemoryOp::Change { bullet: "#2".into(), text: "A".into() }));
    events.push(memory_made(MemoryOp::Remove { bullet: "#3".into() }));
    events.push(memory_made(MemoryOp::Add { text: "c".into(), after: Some("#2".into()) }));
    for id in 2..=6 {
        events.extend(passed(id));
    }
    events.extend(wrote(2, BulletEdit::Added { line: "- a <!-- strive:#2 -->".into() }));
    events.extend(wrote(3, BulletEdit::Added { line: "- b <!-- strive:#3 -->".into() }));
    events.extend(wrote(6, BulletEdit::Added { line: "- c <!-- strive:#6 -->".into() }));
    assert_eq!(
        replaced_by(&events),
        vec![(2, None), (3, None), (4, None), (5, None), (6, None)],
        "adds replace nothing"
    );
    events.extend(wrote(
        4,
        BulletEdit::Changed { old: "- a <!-- strive:#2 -->".into(), new: "- A <!-- strive:#4 -->".into() },
    ));
    events.extend(wrote(5, BulletEdit::Removed { line: "- b <!-- strive:#3 -->".into(), follows: None, gap: 0 }));
    assert_eq!(replaced_by(&events), vec![(2, Some(4)), (3, Some(5)), (4, None), (5, None), (6, None)]);
    events.push(rolled_back(4));
    assert_eq!(
        replaced_by(&events),
        vec![(2, None), (3, Some(5)), (4, None), (5, None), (6, None)],
        "#2's bullet is back"
    );
    let folded = fold(&journal(events));
    assert_eq!(
        folded[2].state.bullet,
        Some(BulletEdit::Changed { old: "- a <!-- strive:#2 -->".into(), new: "- A <!-- strive:#4 -->".into() }),
        "what it did stays its diff once rolled back"
    );
    assert_eq!(folded[2].applied, None);
}

/// A bullet a person wrote has no source: changing it replaces nothing, and
/// a changed line naming a proposal that isn't applied replaces nothing.
#[test]
fn changing_a_hand_written_bullet_replaces_no_proposal() {
    let mut events = vec![started(), memory_made(MemoryOp::Add { text: "a".into(), after: None })];
    events.push(memory_made(MemoryOp::Change { bullet: "x".into(), text: "X".into() }));
    events.push(memory_made(MemoryOp::Change { bullet: "#2".into(), text: "A".into() }));
    for id in 2..=4 {
        events.extend(passed(id));
    }
    events.extend(wrote(3, BulletEdit::Changed { old: "- x".into(), new: "- X <!-- strive:#3 -->".into() }));
    events.extend(wrote(
        4,
        BulletEdit::Changed { old: "- a <!-- strive:#2 -->".into(), new: "- A <!-- strive:#4 -->".into() },
    ));
    assert_eq!(replaced_by(&events), vec![(2, None), (3, None), (4, None)], "#2 was never applied");
    // Applied, then rolled back: a line still naming it doesn't make it replaced.
    events.extend(wrote(2, BulletEdit::Added { line: "- a <!-- strive:#2 -->".into() }));
    events.push(rolled_back(2));
    events.push(memory_made(MemoryOp::Remove { bullet: "#2".into() }));
    let late = event_count(&events);
    events.extend(passed(late));
    events.extend(wrote(late, BulletEdit::Removed { line: "- a <!-- strive:#2 -->".into(), follows: None, gap: 0 }));
    assert!(replaced_by(&events).iter().all(|(_, by)| by.is_none()), "{:?}", replaced_by(&events));
}
