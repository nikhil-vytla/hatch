//! The replay gate's tasks, mined from work journals, and its verdict.

use strive_learning::replay::{Task, TaskTally, mine, relocate, verdict};
use strive_proto::{Digest, EffectOutcome, EffectRecord, Entry, Event, TurnEnd, Verdict};

/// Builds a work journal event by event, numbering entries from 1.
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
    fn next_seq(&self) -> u64 {
        self.events.len() as u64 + 1
    }
    /// A prompt with the checkpoint journaled just before it; the prompt's seq.
    fn prompt(&mut self, text: &str, commit: &str) -> u64 {
        let checkpoint = self.events.iter().filter(|e| matches!(e, Event::Checkpointed { .. })).count() as u64 + 1;
        self.events.push(Event::Checkpointed { checkpoint, commit: commit.into() });
        self.events.push(Event::UserMessage { text: text.into() });
        self.next_seq() - 1
    }
    fn bare_prompt(&mut self, text: &str) -> u64 {
        self.events.push(Event::UserMessage { text: text.into() });
        self.next_seq() - 1
    }
    fn turn(&mut self) {
        self.turn += 1;
        let through = self.next_seq() - 1;
        self.events.push(Event::TurnStarted { turn: self.turn, through_seq: Some(through) });
    }
    fn end(&mut self) {
        self.events.push(Event::TurnEnded { turn: self.turn, reason: TurnEnd::Done });
    }
    /// A command and how it exited; the seq of its finish.
    fn run(&mut self, command: &str, exit: Option<i32>) -> u64 {
        self.effect += 1;
        let record = EffectRecord::Bash { command: command.into(), timeout_ms: 1000 };
        self.events.push(Event::EffectStarted { effect: self.effect, call_id: format!("c{}", self.effect), record });
        let outcome = EffectOutcome::Done { output: Digest::from_bytes([0; 32]), exit_code: exit, truncated: false };
        self.events.push(Event::EffectFinished { effect: self.effect, outcome, duration_ms: 5 });
        self.next_seq() - 1
    }
    fn entries(&self) -> Vec<Entry> {
        self.events.iter().cloned().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: seq, event }).collect()
    }
}

#[test]
fn a_command_that_failed_and_later_passed_is_a_task_from_the_turn_it_failed_in() {
    let mut j = Journal::new();
    let prompt = j.prompt("make the parser tests pass", "c0ffee");
    j.turn();
    j.run("ls", Some(0));
    let failed = j.run("bun test src", Some(1));
    j.run("cat src/parse.ts", Some(0));
    let passed = j.run("  bun test src ", Some(0));
    j.end();
    assert_eq!(
        mine("S1", &j.entries()),
        vec![Task {
            session: "S1".into(),
            prompt_seq: prompt,
            prompt: "make the parser tests pass".into(),
            commit: "c0ffee".into(),
            check: "bun test src".into(),
            failed_seq: failed,
            passed_seq: passed,
        }]
    );
}

#[test]
fn the_passing_run_may_come_in_a_later_turn_but_the_task_is_the_turn_that_failed() {
    let mut j = Journal::new();
    let first = j.prompt("fix the build", "aaa");
    j.turn();
    j.run("make", Some(2));
    j.end();
    j.prompt("still broken: the header is missing", "bbb");
    j.turn();
    j.run("make", Some(0));
    j.end();
    let tasks = mine("S", &j.entries());
    assert_eq!(tasks.len(), 1);
    assert_eq!(
        (tasks[0].prompt_seq, tasks[0].commit.as_str(), tasks[0].prompt.as_str()),
        (first, "aaa", "fix the build")
    );
}

#[test]
fn a_command_that_never_passed_or_only_passed_is_no_task() {
    let mut j = Journal::new();
    j.prompt("run the tests", "aaa");
    j.turn();
    j.run("bun test", Some(1));
    j.run("bun test src", Some(0));
    j.run("cargo test", Some(0));
    j.end();
    assert_eq!(mine("S", &j.entries()), vec![]);
}

#[test]
fn a_pass_before_the_failure_does_not_count() {
    let mut j = Journal::new();
    j.prompt("check it", "aaa");
    j.turn();
    j.run("npm test", Some(0));
    j.run("npm test", Some(1));
    j.end();
    assert_eq!(mine("S", &j.entries()), vec![]);
}

#[test]
fn a_command_killed_by_its_timeout_has_no_exit_and_is_not_a_failure() {
    let mut j = Journal::new();
    j.prompt("run it", "aaa");
    j.turn();
    j.run("./slow", None);
    j.run("./slow", Some(0));
    j.end();
    assert_eq!(mine("S", &j.entries()), vec![]);
}

#[test]
fn a_turn_without_a_checkpoint_has_nothing_to_start_from() {
    let mut j = Journal::new();
    j.bare_prompt("fix it");
    j.turn();
    j.run("make", Some(1));
    j.run("make", Some(0));
    j.end();
    assert_eq!(mine("S", &j.entries()), vec![]);
}

#[test]
fn prompts_a_turn_took_together_are_one_task_from_the_first_ones_checkpoint() {
    let mut j = Journal::new();
    let first = j.prompt("fix the tests", "aaa");
    j.prompt("and use bun", "bbb");
    j.turn();
    j.run("bun test", Some(1));
    j.run("bun test", Some(0));
    j.end();
    let tasks = mine("S", &j.entries());
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].prompt_seq, first);
    assert_eq!(tasks[0].commit, "aaa");
    assert_eq!(tasks[0].prompt, "fix the tests\n\nand use bun");
}

#[test]
fn one_task_per_turn_its_first_red_to_green_command() {
    let mut j = Journal::new();
    j.prompt("fix lint and tests", "aaa");
    j.turn();
    j.run("npm run lint", Some(1));
    j.run("npm test", Some(1));
    j.run("npm test", Some(0));
    j.run("npm run lint", Some(0));
    j.end();
    j.prompt("now the types", "bbb");
    j.turn();
    j.run("tsc", Some(2));
    j.run("tsc", Some(0));
    j.end();
    let checks: Vec<String> = mine("S", &j.entries()).into_iter().map(|t| t.check).collect();
    assert_eq!(checks, vec!["npm run lint".to_string(), "tsc".to_string()]);
}

#[test]
fn a_command_too_long_to_be_a_plain_check_is_skipped_for_the_next() {
    let long = format!("echo {}", "x".repeat(400));
    let mut j = Journal::new();
    j.prompt("do it", "aaa");
    j.turn();
    j.run(&long, Some(1));
    j.run("make", Some(1));
    j.run(&long, Some(0));
    j.run("make", Some(0));
    j.end();
    let tasks = mine("S", &j.entries());
    assert_eq!(tasks.iter().map(|t| t.check.as_str()).collect::<Vec<_>>(), vec!["make"]);
}

#[test]
fn a_check_that_names_the_project_runs_in_the_scratch_copy_instead() {
    let to = "/tmp/strive-replay-1/work";
    assert_eq!(relocate("cd /p/app && sh check.sh", "/p/app", to), format!("cd {to} && sh check.sh"));
    assert_eq!(relocate("cat /p/app/src/a.ts /p/app", "/p/app", to), format!("cat {to}/src/a.ts {to}"));
    assert_eq!(relocate("cd '/p/app'; make", "/p/app", to), format!("cd '{to}'; make"));
}

#[test]
fn a_sibling_whose_name_starts_with_the_projects_is_left_alone() {
    let to = "/w";
    assert_eq!(relocate("cd /p/app2 && make", "/p/app", to), "cd /p/app2 && make");
    assert_eq!(relocate("ls /p/app.bak /p/app-old /p/app_x", "/p/app", to), "ls /p/app.bak /p/app-old /p/app_x");
    assert_eq!(relocate("sh check.sh", "/p/app", to), "sh check.sh");
}

fn tally(with: (u32, u32), without: (u32, u32)) -> TaskTally {
    TaskTally {
        session: "S".into(),
        prompt_seq: 4,
        check: "make".into(),
        with_passed: with.0,
        with_runs: with.1,
        without_passed: without.0,
        without_runs: without.1,
    }
}

#[test]
fn passing_more_often_with_the_change_passes() {
    let (v, detail) = verdict(&[tally((3, 3), (1, 3)), tally((1, 3), (1, 3))], "claude-haiku-4-5", "$0.0100");
    assert_eq!(v, Verdict::Pass);
    let lines: Vec<&str> = detail.lines().collect();
    assert_eq!(lines[0], "with the change 4/6 passed, without 2/6; 2 tasks");
    assert_eq!(lines[1], "claude-haiku-4-5, $0.0100");
    assert_eq!(lines[2], "session S #4 `make`: with 3/3, without 1/3");
}

#[test]
fn a_tie_is_inconclusive_not_a_pass() {
    for (with, without) in [((3, 3), (3, 3)), ((2, 3), (2, 3)), ((2, 4), (1, 2))] {
        let (v, detail) = verdict(&[tally(with, without)], "m", "c");
        assert_eq!(v, Verdict::Skipped, "{with:?} against {without:?}");
        assert!(detail.starts_with("inconclusive: the change made no difference, with the change"), "{detail}");
    }
}

#[test]
fn passing_less_often_with_the_change_fails() {
    let (v, detail) = verdict(&[tally((1, 3), (2, 3))], "m", "c");
    assert_eq!(v, Verdict::Fail);
    assert!(detail.starts_with("failed: with the change 1/3 passed, without 2/3; 1 task\n"), "{detail}");
}

#[test]
fn rates_are_compared_not_counts() {
    // 2 of 4 is less than 2 of 3, though the counts are equal.
    assert_eq!(verdict(&[tally((2, 4), (2, 3))], "m", "c").0, Verdict::Fail);
    assert_eq!(verdict(&[tally((2, 3), (2, 4))], "m", "c").0, Verdict::Pass);
}

#[test]
fn every_run_failing_on_both_sides_is_inconclusive() {
    let (v, detail) = verdict(&[tally((0, 3), (0, 3))], "m", "c");
    assert_eq!(v, Verdict::Skipped);
    assert!(detail.starts_with("inconclusive: every run failed"), "{detail}");
    assert_eq!(verdict(&[tally((0, 3), (1, 3))], "m", "c").0, Verdict::Fail);
    assert_eq!(verdict(&[tally((1, 3), (0, 3))], "m", "c").0, Verdict::Pass);
}
