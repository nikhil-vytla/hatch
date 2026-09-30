//! Memory as bullets (ADR-0022): parsing and writing exactly, and one
//! operation's apply, stale detection and undo.
#![allow(clippy::unwrap_used, clippy::panic, reason = "a test fails by panicking")]

use strive_learning::memory::{self, Applied, BULLET_LIMIT, parse};
use strive_learning::{Rule, fold};
use strive_proto::{
    BulletEdit, Change, Digest, Entry, Event, Gate, MemoryItem, MemoryOp, Proposal, ProposalDecision, Verdict,
};

fn add(text: &str) -> MemoryOp {
    MemoryOp::Add { text: text.into(), after: None }
}

fn add_after(text: &str, after: &str) -> MemoryOp {
    MemoryOp::Add { text: text.into(), after: Some(after.into()) }
}

fn change(bullet: &str, text: &str) -> MemoryOp {
    MemoryOp::Change { bullet: bullet.into(), text: text.into() }
}

fn remove(bullet: &str) -> MemoryOp {
    MemoryOp::Remove { bullet: bullet.into() }
}

/// Applies against the file as it is, which is also as the learner saw it.
fn applied(file: &str, op: &MemoryOp, id: u64) -> Applied {
    memory::apply(file, file, op, id).unwrap()
}

fn text(file: &str, op: &MemoryOp, id: u64) -> String {
    applied(file, op, id).text
}

fn bullet(text: &str, source: Option<u64>) -> MemoryItem {
    MemoryItem::Bullet { text: text.into(), source, outside_review: false }
}

fn line(text: &str) -> MemoryItem {
    MemoryItem::Line { text: text.into() }
}

const ODD: &str = "# Memory\n\
    \n\
    Some prose, not a bullet.\n\
    - Use bun. <!-- strive:#4 -->\n\
    * Star bullet\n\
    + Plus bullet\t\n\
    \x20 - Nested under it <!-- strive:#9 -->\n\
    \t- Tab-nested\n\
    -not a bullet\n\
    - \n\
    **bold** is not a bullet\n\
    ---\n\
    ```sh\n\
    - inside a fence\n\
    ```\n\
    1. numbered\n\
    - Last, with no line ending";

#[test]
fn an_unchanged_file_is_written_back_byte_for_byte() {
    for file in [
        ODD,
        "",
        "\n\n",
        "- a\r\n- b <!-- strive:#2 -->\r\n",
        "- mixed\r\n- endings\n",
        "no newline at all",
        "- trailing spaces   \n",
        "- a <!--strive:#3-->  \n",
    ] {
        assert_eq!(parse(file).write(), file, "{file:?}");
    }
}

#[test]
fn bullets_are_read_with_their_source_and_every_other_line_is_kept() {
    assert_eq!(
        parse(ODD).items(),
        vec![
            line("# Memory"),
            line(""),
            line("Some prose, not a bullet."),
            bullet("Use bun.", Some(4)),
            bullet("Star bullet", None),
            bullet("Plus bullet", None),
            bullet("Nested under it", Some(9)),
            bullet("Tab-nested", None),
            line("-not a bullet"),
            line("- "),
            line("**bold** is not a bullet"),
            line("---"),
            line("```sh"),
            line("- inside a fence"),
            line("```"),
            line("1. numbered"),
            bullet("Last, with no line ending", None),
        ]
    );
    assert_eq!(parse("- a\r\n").items(), vec![bullet("a", None)], "CRLF isn't text");
    assert_eq!(parse("- a <!--strive:#3-->  ").items(), vec![bullet("a", Some(3))], "spacing inside the comment");
}

#[test]
fn only_a_trailing_strive_comment_with_a_number_is_a_source() {
    let items = parse(
        "- a <!-- strive:#x -->\n- b <!-- other:#3 -->\n- c <!-- strive:#3 --> after\n- d <!-- strive:# -->\n\
         - e <!-- strive:#+3 -->\n- <!-- strive:#5 -->\n- f <!-- strive:#1 --> <!-- strive:#2 -->\n",
    )
    .items();
    assert_eq!(
        items,
        vec![
            bullet("a <!-- strive:#x -->", None),
            bullet("b <!-- other:#3 -->", None),
            bullet("c <!-- strive:#3 --> after", None),
            bullet("d <!-- strive:# -->", None),
            bullet("e <!-- strive:#+3 -->", None),
            line("- <!-- strive:#5 -->"),
            bullet("f <!-- strive:#1 -->", Some(2)),
        ]
    );
    assert_eq!(memory::source("  - x <!-- strive:#12 -->"), Some(12));
    assert_eq!(memory::source("- x"), None);
    assert_eq!(memory::source("x <!-- strive:#12 -->"), None, "not a bullet");
}

#[test]
fn sessions_are_given_bullets_without_their_source_comments() {
    let file = "# Memory\r\n- Use bun. <!-- strive:#4 -->\r\n  * Nested <!-- strive:#9 -->\n- Mine <!-- a note -->  \n\
                ```\n- x <!-- strive:#5 -->\n```\n- Last <!-- strive:#6 -->";
    assert_eq!(
        parse(file).for_sessions(),
        "# Memory\r\n- Use bun.\r\n  * Nested\n- Mine <!-- a note -->  \n```\n- x <!-- strive:#5 -->\n```\n- Last",
        "a person's lines exactly as written"
    );
}

// --- Add ---

#[test]
fn an_add_goes_after_the_last_bullet_with_its_source() {
    let file = "# Memory\n\n- Use bun.\n  - nested\n\nA closing line.\n";
    let a = applied(file, &add("Run `bun test src`."), 7);
    assert_eq!(
        a.text,
        "# Memory\n\n- Use bun.\n  - nested\n- Run `bun test src`. <!-- strive:#7 -->\n\nA closing line.\n"
    );
    assert_eq!(a.edit, BulletEdit::Added { line: "- Run `bun test src`. <!-- strive:#7 -->".into() });
    assert!(a.written);
    assert_eq!(text("* Star\n", &add("  padded  "), 2), "* Star\n* padded <!-- strive:#2 -->\n", "its marker, trimmed");
    assert_eq!(text("Prose only.\n", &add("New"), 3), "Prose only.\n- New <!-- strive:#3 -->\n");
    assert_eq!(text("", &add("First"), 1), "- First <!-- strive:#1 -->\n");
}

#[test]
fn an_add_after_a_bullet_goes_right_after_it_at_its_depth() {
    let file = "- a\n  - b <!-- strive:#3 -->\n- c\n";
    assert_eq!(text(file, &add_after("New", "a"), 8), "- a\n- New <!-- strive:#8 -->\n  - b <!-- strive:#3 -->\n- c\n");
    assert_eq!(
        text(file, &add_after("New", "#3"), 8),
        "- a\n  - b <!-- strive:#3 -->\n  - New <!-- strive:#8 -->\n- c\n"
    );
    // Gone since the learner looked: it goes at the end instead.
    let now = "- c\n";
    let a = memory::apply(now, file, &add_after("New", "a"), 8).unwrap();
    assert_eq!(a.text, "- c\n- New <!-- strive:#8 -->\n");
}

#[test]
fn an_add_keeps_the_files_line_endings() {
    assert_eq!(text("- a\r\n", &add("b"), 2), "- a\r\n- b <!-- strive:#2 -->\r\n");
    assert_eq!(text("- a", &add("b"), 2), "- a\n- b <!-- strive:#2 -->", "still no line ending at the end");
    assert_eq!(text("- a\r\n- z", &add_after("b", "a"), 2), "- a\r\n- b <!-- strive:#2 -->\r\n- z");
}

#[test]
fn an_add_that_repeats_a_bullet_is_refused() {
    let file = "- Use  bun   for tests. <!-- strive:#3 -->\n";
    let why = memory::apply(file, file, &add("Use bun for tests."), 5).unwrap_err();
    assert!(why.contains("already has the bullet"), "{why}");
    assert!(memory::apply(file, file, &add("use bun for tests."), 5).is_ok(), "case counts");
}

#[test]
fn an_add_already_in_the_file_is_recorded_without_writing() {
    let file = "- a\n";
    let after = text(file, &add("b"), 6);
    let again = memory::apply(&after, file, &add("b"), 6).unwrap();
    assert_eq!((again.text.as_str(), again.written), (after.as_str(), false));
    assert_eq!(again.edit, BulletEdit::Added { line: "- b <!-- strive:#6 -->".into() });
    let why = memory::apply(&after, file, &add("other"), 6).unwrap_err();
    assert!(why.contains("already has a bullet from #6"), "{why}");
}

// --- Change ---

#[test]
fn a_change_rewrites_only_its_bullet_and_takes_its_source() {
    let file = "# M\r\n  * Use npm.\r\n- Other <!-- strive:#2 -->\r\n";
    let a = applied(file, &change("Use npm.", "Use bun."), 9);
    assert_eq!(a.text, "# M\r\n  * Use bun. <!-- strive:#9 -->\r\n- Other <!-- strive:#2 -->\r\n");
    assert_eq!(
        a.edit,
        BulletEdit::Changed { old: "  * Use npm.".into(), new: "  * Use bun. <!-- strive:#9 -->".into() }
    );
    let b = applied(&a.text, &change("#9", "Use bun test."), 12);
    assert_eq!(
        b.edit,
        BulletEdit::Changed {
            old: "  * Use bun. <!-- strive:#9 -->".into(),
            new: "  * Use bun test. <!-- strive:#12 -->".into()
        }
    );
}

#[test]
fn a_change_is_stale_only_when_its_bullet_changed() {
    let shown = "- a\n- b <!-- strive:#3 -->\n";
    // Edits elsewhere don't matter.
    let now = "# New heading\n- a\n- b <!-- strive:#3 -->\n- added by hand\n";
    let a = memory::apply(now, shown, &change("#3", "B"), 7).unwrap();
    assert_eq!(a.text, "# New heading\n- a\n- B <!-- strive:#7 -->\n- added by hand\n");
    // Its bullet does.
    for now in ["- a\n- b, edited <!-- strive:#3 -->\n", "- a\n", "- b <!-- strive:#3 -->\n- b <!-- strive:#3 -->\n"] {
        let why = memory::apply(now, shown, &change("#3", "B"), 7).unwrap_err();
        assert_eq!(why, "the bullet #3 changed since the learner saw it", "{now:?}");
    }
    let why = memory::apply("- a, edited\n", shown, &change("a", "A"), 7).unwrap_err();
    assert_eq!(why, "the bullet \"a\" changed since the learner saw it");
}

#[test]
fn a_change_already_in_the_file_is_recorded_without_writing() {
    let shown = "- a\n";
    let after = text(shown, &change("a", "A"), 4);
    let again = memory::apply(&after, shown, &change("a", "A"), 4).unwrap();
    assert!(!again.written);
    assert_eq!(again.text, after);
    assert_eq!(again.edit, BulletEdit::Changed { old: "- a".into(), new: "- A <!-- strive:#4 -->".into() });
    let why = memory::apply("- A, edited <!-- strive:#4 -->\n", shown, &change("a", "A"), 4).unwrap_err();
    assert!(why.contains("changed since"), "{why}");
}

// --- Remove ---

#[test]
fn a_remove_takes_out_only_its_bullet_and_remembers_where_it_was() {
    let file = "# M\n\n- a\n\n- b <!-- strive:#3 -->\n- c\n";
    let a = applied(file, &remove("#3"), 8);
    assert_eq!(a.text, "# M\n\n- a\n\n- c\n");
    assert_eq!(
        a.edit,
        BulletEdit::Removed { line: "- b <!-- strive:#3 -->".into(), follows: Some("- a".into()), gap: 1 }
    );
    let first = applied("- a\n- b\n", &remove("a"), 8);
    assert_eq!(first.edit, BulletEdit::Removed { line: "- a".into(), follows: None, gap: 0 });
    assert_eq!(text("- a\n- b", &remove("b"), 8), "- a", "the new last line has no line ending either");
}

#[test]
fn a_remove_is_stale_when_its_bullet_changed_and_recorded_when_already_gone() {
    let shown = "- a\n- b <!-- strive:#3 -->\n";
    let why = memory::apply("- a\n- b2 <!-- strive:#3 -->\n", shown, &remove("#3"), 8).unwrap_err();
    assert!(why.contains("changed since"), "{why}");
    let gone = memory::apply("- a\n", shown, &remove("#3"), 8).unwrap();
    assert_eq!((gone.text.as_str(), gone.written), ("- a\n", false));
    assert_eq!(
        gone.edit,
        BulletEdit::Removed { line: "- b <!-- strive:#3 -->".into(), follows: Some("- a".into()), gap: 0 }
    );
}

// --- Naming a bullet ---

#[test]
fn a_bullet_is_named_by_its_source_or_a_hand_written_ones_exact_text() {
    let file = "- Use bun. <!-- strive:#4 -->\n- Twice\n- Twice\n- Mine\n";
    let why = |op: MemoryOp| memory::apply(file, file, &op, 9).unwrap_err();
    assert_eq!(why(remove("Use bun.")), "proposal #4 wrote the bullet \"Use bun.\"; name it \"#4\"");
    assert_eq!(why(remove("#5")), "memory has no bullet #5");
    assert_eq!(why(remove("Min")), "memory has no bullet \"Min\"");
    assert_eq!(why(remove("Twice")), "more than one bullet in memory is \"Twice\", so it doesn't name one");
    assert_eq!(why(change("Mine", "Mine")), "it leaves the bullet \"Mine\" as it is");
    assert!(memory::apply(file, file, &remove("  Mine "), 9).is_ok(), "trimmed");
    assert!(memory::apply(file, file, &remove(" #4 "), 9).is_ok());
    assert!(memory::apply("- #4\n", "- #4\n", &remove("#4"), 9).is_err(), "#4 always names a source");
    assert!(memory::apply("- #x\n", "- #x\n", &remove("#x"), 9).is_ok(), "#x is text");
    assert!(memory::apply("- #+3\n", "- #+3\n", &remove("#+3"), 9).is_ok(), "#+3 is text");
    assert!(memory::apply("- #\n", "- #\n", &remove("#"), 9).is_ok(), "# is text");
}

/// Whatever the operation, every line but its bullet's is carried over.
#[test]
fn an_operation_touches_only_its_bullet() {
    let file = "# M\n- a\n- b <!-- strive:#3 -->\nprose\n- c\n";
    for (op, gone, came) in [
        (add("d"), vec![], vec!["- d <!-- strive:#9 -->"]),
        (change("#3", "B"), vec!["- b <!-- strive:#3 -->"], vec!["- B <!-- strive:#9 -->"]),
        (remove("a"), vec!["- a"], vec![]),
    ] {
        let after = text(file, &op, 9);
        let before: Vec<&str> = file.lines().collect();
        let now: Vec<&str> = after.lines().collect();
        let removed: Vec<&str> = before.iter().filter(|l| !now.contains(l)).copied().collect();
        let added: Vec<&str> = now.iter().filter(|l| !before.contains(l)).copied().collect();
        assert_eq!(now.len() + gone.len(), before.len() + came.len(), "{op:?}");
        assert_eq!((removed, added), (gone, came), "{op:?}");
    }
}

// --- Undo ---

#[test]
fn undoing_puts_the_file_back_byte_for_byte() {
    for (file, op) in [
        ("# M\n- a\n", add("b")),
        ("- a", add("b")),
        ("", add("b")),
        ("- a\r\n  * b\r\n- c\r\n", change("b", "B")),
        ("# M\n\n- a\n- b\n- c\n", remove("b")),
        ("# M\n\n- a\n- b\n", remove("a")),
        ("## A\n- a\n## B\n- b\n", remove("b")),
        ("## A\n- a\n\n## B\n\n- b\n\n## C\n", remove("b")),
        ("- a\n- b\n", remove("a")),
        ("- a\n- b", remove("b")),
        ("- only\n", remove("only")),
    ] {
        let a = applied(file, &op, 5);
        assert_eq!(memory::undo(&a.text, &a.edit, 5), Ok(Some(file.to_string())), "{file:?} {op:?}");
    }
}

#[test]
fn undoes_run_in_any_order_and_survive_edits_elsewhere() {
    let file = "- a\n- b\n";
    let first = applied(file, &add("c"), 3);
    let second = applied(&first.text, &change("a", "A"), 4);
    let third = applied(&second.text, &remove("b"), 5);
    // Edits elsewhere, by hand.
    let edited = format!("# Heading\n{}- by hand\n", third.text);
    let undone = memory::undo(&edited, &first.edit, 3).unwrap().unwrap();
    assert_eq!(undone, "# Heading\n- A <!-- strive:#4 -->\n- by hand\n");
    let undone = memory::undo(&undone, &third.edit, 5).unwrap().unwrap();
    assert_eq!(undone, "# Heading\n- A <!-- strive:#4 -->\n- b\n- by hand\n", "after its old predecessor");
    let undone = memory::undo(&undone, &second.edit, 4).unwrap().unwrap();
    assert_eq!(undone, "# Heading\n- a\n- b\n- by hand\n");
}

#[test]
fn a_removed_bullet_goes_back_after_its_predecessor_at_the_top_or_at_the_end() {
    let gone = BulletEdit::Removed { line: "- x".into(), follows: Some("- p".into()), gap: 0 };
    assert_eq!(memory::undo("- p\n- q\n", &gone, 5), Ok(Some("- p\n- x\n- q\n".into())));
    assert_eq!(
        memory::undo("- q\n- r\ntail\n", &gone, 5),
        Ok(Some("- q\n- r\n- x\ntail\n".into())),
        "predecessor gone"
    );
    assert_eq!(memory::undo("prose\n", &gone, 5), Ok(Some("prose\n- x\n".into())), "no bullets");
    let first = BulletEdit::Removed { line: "- x".into(), follows: None, gap: 0 };
    assert_eq!(memory::undo("# M\n- q\n", &first, 5), Ok(Some("- x\n# M\n- q\n".into())));
    let spaced = BulletEdit::Removed { line: "- x".into(), follows: Some("# M".into()), gap: 2 };
    assert_eq!(memory::undo("# M\n\n\n- q\n", &spaced, 5), Ok(Some("# M\n\n\n- x\n- q\n".into())));
    assert_eq!(memory::undo("# M\n\n- q\n", &spaced, 5), Ok(Some("# M\n\n- x\n- q\n".into())), "as far as blanks go");
    assert_eq!(memory::undo("# M\n- q\n", &spaced, 5), Ok(Some("# M\n- x\n- q\n".into())));
}

#[test]
fn an_undo_is_refused_only_when_its_bullet_changed_since() {
    let added = BulletEdit::Added { line: "- b <!-- strive:#3 -->".into() };
    let why = memory::undo("- b, edited <!-- strive:#3 -->\n", &added, 3).unwrap_err();
    assert_eq!(why, "the bullet #3 added has been edited since");
    let twice = "- b <!-- strive:#3 -->\n- b <!-- strive:#3 -->\n";
    assert_eq!(memory::undo(twice, &added, 3).unwrap_err(), "more than one bullet in memory is #3");

    let changed = BulletEdit::Changed { old: "- a".into(), new: "- A <!-- strive:#4 -->".into() };
    assert_eq!(
        memory::undo("- A2 <!-- strive:#4 -->\n", &changed, 4).unwrap_err(),
        "the bullet #4 changed has been edited since"
    );
    assert_eq!(memory::undo("- z\n", &changed, 4).unwrap_err(), "the bullet #4 changed is gone from memory");
    let twice = "- A <!-- strive:#4 -->\n- A <!-- strive:#4 -->\n";
    assert_eq!(memory::undo(twice, &changed, 4).unwrap_err(), "more than one bullet in memory is #4");
}

/// A rollback a crash cut off after its write: the retry writes nothing.
#[test]
fn an_undo_already_done_writes_nothing() {
    let added = BulletEdit::Added { line: "- b <!-- strive:#3 -->".into() };
    assert_eq!(memory::undo("- a\n", &added, 3), Ok(None));
    let changed = BulletEdit::Changed { old: "- a <!-- strive:#2 -->".into(), new: "- A <!-- strive:#4 -->".into() };
    assert_eq!(memory::undo("* a <!-- strive:#2 -->\n", &changed, 4), Ok(None), "the old bullet reads as it did");
    assert!(memory::undo("- a\n", &changed, 4).is_err(), "not the old bullet: its source differs");
    let removed = BulletEdit::Removed { line: "- x <!-- strive:#2 -->".into(), follows: None, gap: 0 };
    assert_eq!(memory::undo("- p\n- x <!-- strive:#2 -->\n", &removed, 5), Ok(None));
    assert!(memory::undo("- p\n- x\n", &removed, 5).unwrap().is_some(), "a hand-written x isn't #2's");
}

// --- The static check ---

fn findings(shown: &str, op: &MemoryOp) -> Vec<(Rule, String)> {
    memory::check(shown, op).into_iter().map(|f| (f.rule, f.detail)).collect()
}

#[test]
fn a_bullet_is_one_line_of_bounded_length_without_its_marker() {
    assert_eq!(findings("", &add("Fine.")), vec![]);
    assert_eq!(findings("", &add(&"a".repeat(BULLET_LIMIT))), vec![]);
    assert_eq!(
        findings("", &add(&"é".repeat(BULLET_LIMIT + 1))),
        vec![(Rule::Size, format!("the bullet is {} characters; the limit is {BULLET_LIMIT}", BULLET_LIMIT + 1))]
    );
    let rules = |op| findings("- a\n", &op).into_iter().map(|(r, _)| r).collect::<Vec<_>>();
    assert_eq!(rules(add("one\ntwo")), vec![Rule::Form]);
    assert_eq!(rules(add("one\rtwo")), vec![Rule::Form]);
    assert_eq!(rules(add("   ")), vec![Rule::Form]);
    assert_eq!(rules(add("- marked")), vec![Rule::Form]);
    assert_eq!(rules(add("* marked")), vec![Rule::Form]);
    assert_eq!(rules(add("+ marked")), vec![Rule::Form]);
    assert_eq!(rules(change("a", "two\nlines")), vec![Rule::Form]);
    assert_eq!(rules(remove("a")), vec![]);
}

#[test]
fn the_check_names_the_bullet_it_cant_find_or_the_one_it_repeats() {
    let shown = "- Use bun.\n";
    assert_eq!(findings(shown, &remove("nope")), vec![(Rule::Bullet, "memory has no bullet \"nope\"".into())]);
    assert_eq!(findings(shown, &change("#3", "x")), vec![(Rule::Bullet, "memory has no bullet #3".into())]);
    assert_eq!(
        findings(shown, &add("Use  bun.")),
        vec![(Rule::Bullet, "memory already has the bullet \"Use bun.\"".into())]
    );
    assert_eq!(findings(shown, &add_after("x", "#9")), vec![(Rule::Bullet, "after: memory has no bullet #9".into())]);
    assert_eq!(findings(shown, &add_after("x", "Use bun.")), vec![]);
}

#[test]
fn the_check_keeps_the_file_within_its_limit() {
    let long = "a".repeat(strive_learning::MEMORY_LIMIT - 100);
    let big = format!("- {long}\n");
    assert_eq!(findings(&big, &add("short")), vec![]);
    let found = findings(&big, &add(&"b".repeat(60)));
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].0, Rule::Size);
    assert!(found[0].1.starts_with("memory would be "), "{found:?}");
    assert!(findings(&format!("{big}{}", "b".repeat(200)), &remove(&long)).is_empty(), "removing shrinks it");
    // Exactly at the limit is fine, one byte over isn't.
    let line = |id: u64| format!("- b <!-- strive:#{id} -->\n");
    let fits = format!("- {}\n", "a".repeat(strive_learning::MEMORY_LIMIT - 3 - line(5).len()));
    let exact = memory::apply(&fits, &fits, &add("b"), 5).unwrap();
    assert_eq!(exact.text.len(), strive_learning::MEMORY_LIMIT);
    assert!(memory::apply(&fits, &fits, &add("b"), 50).is_err(), "one byte over");
    let fits = format!("- {}\n", "a".repeat(strive_learning::MEMORY_LIMIT - 3 - line(u64::MAX).len()));
    assert_eq!(findings(&fits, &add("b")), vec![], "the check counts the longest id");
    let over = format!("{fits}x");
    assert_eq!(findings(&over, &add("b")).len(), 1);
    // Accepting checks again against the file as it is then.
    let why = memory::apply(&format!("{big}- {}\n", "c".repeat(80)), &big, &add(&"b".repeat(30)), 5).unwrap_err();
    assert!(why.starts_with("memory would be "), "{why}");
}

// --- What review sees ---

#[test]
fn a_preview_is_the_one_bullet_diff_against_the_file_the_learner_saw() {
    assert_eq!(
        memory::preview("- a\n", &change("a", "A"), 4),
        Some(BulletEdit::Changed { old: "- a".into(), new: "- A <!-- strive:#4 -->".into() })
    );
    assert_eq!(memory::preview("- a\n", &remove("b"), 4), None);
}

fn journal(events: Vec<Event>) -> Vec<Entry> {
    events.into_iter().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: seq, event }).collect()
}

fn proposal(op: MemoryOp) -> Event {
    let proposal = Proposal {
        change: Change::Memory(op),
        summary: "s".into(),
        rationale: "r".into(),
        evidence: vec![],
        prediction: "p".into(),
    };
    Event::ProposalMade { call_id: None, proposal, before: None }
}

fn accepted(id: u64, bullet: BulletEdit) -> Vec<Event> {
    vec![
        Event::GateFinished { proposal: id, gate: Gate::Static, verdict: Verdict::Pass, detail: String::new() },
        Event::GateFinished { proposal: id, gate: Gate::Judge, verdict: Verdict::Skipped, detail: String::new() },
        Event::ProposalDecided { proposal: id, decision: ProposalDecision::Accept, by: "t".into() },
        Event::ProposalApplied { proposal: id, before: None, after: Digest::from_bytes([0; 32]), bullet: Some(bullet) },
    ]
}

#[test]
fn a_bullet_is_changed_outside_review_when_it_isnt_what_its_source_left() {
    let mut events = vec![proposal(add("b")), proposal(change("a", "A")), proposal(remove("x"))];
    events.extend(accepted(1, BulletEdit::Added { line: "- b <!-- strive:#1 -->".into() }));
    events.extend(accepted(2, BulletEdit::Changed { old: "- a".into(), new: "- A <!-- strive:#2 -->".into() }));
    events.extend(accepted(3, BulletEdit::Removed { line: "- x".into(), follows: None, gap: 0 }));
    events.push(Event::ProposalRolledBack { proposal: 1, by: "t".into() });
    let folded = fold(&journal(events));
    let now = "- by hand\n- A <!-- strive:#2 -->\n- b <!-- strive:#1 -->\n- A, edited <!-- strive:#2 -->\n\
               - x <!-- strive:#3 -->\n- forged <!-- strive:#99 -->\nprose\n";
    let flagged: Vec<(String, bool)> = memory::view(now, &folded)
        .into_iter()
        .filter_map(|i| match i {
            MemoryItem::Bullet { text, outside_review, .. } => Some((text, outside_review)),
            MemoryItem::Line { .. } => None,
        })
        .collect();
    assert_eq!(
        flagged,
        vec![
            ("by hand".into(), false),
            ("A".into(), false),
            ("b".into(), true),
            ("A, edited".into(), true),
            ("x".into(), true),
            ("forged".into(), true),
        ],
        "hand-written is fine; rolled back, edited, removed-by-it and unknown sources aren't"
    );
    assert_eq!(memory::view(now, &folded).last(), Some(&line("prose")));
}
