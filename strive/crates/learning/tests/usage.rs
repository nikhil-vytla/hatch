//! How memory bullets fare in use: given, cited, and what followed.

use std::collections::{BTreeMap, BTreeSet};

use strive_learning::usage::{cited, given, tally};
use strive_proto::{BulletUsage, Entry, Event, TurnEnd};

#[test]
fn memory_names_its_bullets_and_a_reply_cites_them() {
    let memory =
        "Reviewed memory: ...\n\n- [m4] Use bun.\n- Mine.\n  - [m12] Nested.\n  * [m13] Starred.\n+ [m14] Plus.\n";
    assert_eq!(given(memory), BTreeSet::from([4, 12, 13, 14]));
    assert_eq!(cited("Ran the tests [uses m4] and the lock [uses m7, m9]."), BTreeSet::from([4, 7, 9]));
    assert_eq!(cited("uses m4, no brackets; [uses nothing]"), BTreeSet::new());
}

struct Journal(Vec<Entry>);

impl Journal {
    fn push(&mut self, event: Event) -> &mut Self {
        let seq = self.0.len() as u64 + 1;
        self.0.push(Entry { seq, ts_ms: 1000 * seq, event });
        self
    }
    fn prompt(&mut self, text: &str) -> &mut Self {
        self.push(Event::UserMessage { text: text.into(), command: None, request_id: None })
    }
    fn reply(&mut self, turn: u64, text: &str) -> &mut Self {
        self.push(Event::TurnStarted { turn, through_seq: None }).push(Event::AssistantMessage {
            turn,
            text: text.into(),
            tool_calls: Vec::new(),
            message: serde_json::json!({}),
        })
    }
    fn end(&mut self, turn: u64, reason: TurnEnd) -> &mut Self {
        self.push(Event::TurnEnded { turn, reason })
    }
}

fn tallied(j: &Journal, given: &[u64]) -> BTreeMap<u64, BulletUsage> {
    let mut out = BTreeMap::new();
    tally("S", &j.0, &given.iter().copied().collect(), &mut out);
    out
}

#[test]
fn a_cite_whose_turn_ends_well_is_clean_and_a_bullet_never_cited_is_only_given() {
    let mut j = Journal(Vec::new());
    j.prompt("add a dependency").reply(1, "Done [uses m4].").end(1, TurnEnd::Done).prompt("thanks");
    let t = tallied(&j, &[4, 7]);
    assert_eq!((t[&4].sessions, t[&4].cited, t[&4].clean, t[&4].trouble), (1, 1, 1, 0));
    assert_eq!(t[&4].last_cited_ms, Some(3000));
    assert_eq!((t[&7].sessions, t[&7].cited), (1, 0));
}

#[test]
fn a_failed_check_or_a_correction_after_a_cite_is_trouble_and_says_where() {
    let mut j = Journal(Vec::new());
    j.prompt("fix it").reply(1, "Fixed [uses m4].");
    j.push(Event::ChecksReported { turn: 1, text: "strive ran...\n\n## t: `false` (exit 1)".into() });
    j.end(1, TurnEnd::Done);
    j.prompt("next").reply(2, "Again [uses m4].").end(2, TurnEnd::Done).prompt("no, that's wrong, use npm");
    let u = &tallied(&j, &[4])[&4];
    assert_eq!((u.cited, u.clean, u.trouble), (2, 0, 2));
    assert_eq!(u.notes[0].seq, 4);
    assert!(u.notes[0].what.starts_with("a check failed: ## t"), "{:?}", u.notes);
    assert!(u.notes[1].what.starts_with("the user corrected it: no, that's wrong"), "{:?}", u.notes);
}

#[test]
fn a_cite_of_a_bullet_not_given_or_in_a_turn_cut_off_counts_for_nothing() {
    let mut j = Journal(Vec::new());
    j.prompt("go").reply(1, "Done [uses m9].").end(1, TurnEnd::Done);
    j.prompt("more").reply(2, "Working [uses m4].");
    let t = tallied(&j, &[4]);
    assert!(!t.contains_key(&9));
    assert_eq!((t[&4].sessions, t[&4].cited), (1, 0), "its turn never ended");
}

#[test]
fn a_bullets_latest_trouble_is_the_one_that_happened_last_whatever_order_sessions_come_in() {
    let session = |at: u64, correction: &str| {
        let mut j = Journal(Vec::new());
        j.prompt("go").reply(1, "Done [uses m4].").end(1, TurnEnd::Done).prompt(correction);
        for e in &mut j.0 {
            e.ts_ms += at;
        }
        j
    };
    let (later, earlier) = (session(1_000_000, "no, wrong later"), session(0, "no, wrong earlier"));
    let mut out = BTreeMap::new();
    let given = BTreeSet::from([4]);
    // The session whose trouble came later is tallied first.
    tally("later", &later.0, &given, &mut out);
    tally("earlier", &earlier.0, &given, &mut out);
    let notes: Vec<&str> = out[&4].notes.iter().map(|n| n.session.as_str()).collect();
    assert_eq!(notes, ["earlier", "later"]);
}

#[test]
fn a_declined_approval_or_a_rewind_after_a_cite_is_trouble_too() {
    let mut j = Journal(Vec::new());
    j.prompt("go").reply(1, "Running it [uses m4].");
    j.push(Event::ApprovalDecided { effect: 1, decision: strive_proto::Decision::Deny, by: "tui".into() });
    j.end(1, TurnEnd::Done).prompt("ok").reply(2, "Again [uses m4].").end(2, TurnEnd::Done);
    j.push(Event::Rewound { to: 1, saved_as: 3 });
    j.prompt("fine");
    let u = &tallied(&j, &[4])[&4];
    let what: Vec<&str> = u.notes.iter().map(|n| n.what.as_str()).collect();
    assert_eq!(what, ["the user declined an approval", "the files were rewound to checkpoint 1"]);
}

#[test]
fn a_bullet_keeps_its_latest_five_troubles_each_in_a_line() {
    let mut j = Journal(Vec::new());
    for turn in 1..=6 {
        j.prompt("go").reply(turn, "Done [uses m4].").end(turn, TurnEnd::Done);
        j.prompt(&format!("no, wrong again {turn} {}", "x".repeat(200)));
    }
    let u = &tallied(&j, &[4])[&4];
    assert_eq!(u.trouble, 6);
    assert_eq!(u.notes.len(), 5);
    assert!(u.notes[0].what.contains("again 2"), "the oldest went: {:?}", u.notes[0]);
    // 120 characters at most, the last an ellipsis.
    let excerpt = u.notes[4].what.trim_start_matches("the user corrected it: ");
    assert_eq!(excerpt.chars().count(), 120);
    assert!(excerpt.ends_with('…'));
    // Exactly 120 characters stay whole.
    let whole = format!("no, {}", "x".repeat(116));
    let mut k = Journal(Vec::new());
    k.prompt("go").reply(1, "Done [uses m4].").end(1, TurnEnd::Done).prompt(&whole);
    assert_eq!(tallied(&k, &[4])[&4].notes[0].what, format!("the user corrected it: {whole}"));
}
