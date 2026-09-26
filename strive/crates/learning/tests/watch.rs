//! Watches: predictions checked on later work journals (ADR-0019), their
//! bounds, their form, and the tally that marks one not holding.
#![expect(clippy::expect_used, reason = "a test fails by panicking, helpers included")]

use std::collections::{BTreeMap, HashMap};

use WatchOutcome::{Confirmed as C, Contradicted as X, NotApplicable as N};
use strive_learning::watch::{
    Checked, OUTPUT_SCAN, RECENT, STEP_LIMIT, TEXT_LIMIT, TOTAL_SCAN, check, describe, problems, tally, tally_text,
};
use strive_learning::{Rule, fold};
use strive_proto::{
    Artifact, Digest, EffectOutcome, EffectRecord, Entry, Event, Evidence, ExitMatch, Expect, Proposal, StepMatch,
    TurnEnd, Watch, WatchOutcome,
};

/// A work journal, built event by event, with each command's output kept
/// in a store of its own.
struct Journal {
    events: Vec<Event>,
    outputs: HashMap<Digest, Vec<u8>>,
    turn: u64,
    effect: u64,
}

impl Journal {
    fn new() -> Self {
        let started = Event::SessionStarted { format: 1, cwd: "/p".into(), strive_version: "0".into(), kind: None };
        Self { events: vec![started], outputs: HashMap::new(), turn: 0, effect: 0 }
    }
    fn seq(&self) -> u64 {
        self.events.len() as u64
    }
    /// A prompt and the start of its turn; the prompt's seq.
    fn prompt(&mut self, text: &str) -> u64 {
        self.events.push(Event::UserMessage { text: text.into() });
        let seq = self.seq();
        self.turn += 1;
        self.events.push(Event::TurnStarted { turn: self.turn, through_seq: Some(seq) });
        seq
    }
    fn end(&mut self) {
        self.events.push(Event::TurnEnded { turn: self.turn, reason: TurnEnd::Done });
    }
    /// A command that ran; the seq it started at.
    fn run(&mut self, command: &str, output: &[u8], exit: Option<i32>) -> u64 {
        self.effect += 1;
        let mut id = [0u8; 32];
        id[..8].copy_from_slice(&self.effect.to_be_bytes());
        let digest = Digest::from_bytes(id);
        self.outputs.insert(digest, output.to_vec());
        let record = EffectRecord::Bash { command: command.into(), timeout_ms: 1000 };
        self.events.push(Event::EffectStarted { effect: self.effect, call_id: format!("c{}", self.effect), record });
        let seq = self.seq();
        let outcome = EffectOutcome::Done { output: digest, exit_code: exit, truncated: false };
        self.events.push(Event::EffectFinished { effect: self.effect, outcome, duration_ms: 5 });
        seq
    }
    fn refused(&mut self, command: &str) {
        self.effect += 1;
        let record = EffectRecord::Bash { command: command.into(), timeout_ms: 1000 };
        self.events.push(Event::EffectStarted { effect: self.effect, call_id: format!("c{}", self.effect), record });
        let outcome = EffectOutcome::Refused { reason: "declined".into() };
        self.events.push(Event::EffectFinished { effect: self.effect, outcome, duration_ms: 5 });
    }
    fn entries(&self) -> Vec<Entry> {
        self.events.iter().cloned().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: seq, event }).collect()
    }
    /// The watch read on this journal, and how many outputs it fetched.
    fn check(&self, w: &Watch) -> (Option<Checked>, usize) {
        let mut fetched = 0;
        let mut get = |d: &Digest| {
            fetched += 1;
            self.outputs.get(d).cloned()
        };
        let checked = check(w, &self.entries(), &mut get);
        (checked, fetched)
    }
    fn outcome(&self, w: &Watch) -> WatchOutcome {
        self.check(w).0.expect("a turn ended").outcome
    }
}

fn command(c: &str) -> StepMatch {
    StepMatch { command: Some(c.into()), ..StepMatch::default() }
}

fn output_of(c: &str, o: &str) -> StepMatch {
    StepMatch { command: Some(c.into()), output: Some(o.into()), ..StepMatch::default() }
}

fn prompt(p: &str) -> StepMatch {
    StepMatch { prompt: Some(p.into()), ..StepMatch::default() }
}

/// "In sessions that run `bun test`, no output of it says `no display`."
fn no_display() -> Watch {
    Watch { when: Some(command("bun test")), expect: Expect::Never { step: output_of("bun test", "no display") } }
}

#[test]
fn a_never_watch_is_confirmed_contradicted_or_not_applicable() {
    let mut ok = Journal::new();
    ok.prompt("run the tests");
    ok.run("bun test packages/host", b"12 pass\n", Some(0));
    ok.end();
    assert_eq!(ok.outcome(&no_display()), WatchOutcome::Confirmed);

    let mut bad = Journal::new();
    bad.prompt("run the tests");
    bad.run("ls", b"no display here, but not from the tests\n", Some(0));
    let failed = bad.run("bun test", b"error: No Display found\n", Some(1));
    bad.end();
    let (checked, _) = bad.check(&no_display());
    let checked = checked.unwrap();
    assert_eq!(checked.outcome, WatchOutcome::Contradicted, "case doesn't matter");
    assert_eq!(checked.detail, format!("#{failed} ran `bun test` (exit 1)"));
    assert_eq!(checked.through_seq, bad.seq());

    let mut other = Journal::new();
    other.prompt("tidy the changelog");
    other.run("git log", b"no display\n", Some(0));
    other.end();
    let (checked, _) = other.check(&no_display());
    let checked = checked.unwrap();
    assert_eq!(checked.outcome, WatchOutcome::NotApplicable);
    assert_eq!(checked.detail, "no step is a command containing \"bun test\"");
}

#[test]
fn an_any_watch_needs_a_step_that_matches() {
    let w = Watch {
        when: None,
        expect: Expect::Any { step: StepMatch { exit: Some(ExitMatch::Zero), ..command("make") } },
    };
    let mut j = Journal::new();
    j.prompt("build it");
    j.run("make", b"", Some(2));
    j.end();
    assert_eq!(j.outcome(&w), WatchOutcome::Contradicted);
    j.prompt("again");
    j.run("make all", b"", Some(0));
    j.end();
    assert_eq!(j.outcome(&w), WatchOutcome::Confirmed, "a later turn changes the answer");
}

#[test]
fn a_first_watch_reads_the_first_matching_step_only() {
    let w = Watch { when: None, expect: Expect::First { of: command("test"), is: command("bun test src") } };
    let mut good = Journal::new();
    good.prompt("fix it");
    good.run("cat src/a.ts", b"", Some(0));
    good.run("bun test src", b"", Some(1));
    good.run("bun test", b"", Some(1));
    good.end();
    assert_eq!(good.outcome(&w), WatchOutcome::Confirmed);

    let mut bad = Journal::new();
    bad.prompt("fix it");
    let first = bad.run("bun test", b"", Some(1));
    bad.run("bun test src", b"", Some(0));
    bad.end();
    let checked = bad.check(&w).0.unwrap();
    assert_eq!(
        (checked.outcome, checked.detail),
        (WatchOutcome::Contradicted, format!("#{first} ran `bun test` (exit 1)"))
    );

    let mut none = Journal::new();
    none.prompt("hello");
    none.end();
    assert_eq!(none.outcome(&w), WatchOutcome::NotApplicable);
}

#[test]
fn a_prompt_watch_reads_what_the_user_said() {
    let w = Watch { when: None, expect: Expect::Never { step: prompt("use bun, not npm") } };
    let mut j = Journal::new();
    j.prompt("run the tests");
    j.run("use bun, not npm", b"", Some(0));
    j.end();
    assert_eq!(j.outcome(&w), WatchOutcome::Confirmed, "a command isn't a prompt");
    j.prompt("No. Use Bun, not npm!");
    j.end();
    assert_eq!(j.outcome(&w), WatchOutcome::Contradicted);
}

#[test]
fn only_commands_that_ran_and_turns_that_ended_count() {
    let w = Watch { when: None, expect: Expect::Never { step: command("rm -rf") } };
    let mut j = Journal::new();
    j.prompt("clean up");
    assert_eq!(j.check(&w).0, None, "no turn has ended");
    j.refused("rm -rf build");
    j.end();
    assert_eq!(j.outcome(&w), WatchOutcome::Confirmed, "a refused command did nothing");
    j.prompt("do it");
    j.run("rm -rf build", b"", Some(0));
    assert_eq!(j.outcome(&w), WatchOutcome::Confirmed, "the turn that ran it hasn't ended");
    j.end();
    assert_eq!(j.outcome(&w), WatchOutcome::Contradicted);
}

#[test]
fn a_session_with_no_prompt_is_not_applicable() {
    let mut j = Journal::new();
    j.end();
    let checked = j.check(&Watch { when: None, expect: Expect::Never { step: command("x") } }).0.unwrap();
    assert_eq!((checked.outcome, checked.detail.as_str()), (WatchOutcome::NotApplicable, "the session has no prompt"));
}

#[test]
fn outputs_are_fetched_only_when_a_pattern_needs_them_and_once_each() {
    let mut j = Journal::new();
    j.prompt("run the tests");
    for _ in 0..5 {
        j.run("ls", b"no display", Some(0));
    }
    j.run("bun test", b"ok", Some(0));
    j.end();
    let (checked, fetched) = j.check(&no_display());
    assert_eq!(checked.unwrap().outcome, WatchOutcome::Confirmed);
    assert_eq!(fetched, 1, "only the output of the command the pattern names is read");
    let once = |_: &Digest| Some(b"x".to_vec());
    let mut calls = 0;
    let mut counted = |d: &Digest| {
        calls += 1;
        once(d)
    };
    let w = Watch {
        when: Some(output_of("bun test", "x")),
        expect: Expect::Never { step: output_of("bun test", "no display") },
    };
    check(&w, &j.entries(), &mut counted);
    assert_eq!(calls, 1, "when and the expectation share one read of the output");
}

#[test]
fn a_huge_output_is_read_at_its_ends_and_a_miss_in_the_middle_is_unknown() {
    let big = OUTPUT_SCAN * 4;
    let mut middle = vec![b'a'; big];
    middle[big / 2..big / 2 + 10].copy_from_slice(b"no display");
    let mut tail = vec![b'a'; big];
    tail[big - 10..].copy_from_slice(b"no display");

    let mut j = Journal::new();
    j.prompt("run the tests");
    j.run("bun test", &middle, Some(1));
    j.end();
    let checked = j.check(&no_display()).0.unwrap();
    assert_eq!(checked.outcome, WatchOutcome::NotApplicable, "the needle may be in the part not read");
    assert!(checked.detail.contains("wasn't all read"), "{}", checked.detail);

    let mut j = Journal::new();
    j.prompt("run the tests");
    j.run("bun test", &tail, Some(1));
    j.end();
    assert_eq!(j.outcome(&no_display()), WatchOutcome::Contradicted, "an error at the end is read");
}

#[test]
fn a_session_reads_at_most_its_total_of_output() {
    let each = OUTPUT_SCAN;
    let n = TOTAL_SCAN / each + 8;
    let mut j = Journal::new();
    j.prompt("run the tests");
    for _ in 0..n {
        j.run("bun test", &vec![b'a'; each], Some(0));
    }
    j.end();
    let (checked, fetched) = j.check(&no_display());
    assert_eq!(checked.unwrap().outcome, WatchOutcome::NotApplicable, "what wasn't read can't confirm");
    assert_eq!(fetched, TOTAL_SCAN / each, "fetching stops once the total is spent");
}

#[test]
fn a_session_reads_at_most_its_steps_and_says_so() {
    let mut j = Journal::new();
    j.prompt("go");
    for _ in 0..STEP_LIMIT + 50 {
        j.run("ls", b"", Some(0));
    }
    j.run("rm -rf /", b"", Some(0));
    j.end();
    let w = Watch { when: None, expect: Expect::Never { step: command("rm -rf") } };
    let checked = j.check(&w).0.unwrap();
    assert_eq!(checked.outcome, WatchOutcome::NotApplicable);
    assert!(checked.detail.contains("too long to check whole"), "{}", checked.detail);
    let found = Watch { when: None, expect: Expect::Any { step: command("ls") } };
    assert_eq!(j.outcome(&found), WatchOutcome::Confirmed, "what was read still decides what it can");
}

#[test]
fn a_huge_prompt_is_read_at_its_start() {
    let mut text = "x".repeat(OUTPUT_SCAN * 2);
    text.push_str("use bun");
    let mut j = Journal::new();
    j.prompt(&text);
    j.end();
    let w = Watch { when: None, expect: Expect::Never { step: prompt("use bun") } };
    assert_eq!(j.outcome(&w), WatchOutcome::NotApplicable);
}

#[test]
fn malformed_watches_are_named() {
    let long = "x".repeat(TEXT_LIMIT + 1);
    let cases: Vec<(Watch, &str)> = vec![
        (Watch { when: None, expect: Expect::Never { step: StepMatch::default() } }, "names nothing to match"),
        (
            Watch {
                when: None,
                expect: Expect::Never { step: StepMatch { prompt: Some("a".into()), ..command("b") } },
            },
            "mixes a prompt",
        ),
        (Watch { when: None, expect: Expect::Any { step: command("  ") } }, "command is empty"),
        (Watch { when: None, expect: Expect::Any { step: command(&long) } }, "the limit is 200"),
        (Watch { when: Some(prompt("a\nb")), expect: Expect::Any { step: command("x") } }, "line break"),
        (Watch { when: None, expect: Expect::First { of: prompt("a"), is: command("b") } }, "can't both match"),
    ];
    for (w, why) in cases {
        let found = problems(&w);
        assert!(found.iter().any(|p| p.contains(why)), "{why}: {found:?}");
    }
    assert_eq!(problems(&no_display()), Vec::<String>::new());
}

fn with_watch(w: Watch) -> Proposal {
    Proposal {
        artifact: Artifact::Memory,
        content: "- Run `bun test packages/host`.\n".into(),
        summary: "Run the host tests".into(),
        rationale: "the root run needs a display".into(),
        evidence: vec![Evidence { session: "S".into(), seqs: vec![1], note: "n".into() }],
        prediction: "no display errors".into(),
        watch: Some(Box::new(w)),
    }
}

#[test]
fn the_static_gate_fails_a_malformed_or_hidden_watch() {
    let rules = |p: &Proposal| strive_learning::check(p, &[]).into_iter().map(|f| f.rule).collect::<Vec<_>>();
    assert_eq!(rules(&with_watch(no_display())), vec![]);
    let empty = Watch { when: None, expect: Expect::Never { step: StepMatch::default() } };
    assert_eq!(rules(&with_watch(empty)), vec![Rule::Watch]);
    let hidden = Watch { when: None, expect: Expect::Never { step: command("bun\u{200B}test") } };
    assert_eq!(rules(&with_watch(hidden)), vec![Rule::Hidden]);
}

#[test]
fn a_watch_reads_as_a_sentence() {
    assert_eq!(
        describe(&no_display()),
        "in sessions with a command containing \"bun test\": never a command containing \"bun test\" whose output contains \"no display\""
    );
    let first = Watch {
        when: None,
        expect: Expect::First {
            of: command("test"),
            is: StepMatch { exit: Some(ExitMatch::Zero), ..command("bun test src") },
        },
    };
    assert_eq!(
        describe(&first),
        "in every session: the first step that is a command containing \"test\" is also a command containing \"bun test src\" that exited 0"
    );
}

fn outcomes(list: &[WatchOutcome]) -> BTreeMap<String, WatchOutcome> {
    list.iter().enumerate().map(|(i, o)| (format!("S{i:03}"), *o)).collect()
}

#[test]
fn a_prediction_is_not_holding_after_enough_recent_contradictions_that_outnumber_confirmations() {
    let t = tally(&outcomes(&[C, X, N, X]));
    assert_eq!((t.confirmed, t.contradicted, t.not_applicable, t.not_holding), (1, 2, 1, false), "two is noise");
    let t = tally(&outcomes(&[C, X, N, X, C, X]));
    assert_eq!((t.recent_confirmed, t.recent_contradicted, t.not_holding), (2, 3, true));
    let t = tally(&outcomes(&[C, X, C, X, C, X]));
    assert!(!t.not_holding, "as many confirmed as contradicted");
    // Contradictions older than the last RECENT sessions it applied to don't count.
    let mut old = vec![X; 5];
    old.extend(vec![C; RECENT - 2]);
    old.extend([X, X]);
    let t = tally(&outcomes(&old));
    assert_eq!((t.contradicted, t.recent_contradicted, t.not_holding), (7, 2, false));
    // Sessions it didn't apply to don't push older ones out.
    let mut padded = vec![X, X, X];
    padded.extend(vec![N; 20]);
    assert!(tally(&outcomes(&padded)).not_holding);
}

#[test]
fn a_tally_reads_as_counts_and_says_when_it_isnt_holding() {
    assert_eq!(tally_text(&tally(&outcomes(&[]))), "no session has been checked yet");
    assert_eq!(tally_text(&tally(&outcomes(&[N, N]))), "it hasn't applied to any of the 2 sessions checked");
    assert_eq!(
        tally_text(&tally(&outcomes(&[C, N, X]))),
        "confirmed in 1, contradicted in 1 of 2 sessions (1 more it didn't apply to)"
    );
    assert_eq!(
        tally_text(&tally(&outcomes(&[X, X, X, C]))),
        "not holding: confirmed in 1, contradicted in 3 of 4 sessions; 3 of the last 4 it applied to contradicted it"
    );
}

#[test]
fn the_fold_tallies_each_sessions_latest_check_for_watched_proposals_only() {
    let started = Event::SessionStarted { format: 1, cwd: "/p".into(), strive_version: "0".into(), kind: None };
    let checked = |session: &str, outcome| Event::PredictionChecked {
        proposal: 2,
        session: session.into(),
        through_seq: 9,
        outcome,
        detail: String::new(),
    };
    let mut plain = with_watch(no_display());
    plain.watch = None;
    let events = vec![
        started,
        Event::ProposalMade { call_id: None, proposal: with_watch(no_display()), before: None, mode: None },
        Event::ProposalMade { call_id: None, proposal: plain, before: None, mode: None },
        checked("S1", X),
        checked("S1", C),
        checked("S2", X),
    ];
    let entries: Vec<Entry> =
        events.into_iter().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: seq, event }).collect();
    let folded = fold(&entries);
    let t = folded[0].state.prediction.unwrap();
    assert_eq!((t.confirmed, t.contradicted), (1, 1), "S1 counts once, by its latest");
    assert_eq!(folded[1].state.prediction, None, "no watch, no tally");
}

#[test]
fn memory_names_project_paths_only_when_they_read_unambiguously_as_paths() {
    let memory = "- Run `bun test packages/host`, not `bun test`.\n\
                  - The parser lives in `src/parse.ts`; see `docs/ADR.md:12`.\n\
                  - Config is `.github/workflows/ci.yml`, not `/etc/ci` or `~/ci/x` or `../up/x`.\n\
                  - Globs like `src/*.ts` and URLs like `https://x.dev/a` aren't paths; `src/parse.ts` again isn't new.\n";
    assert_eq!(
        strive_learning::stale::named_paths(memory),
        vec![
            (2, "src/parse.ts".to_string()),
            (2, "docs/ADR.md".to_string()),
            (3, ".github/workflows/ci.yml".to_string()),
        ]
    );
}
