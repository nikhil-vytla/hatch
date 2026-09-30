//! The pre-filter for automatic learning (ADR-0020): signs in a work journal
//! worth a learner run, and what the learning journal says about automatic
//! runs.

use strive_learning::signals::{DETAIL_LIMIT, LIMIT, describe, is_correction, scan, summary};
use strive_learning::triggers::{acted_on, automatic_since, busy, cost_per_run, skipped};
use strive_proto::{
    Change, Decision, Digest, EffectOutcome, EffectRecord, Entry, Event, Evidence, LearnSignal, LearnTrigger, MemoryOp,
    Proposal, SignalKind, TriggerKind, TurnEnd,
};

/// Builds a journal event by event, numbering entries from 1.
#[derive(Default)]
struct Journal {
    events: Vec<Event>,
    turn: u64,
    effect: u64,
}

impl Journal {
    fn new() -> Self {
        let mut j = Self::default();
        j.events.push(Event::SessionStarted { format: 1, cwd: "/p".into(), strive_version: "0".into(), kind: None });
        j
    }
    fn push(&mut self, event: Event) -> u64 {
        self.events.push(event);
        self.events.len() as u64
    }
    fn prompt(&mut self, text: &str) -> u64 {
        self.push(Event::UserMessage { text: text.into() })
    }
    fn turn(&mut self) {
        self.turn += 1;
        let through = self.events.len() as u64;
        self.push(Event::TurnStarted { turn: self.turn, through_seq: Some(through) });
    }
    fn end(&mut self, reason: TurnEnd) -> u64 {
        self.push(Event::TurnEnded { turn: self.turn, reason })
    }
    /// A whole turn that ends as `reason`; the end's seq.
    fn exchange(&mut self, prompt: &str, reason: TurnEnd) -> u64 {
        self.prompt(prompt);
        self.turn();
        self.end(reason)
    }
    fn run(&mut self, command: &str, exit: i32) -> u64 {
        self.effect += 1;
        let record = EffectRecord::Bash { command: command.into(), timeout_ms: 1000 };
        self.push(Event::EffectStarted { effect: self.effect, call_id: format!("c{}", self.effect), record });
        let outcome =
            EffectOutcome::Done { output: Digest::from_bytes([0; 32]), exit_code: Some(exit), truncated: false };
        self.push(Event::EffectFinished { effect: self.effect, outcome, duration_ms: 5 })
    }
    /// A command that asked and the person's answer; the answer's seq.
    fn asked(&mut self, description: &str, decision: Decision) -> u64 {
        self.effect += 1;
        self.push(Event::ApprovalRequested {
            effect: self.effect,
            description: description.into(),
            session_file: None,
        });
        self.push(Event::ApprovalDecided { effect: self.effect, decision, by: "strive-tui".into() })
    }
    fn entries(&self) -> Vec<Entry> {
        self.events.iter().cloned().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: seq * 1000, event }).collect()
    }
}

fn kinds(signals: &[LearnSignal]) -> Vec<(u64, SignalKind)> {
    signals.iter().map(|s| (s.seq, s.kind)).collect()
}

#[test]
fn a_clean_session_has_no_signs() {
    let mut j = Journal::new();
    j.exchange("add a --verbose flag to the CLI", TurnEnd::Done);
    j.prompt("now write a test for it");
    j.turn();
    j.run("cargo test", 0);
    j.asked("run `cargo fmt`", Decision::Allow);
    j.end(TurnEnd::Done);
    j.exchange("thanks, looks good", TurnEnd::Done);
    assert_eq!(scan("S", &j.entries(), 0), vec![]);
}

#[test]
fn a_correcting_prompt_after_a_turn_is_a_sign_anchored_at_the_prompt() {
    let mut j = Journal::new();
    j.exchange("run the tests", TurnEnd::Done);
    let fix = j.prompt("No, use bun test instead of npm test");
    j.turn();
    j.end(TurnEnd::Done);
    let found = scan("S", &j.entries(), 0);
    assert_eq!(kinds(&found), vec![(fix, SignalKind::Correction)]);
    assert_eq!(found[0].session, "S");
    assert_eq!(found[0].detail, "No, use bun test instead of npm test");
}

#[test]
fn only_the_first_prompt_after_a_turn_is_read_as_a_correction() {
    // The session's first prompt follows no turn, and a second prompt queued
    // behind the first isn't a reaction to anything the agent did.
    let mut j = Journal::new();
    j.prompt("no tabs in this repo, spaces only; set up the formatter");
    j.prompt("actually also add a pre-commit hook");
    j.turn();
    j.end(TurnEnd::Done);
    let first = j.prompt("great");
    j.prompt("i said spaces, not tabs");
    j.turn();
    j.end(TurnEnd::Done);
    assert!(first > 0);
    assert_eq!(scan("S", &j.entries(), 0), vec![]);
}

/// A prompt sent while a turn runs steers that turn: when a queued prompt
/// starts the next turn as soon as one ends, what follows isn't the first
/// prompt after an ended turn.
#[test]
fn a_prompt_sent_while_a_turn_runs_is_not_read_as_a_correction() {
    let mut j = Journal::new();
    j.prompt("set up the formatter");
    j.turn();
    j.prompt("and add a pre-commit hook");
    j.end(TurnEnd::Done);
    j.turn();
    j.prompt("no, use spaces, not tabs");
    j.end(TurnEnd::Done);
    assert_eq!(scan("S", &j.entries(), 0), vec![]);
}

#[test]
fn correction_phrasing_opens_the_prompt_or_is_a_phrase_within_its_head() {
    for yes in [
        "no",
        "No. Use pnpm.",
        "nope, wrong file",
        "Actually, put it in src/lib",
        "wait - don't delete that",
        "Don't touch the lockfile",
        "Do not run the migrations",
        "That's not what the ticket asks for",
        "That\u{2019}s not right",
        "hmm, I said the other branch",
        "the build is fine but you didn't update the docs",
        "why did you remove the test?",
        "this is still failing on CI",
        "it doesn't work when the file is empty",
        "stop",
        "revert that",
    ] {
        assert!(is_correction(yes), "{yes:?} reads as a correction");
    }
    for no in [
        "no problem, now add the flag",
        "No worries. Next: the README.",
        "now add a --verbose flag",
        "knowledge base: summarize it",
        "notice the failing test and fix it",
        "insteadOf is a git config key; explain it",
        "i saidx something",
        "",
    ] {
        assert!(!is_correction(no), "{no:?} isn't a correction");
    }
}

#[test]
fn only_the_head_of_a_prompt_is_read_for_correction_phrasing() {
    let long = format!("{} you didn't", "please continue with the plan ".repeat(10));
    assert!(long.chars().count() > strive_learning::signals::PROMPT_SCAN);
    assert!(!is_correction(&long), "the phrase is past what is read");
    assert!(is_correction(&format!("you didn't {long}")));
}

#[test]
fn an_interrupted_turn_is_a_sign_at_its_end() {
    let mut j = Journal::new();
    let end = j.exchange("refactor the parser", TurnEnd::Interrupted);
    assert_eq!(kinds(&scan("S", &j.entries(), 0)), vec![(end, SignalKind::Interrupted)]);
}

#[test]
fn a_failed_or_timed_out_turn_is_a_sign_with_its_error() {
    let mut j = Journal::new();
    let failed = j.exchange("do it", TurnEnd::Failed { error: "the provider refused: overloaded".into() });
    let timed = j.exchange("do it again", TurnEnd::TimedOut { seconds: 1800 });
    let found = scan("S", &j.entries(), 0);
    assert_eq!(kinds(&found), vec![(failed, SignalKind::TurnFailed), (timed, SignalKind::TurnFailed)]);
    assert!(found[0].detail.contains("overloaded"), "{:?}", found[0].detail);
    assert!(found[1].detail.contains("1800s"), "{:?}", found[1].detail);
}

#[test]
fn a_declined_approval_is_a_sign_naming_what_was_asked() {
    let mut j = Journal::new();
    j.prompt("clean up");
    j.turn();
    j.asked("run `ls`", Decision::Allow);
    j.asked("run `git status`", Decision::AllowSession);
    let denied = j.asked("run `rm -rf build`", Decision::Deny);
    j.end(TurnEnd::Done);
    let found = scan("S", &j.entries(), 0);
    assert_eq!(kinds(&found), vec![(denied, SignalKind::Declined)]);
    assert_eq!(found[0].detail, "run `rm -rf build`");
}

#[test]
fn a_command_that_failed_then_passed_is_a_sign_at_the_passing_run() {
    let mut j = Journal::new();
    j.prompt("make the tests pass");
    j.turn();
    j.run("bun test", 1);
    j.run("cat src/a.ts", 0);
    let passed = j.run("bun test", 0);
    j.end(TurnEnd::Done);
    let found = scan("S", &j.entries(), 0);
    assert_eq!(kinds(&found), vec![(passed, SignalKind::FailedThenPassed)]);
    assert_eq!(found[0].detail, "bun test");
}

#[test]
fn a_command_that_failed_and_never_passed_is_no_sign() {
    let mut j = Journal::new();
    j.prompt("make the tests pass");
    j.turn();
    j.run("bun test", 1);
    j.run("bun test src", 0);
    j.end(TurnEnd::Done);
    assert_eq!(scan("S", &j.entries(), 0), vec![]);
}

#[test]
fn signs_come_in_journal_order_and_only_past_the_given_seq() {
    let mut j = Journal::new();
    let interrupted = j.exchange("go", TurnEnd::Interrupted);
    let fix = j.prompt("no, the other one");
    j.turn();
    j.run("make", 2);
    let passed = j.run("make", 0);
    j.end(TurnEnd::Done);
    let all = scan("S", &j.entries(), 0);
    assert_eq!(
        kinds(&all),
        vec![
            (interrupted, SignalKind::Interrupted),
            (fix, SignalKind::Correction),
            (passed, SignalKind::FailedThenPassed)
        ]
    );
    assert_eq!(kinds(&scan("S", &j.entries(), interrupted)), kinds(&all[1..]));
    assert_eq!(scan("S", &j.entries(), passed), vec![]);
}

#[test]
fn a_longer_journal_of_the_same_session_finds_the_same_signs_and_more() {
    let mut j = Journal::new();
    j.exchange("go", TurnEnd::Interrupted);
    let before = scan("S", &j.entries(), 0);
    j.exchange("no, slower", TurnEnd::Done);
    let after = scan("S", &j.entries(), 0);
    assert_eq!(after[..before.len()], before[..]);
    assert_eq!(after.len(), before.len() + 1);
}

#[test]
fn a_scan_returns_at_most_the_limit_earliest_first_and_excerpts_are_one_short_line() {
    let mut j = Journal::new();
    let mut ends = Vec::new();
    for _ in 0..LIMIT + 5 {
        ends.push(j.exchange("go", TurnEnd::Interrupted));
    }
    let found = scan("S", &j.entries(), 0);
    assert_eq!(found.iter().map(|s| s.seq).collect::<Vec<_>>(), ends[..LIMIT]);
    // What was cut off is found by the next scan past the last returned.
    assert_eq!(scan("S", &j.entries(), ends[LIMIT - 1]).len(), 5);

    let mut j = Journal::new();
    j.exchange("go", TurnEnd::Done);
    j.prompt(&format!("no,\n{}", "much longer ".repeat(40)));
    let detail = &scan("S", &j.entries(), 0)[0].detail;
    assert_eq!(detail.chars().count(), DETAIL_LIMIT);
    assert!(!detail.contains('\n') && detail.ends_with('…'), "{detail:?}");
}

fn trigger(signals: Vec<(&str, u64)>) -> LearnTrigger {
    LearnTrigger {
        kind: TriggerKind::Idle,
        signals: signals
            .into_iter()
            .map(|(session, seq)| LearnSignal {
                session: session.into(),
                seq,
                kind: SignalKind::Correction,
                detail: "no".into(),
            })
            .collect(),
    }
}

fn requested(trigger: Option<LearnTrigger>) -> Event {
    Event::LearnRequested { sessions: vec!["A".into()], trigger, signals: None, offer: None }
}

#[test]
fn signs_acted_on_are_those_of_automatic_requests_not_skips() {
    let mut j = Journal::new();
    j.push(requested(Some(trigger(vec![("A", 7), ("A", 12)]))));
    j.push(requested(Some(trigger(vec![("B", 30)]))));
    j.push(Event::LearnSkipped { trigger: trigger(vec![("A", 40)]), reason: "the cap".into() });
    j.push(requested(None));
    let learning = j.entries();
    assert_eq!(acted_on(&learning, "A"), 12);
    assert_eq!(acted_on(&learning, "B"), 30);
    assert_eq!(acted_on(&learning, "C"), 0);
}

#[test]
fn only_automatic_requests_since_a_time_count_toward_the_cap() {
    let mut j = Journal::new();
    j.push(requested(Some(trigger(vec![("A", 1)])))); // ts 2000
    j.push(requested(None)); // ts 3000
    j.push(requested(Some(trigger(vec![("A", 2)])))); // ts 4000
    j.push(Event::LearnSkipped { trigger: trigger(vec![("A", 3)]), reason: "busy".into() });
    let learning = j.entries();
    assert_eq!(automatic_since(&learning, 0), 2);
    assert_eq!(automatic_since(&learning, 2001), 1);
    assert_eq!(automatic_since(&learning, 4001), 0);
}

fn proposal() -> Proposal {
    Proposal {
        change: Change::Memory(MemoryOp::Add { text: "use bun".into(), after: None }),
        summary: "use bun".into(),
        rationale: "r".into(),
        evidence: vec![Evidence { session: "A".into(), seqs: vec![], note: "n".into() }],
        prediction: "p".into(),
    }
}

#[test]
fn a_request_no_turn_has_finished_or_a_proposal_being_checked_keeps_automatic_runs_back() {
    let mut j = Journal::new();
    assert_eq!(busy(&j.entries()), None, "nothing asked yet");
    let asked = j.push(requested(None));
    assert!(busy(&j.entries()).is_some_and(|w| w.contains("learner run")), "no turn took it");
    // A turn that started before the request and ends after it didn't take it.
    let mut early = Journal::new();
    early.push(Event::TurnStarted { turn: 1, through_seq: Some(1) });
    early.push(requested(None));
    early.push(Event::TurnEnded { turn: 1, reason: TurnEnd::Done });
    assert!(busy(&early.entries()).is_some(), "the request waits for the next turn");
    // A turn journaled after the request that took only an earlier one didn't take it.
    let mut queued = Journal::new();
    let earlier = queued.push(requested(None));
    queued.push(requested(None));
    queued.push(Event::TurnStarted { turn: 1, through_seq: Some(earlier) });
    queued.push(Event::TurnEnded { turn: 1, reason: TurnEnd::Done });
    assert!(busy(&queued.entries()).is_some(), "the later request waits for the next turn");

    j.push(Event::TurnStarted { turn: 1, through_seq: Some(asked) });
    assert!(busy(&j.entries()).is_some(), "the turn that took it runs");
    let made = j.push(Event::ProposalMade { call_id: None, proposal: proposal(), before: None });
    j.push(Event::TurnEnded { turn: 1, reason: TurnEnd::Done });
    assert!(busy(&j.entries()).is_some_and(|w| w.contains("checks")), "the proposal is checking");
    for gate in strive_learning::GATES {
        j.push(Event::GateFinished {
            proposal: made,
            gate,
            verdict: strive_proto::Verdict::Skipped,
            detail: "d".into(),
        });
    }
    assert_eq!(busy(&j.entries()), None);
}

#[test]
fn sessions_skipped_for_being_busy_wait_until_a_request_names_them_or_a_later_skip_isnt_busy() {
    use strive_learning::triggers::{CHECKS_GOING, RUN_GOING, waiting};
    let skip = |session: &str, reason: &str| Event::LearnSkipped {
        trigger: trigger(vec![(session, 3)]),
        reason: reason.into(),
    };
    let mut j = Journal::new();
    j.push(skip("A", RUN_GOING));
    j.push(skip("B", CHECKS_GOING));
    j.push(skip("C", "the daily cap"));
    j.push(skip("D", RUN_GOING));
    j.push(requested(None));
    let names = |j: &Journal| waiting(&j.entries()).into_iter().map(|(s, _)| s).collect::<Vec<_>>();
    assert_eq!(names(&j), ["A", "B", "D"], "a person's run names no session");
    j.push(requested(Some(trigger(vec![("A", 3)]))));
    j.push(skip("D", "the daily cap"));
    assert_eq!(names(&j), ["B"]);
    j.push(skip("C", RUN_GOING));
    assert_eq!(waiting(&j.entries()), [("B".to_string(), TriggerKind::Idle), ("C".to_string(), TriggerKind::Idle)]);
}

#[test]
fn the_latest_skip_shows_until_an_automatic_run_starts() {
    let mut j = Journal::new();
    assert_eq!(skipped(&j.entries()), None);
    j.push(Event::LearnSkipped { trigger: trigger(vec![("A", 3)]), reason: "first".into() });
    j.push(Event::LearnSkipped { trigger: trigger(vec![("A", 5)]), reason: "second".into() });
    assert_eq!(skipped(&j.entries()).map(|s| s.reason), Some("second".into()));
    j.push(requested(None));
    assert_eq!(skipped(&j.entries()).map(|s| s.reason), Some("second".into()), "a person's run isn't one");
    j.push(requested(Some(trigger(vec![("A", 5)]))));
    assert_eq!(skipped(&j.entries()), None);
}

#[test]
fn a_triggers_signs_read_as_one_line() {
    let mut t = trigger(vec![("S1", 3), ("S1", 5)]);
    t.signals[1].kind = SignalKind::Interrupted;
    assert_eq!(describe(&t.signals), "a correction and an interrupted turn in session S1");
    t.signals.push(LearnSignal { kind: SignalKind::Correction, ..t.signals[0].clone() });
    assert_eq!(describe(&t.signals), "a correction and an interrupted turn in session S1");
}

#[test]
fn one_failed_then_passed_sign_a_turn_and_only_for_commands_run_in_a_turn() {
    let mut j = Journal::new();
    // Before any turn: not the agent's.
    j.run("make", 1);
    j.prompt("fix it");
    j.turn();
    j.run("make", 0);
    // Two commands red to green in one turn: the first is the sign.
    j.run("bun test", 1);
    j.run("cargo test", 1);
    let passed = j.run("bun test", 0);
    j.run("cargo test", 0);
    j.end(TurnEnd::Done);
    let found = scan("S", &j.entries(), 0);
    assert_eq!(kinds(&found), vec![(passed, SignalKind::FailedThenPassed)]);
    assert_eq!(found[0].detail, "bun test");
}

#[test]
fn a_command_that_only_passed_or_is_too_long_to_be_a_check_is_no_sign() {
    let mut j = Journal::new();
    j.prompt("look around");
    j.turn();
    j.run("ls", 0);
    j.run("ls", 0);
    let long = format!("echo {}", "x".repeat(strive_learning::signals::COMMAND_LIMIT));
    j.run(&long, 1);
    j.run(&long, 0);
    j.end(TurnEnd::Done);
    assert_eq!(scan("S", &j.entries(), 0), vec![]);
}

#[test]
fn signs_a_person_asked_about_or_dismissed_are_dealt_with_too() {
    let signs = |session: &str, seq: u64| Some(trigger(vec![(session, seq)]).signals);
    let mut j = Journal::new();
    j.push(Event::LearnRequested { sessions: vec!["A".into()], trigger: None, signals: signs("A", 9), offer: None });
    j.push(Event::LearnDismissed { session: "B".into(), through: 15 });
    // A later dismissal below a request's signs doesn't lower the mark.
    j.push(Event::LearnDismissed { session: "A".into(), through: 5 });
    j.push(requested(Some(trigger(vec![("C", 4)]))));
    j.push(Event::LearnDismissed { session: "C".into(), through: 20 });
    let learning = j.entries();
    assert_eq!(acted_on(&learning, "A"), 9);
    assert_eq!(acted_on(&learning, "B"), 15);
    assert_eq!(acted_on(&learning, "C"), 20);
    assert_eq!(acted_on(&learning, "D"), 0);
    // Neither a person's request nor a dismissal is an automatic run.
    assert_eq!(automatic_since(&learning, 0), 1);
    assert_eq!(skipped(&learning), None);
}

#[test]
fn a_sessions_signs_read_as_a_counted_phrase() {
    let sign = |kind: SignalKind| LearnSignal { session: "S".into(), seq: 1, kind, detail: "d".into() };
    assert_eq!(summary(&[]), "");
    assert_eq!(summary(&[sign(SignalKind::Declined)]), "a declined approval");
    assert_eq!(
        summary(&[sign(SignalKind::Correction), sign(SignalKind::FailedThenPassed), sign(SignalKind::Correction)]),
        "2 corrections and a command that failed, then passed"
    );
    assert_eq!(
        summary(&[
            sign(SignalKind::TurnFailed),
            sign(SignalKind::Interrupted),
            sign(SignalKind::Interrupted),
            sign(SignalKind::FailedThenPassed),
            sign(SignalKind::FailedThenPassed),
            sign(SignalKind::TurnFailed),
            sign(SignalKind::Declined),
        ]),
        "2 failed turns, 2 interrupted turns, 2 commands that failed, then passed and a declined approval"
    );
}

#[test]
fn a_runs_cost_is_what_the_learning_session_spent_over_the_turns_that_called_a_model() {
    use strive_proto::{CallOutcome, Usage};
    let mut j = Journal::new();
    let mut call = 0;
    let mut spend = |j: &mut Journal, outcome: CallOutcome| {
        call += 1;
        j.push(Event::ModelCallStarted {
            call,
            provider: "anthropic".into(),
            model: "m".into(),
            request: Digest::from_bytes([0; 32]),
            reserved_usd_micros: 1_000_000,
            reserved_tokens: 0,
        });
        j.push(Event::ModelCallFinished { call, outcome, response: None, duration_ms: 1 });
    };
    let done = |cost| CallOutcome::Complete { status: 200, usage: Usage::default(), cost_usd_micros: cost };
    assert_eq!(cost_per_run(&j.entries()), None, "no run yet");
    j.push(requested(None));
    j.turn();
    spend(&mut j, done(20_000));
    spend(&mut j, done(10_000));
    j.end(TurnEnd::Done);
    // The judge's call comes after the turn, and is part of what a run costs.
    spend(&mut j, done(5_000));
    j.push(requested(None));
    j.turn();
    spend(&mut j, CallOutcome::Broken { reason: "cut".into(), cost_usd_micros: 60_001, tokens: 0 });
    spend(&mut j, CallOutcome::Rejected { status: 529 });
    j.end(TurnEnd::Done);
    // A turn that called no model (no key, say) isn't a run to average over.
    j.push(requested(None));
    j.turn();
    j.end(TurnEnd::Failed { error: "no key".into() });
    assert_eq!(cost_per_run(&j.entries()), Some(47_501));
}
