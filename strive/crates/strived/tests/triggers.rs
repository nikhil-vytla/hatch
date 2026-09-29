//! Automatic learning (ADR-0020) through the real daemon: work sessions whose
//! turns a test host records, the idle scan, its limits, the `learning`
//! setting, and what `strive review` shows. No model is called: the learner
//! is played by a test connection, and the upstream is a dead port.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{Env, Rpc};
use serde_json::{Value, json};

fn project() -> PathBuf {
    tempfile::Builder::new().prefix("strv-proj").tempdir_in("/tmp").unwrap().keep().canonicalize().unwrap()
}

/// A daemon whose settings hold `learning`, with an Anthropic key or none.
/// Automatic runs are opted into (`suggest`) unless `learning` names a mode.
fn daemon(learning: &Value, key: bool) -> Env {
    let env = if key { Env::with_vars(&[("ANTHROPIC_API_KEY", "sk-test-trigger")]) } else { Env::new() };
    let mut learning = learning.clone();
    learning.as_object_mut().unwrap().entry("mode").or_insert(json!("suggest"));
    fs::write(env.home.path().join("settings.json"), json!({"learning": learning}).to_string()).unwrap();
    env
}

/// A work session with a person and a host that records its turns.
struct Work {
    id: String,
    person: Rpc,
    host: Rpc,
    turn: u64,
}

impl Work {
    fn new(env: &Env, cwd: &Path) -> Self {
        let mut person = common::slow_rpc(env);
        let id = person.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
        let mut host = common::slow_rpc(env);
        host.ok("host/register", &json!({"id": id}));
        Self { id, person, host, turn: 0 }
    }

    /// A prompt and a turn that ends as `reason`; the prompt's seq and the
    /// turn end's.
    fn exchange(&mut self, prompt: &str, reason: &Value) -> (u64, u64) {
        let asked = self.person.ok("session/prompt", &json!({"id": self.id, "text": prompt}))["seq"].as_u64().unwrap();
        self.turn += 1;
        self.host.ok("host/record", &json!({"id": self.id, "event": {"type": "turnStarted", "turn": self.turn}}));
        let event = json!({"type": "turnEnded", "turn": self.turn, "reason": reason});
        let ended = self.host.ok("host/record", &json!({"id": self.id, "event": event}))["seq"].as_u64().unwrap();
        (asked, ended)
    }
}

fn done() -> Value {
    json!({"kind": "done"})
}

/// The project's learning session, if there is one; never creates it.
fn learning(env: &Env, cwd: &Path) -> Option<String> {
    let r = common::slow_rpc(env).ok("session/list", &json!({"cwd": cwd, "kind": "learning"}));
    r["sessions"].as_array().unwrap().first().map(|s| s["id"].as_str().unwrap().to_string())
}

fn events(env: &Env, id: &str, kind: &str) -> Vec<Value> {
    let r = common::slow_rpc(env).ok("session/read", &json!({"id": id}));
    r["entries"].as_array().unwrap().iter().filter(|e| e["event"]["type"] == kind).map(|e| e["event"].clone()).collect()
}

/// The learning session's `kind` events, once there are at least `n`.
fn wait_events(env: &Env, cwd: &Path, kind: &str, n: usize) -> Vec<Value> {
    let mut got = Vec::new();
    common::wait_for(&format!("{n} {kind}"), Duration::from_secs(20), || {
        got = learning(env, cwd).map(|id| events(env, &id, kind)).unwrap_or_default();
        got.len() >= n
    });
    got
}

fn log(env: &Env) -> String {
    fs::read_to_string(env.home.path().join("logs/strived.log")).unwrap_or_default()
}

/// Waits until the daemon's log holds `needle` more times than `before`.
fn wait_log(env: &Env, needle: &str, before: usize) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while log(env).matches(needle).count() <= before {
        assert!(
            std::time::Instant::now() < deadline,
            "timed out waiting for the log to say {needle:?}; it says:\n{}",
            log(env)
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The learner, played by a connection registered as the learning
/// session's host.
struct Learner {
    id: String,
    host: Rpc,
    turn: u64,
}

impl Learner {
    fn new(env: &Env, cwd: &Path) -> Self {
        let id = learning(env, cwd).unwrap();
        let mut host = common::slow_rpc(env);
        host.ok("host/register", &json!({"id": id}));
        Self { id, host, turn: 0 }
    }

    /// Takes every request so far in one turn, records `proposals`, and ends
    /// the turn. The proposals' ids.
    fn turn(&mut self, proposals: &[Value]) -> Vec<u64> {
        self.turn += 1;
        learner_turn(&mut self.host, &self.id, self.turn, proposals)
    }
}

fn learner_turn(host: &mut Rpc, id: &str, turn: u64, proposals: &[Value]) -> Vec<u64> {
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": turn}}));
    let ids = proposals
        .iter()
        .map(|p| {
            let r = host.ok("host/record", &json!({"id": id, "event": {"type": "proposalMade", "proposal": p}}));
            r["seq"].as_u64().unwrap()
        })
        .collect();
    host.ok(
        "host/record",
        &json!({"id": id, "event": {"type": "turnEnded", "turn": turn, "reason": {"kind": "done"}}}),
    );
    ids
}

fn memory(evidence: &str) -> Value {
    json!({
        "artifact": {"kind": "memory"},
        "content": "- Run the tests with `bun test`, not `npm test`.\n",
        "summary": "Tests run with bun",
        "rationale": "The user corrected npm test to bun test",
        "evidence": [{"session": evidence, "seqs": [1], "note": "the session began here"}],
        "prediction": "no later session runs npm test",
    })
}

fn review(env: &Env, cwd: &Path, args: &[&str]) -> String {
    let out = env.strive_in(cwd, args);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// Automatic runs on, and a short idle wait.
fn idle() -> Value {
    json!({"mode": "suggest", "idleSeconds": 1})
}

#[test]
fn an_idle_session_with_a_correction_asks_the_learner_once_for_those_signs() {
    let env = daemon(&idle(), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("run the tests", &done());
    let (fix, _) = w.exchange("no, use bun test", &done());

    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(
        asked[0],
        json!({
            "type": "learnRequested",
            "sessions": [w.id],
            "trigger": {"kind": "idle", "signals": [
                {"session": w.id, "seq": fix, "kind": "correction", "detail": "no, use bun test"}
            ]},
        })
    );
    Learner::new(&env, &cwd).turn(&[]);

    // The same session goes idle again with nothing new: the correction was
    // acted on, so nothing is asked.
    let scanned = format!("session {} scanned for learning: no new signs", w.id);
    let before = log(&env).matches(&scanned).count();
    w.exchange("thanks", &done());
    wait_log(&env, &scanned, before);

    // A new sign is: the next request names only it.
    let (_, interrupted) = w.exchange("now tidy the imports", &json!({"kind": "interrupted"}));
    let asked = wait_events(&env, &cwd, "learnRequested", 2);
    assert_eq!(asked.len(), 2, "{asked:?}");
    let signals = &asked[1]["trigger"]["signals"];
    assert_eq!(signals.as_array().unwrap().len(), 1, "{signals}");
    assert_eq!((&signals[0]["kind"], &signals[0]["seq"]), (&json!("interrupted"), &json!(interrupted)));
    assert_eq!(events(&env, &learning(&env, &cwd).unwrap(), "learnSkipped"), Vec::<Value>::new());
}

#[test]
fn a_clean_session_asks_nothing_and_makes_no_learning_session() {
    let env = daemon(&idle(), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("add a --verbose flag", &done());
    w.exchange("now a test for it", &done());
    wait_log(&env, &format!("session {} scanned for learning: no new signs", w.id), 0);
    assert_eq!(learning(&env, &cwd), None);
}

#[test]
fn a_prompt_before_the_idle_time_is_up_puts_the_scan_off() {
    // The prompt must land inside the wait, and a prompt takes a git
    // checkpoint first, which a loaded machine has taken over 2s to make.
    let env = daemon(&json!({"idleSeconds": 6}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    let (_, ended) = w.exchange("go", &json!({"kind": "interrupted"}));
    // Prompted at once, with no turn yet: the interrupted turn's wait finds it.
    w.person.ok("session/prompt", &json!({"id": w.id, "text": "go on"}));
    wait_log(
        &env,
        &format!("session {} not scanned for learning: prompted within idleSeconds of entry {ended}", w.id),
        0,
    );
    assert_eq!(learning(&env, &cwd), None);
}

#[test]
fn a_journal_that_stops_verifying_in_the_wait_is_logged_as_such_not_as_prompted() {
    let env = daemon(&json!({"idleSeconds": 2}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("tamper-with-me", &json!({"kind": "interrupted"}));
    let path = env.session_dir(&w.id).join("journal.jsonl");
    let text = fs::read_to_string(&path).unwrap();
    fs::write(&path, text.replace("tamper-with-me", "TAMPER-WITH-ME")).unwrap();
    wait_log(&env, &format!("session {} not scanned for learning: its journal doesn't verify", w.id), 0);
    assert!(!log(&env).contains("prompted within idleSeconds"), "{}", log(&env));
}

#[test]
fn every_n_turns_scans_without_waiting_for_idle() {
    let env = daemon(&json!({"idleSeconds": 3600, "everyTurns": 2}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    let (_, interrupted) = w.exchange("go", &json!({"kind": "interrupted"}));
    w.exchange("go on", &done());
    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(asked[0]["trigger"]["kind"], "turns", "{asked:?}");
    assert_eq!(asked[0]["trigger"]["signals"][0]["seq"], interrupted);
    // Had the first turn's end scanned too, this request would have waited
    // behind that one and been skipped.
    assert_eq!(events(&env, &learning(&env, &cwd).unwrap(), "learnSkipped"), Vec::<Value>::new());
}

#[test]
fn a_run_still_going_holds_the_next_automatic_one_back() {
    let env = daemon(&idle(), true);
    let cwd = project();
    let mut a = Work::new(&env, &cwd);
    a.exchange("go", &json!({"kind": "interrupted"}));
    wait_events(&env, &cwd, "learnRequested", 1);
    // No learner has taken that request.
    let mut b = Work::new(&env, &cwd);
    b.exchange("run the tests", &done());
    let (fix, _) = b.exchange("I said bun, not npm", &done());
    let skipped = wait_events(&env, &cwd, "learnSkipped", 1);
    assert_eq!(skipped[0]["reason"], "a learner run is still going");
    assert_eq!(skipped[0]["trigger"]["signals"][0]["seq"], fix);
    assert_eq!(skipped[0]["trigger"]["signals"][0]["session"], json!(b.id));

    // Once that run is over, the session skipped meanwhile is scanned again:
    // nothing else would, as it isn't prompted again.
    Learner::new(&env, &cwd).turn(&[]);
    wait_events(&env, &cwd, "learnRequested", 2);
    let asked: Vec<(Value, Value)> =
        runs(&env, &cwd).iter().map(|e| (e["type"].clone(), e["trigger"]["signals"][0]["session"].clone())).collect();
    assert_eq!(
        asked,
        [
            (json!("learnRequested"), json!(a.id)),
            (json!("learnSkipped"), json!(b.id)),
            (json!("learnRequested"), json!(b.id))
        ]
    );
}

/// The learning session's requests and skips, in order.
fn runs(env: &Env, cwd: &Path) -> Vec<Value> {
    let id = learning(env, cwd).unwrap();
    let r = common::slow_rpc(env).ok("session/read", &json!({"id": id}));
    r["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event"].clone())
        .filter(|e| e["type"] == "learnRequested" || e["type"] == "learnSkipped")
        .collect()
}

#[test]
fn a_turn_the_daemon_ends_for_a_host_that_left_is_scanned_once_idle() {
    let env = daemon(&idle(), true);
    let cwd = project();
    let mut person = common::slow_rpc(&env);
    let id = person.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let mut host = common::slow_rpc(&env);
    host.ok("host/register", &json!({"id": id}));
    person.ok("session/prompt", &json!({"id": id, "text": "go"}));
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
    // The host goes mid-turn: the daemon ends the turn as failed.
    drop(host);
    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(asked[0]["trigger"]["signals"][0]["kind"], "turnFailed", "{asked:?}");
    assert_eq!(asked[0]["sessions"], json!([id]));
}

#[test]
fn the_daily_cap_skips_runs_past_it_and_review_says_why() {
    let env = daemon(&json!({"idleSeconds": 1, "dailyRuns": 1}), true);
    let cwd = project();
    let mut a = Work::new(&env, &cwd);
    a.exchange("go", &json!({"kind": "interrupted"}));
    wait_events(&env, &cwd, "learnRequested", 1);
    Learner::new(&env, &cwd).turn(&[]);

    let mut b = Work::new(&env, &cwd);
    b.exchange("go", &json!({"kind": "failed", "error": "the provider refused: overloaded"}));
    let skipped = wait_events(&env, &cwd, "learnSkipped", 1);
    let reason = skipped[0]["reason"].as_str().unwrap();
    assert!(reason.starts_with("1 automatic run already started in the last 24 hours"), "{reason}");
    assert_eq!(skipped[0]["trigger"]["signals"][0]["kind"], "turnFailed");
    // A later scan of the same session is skipped too, and nothing ran between.
    b.exchange("thanks", &done());
    wait_events(&env, &cwd, "learnSkipped", 2);
    let kinds: Vec<Value> = runs(&env, &cwd).iter().map(|e| e["type"].clone()).collect();
    assert_eq!(kinds, [json!("learnRequested"), json!("learnSkipped"), json!("learnSkipped")]);

    let listed = review(&env, &cwd, &["review"]);
    assert!(
        listed.contains("an automatic learning run was skipped")
            && listed.contains(&format!("a failed turn in session {}", b.id))
            && listed.contains(reason),
        "{listed}"
    );
}

#[test]
fn a_person_can_still_learn_past_the_cap() {
    let env = daemon(&json!({"idleSeconds": 1, "dailyRuns": 0}), true);
    let cwd = project();
    let mut a = Work::new(&env, &cwd);
    a.exchange("go", &json!({"kind": "interrupted"}));
    let skipped = wait_events(&env, &cwd, "learnSkipped", 1);
    assert!(skipped[0]["reason"].as_str().unwrap().starts_with("0 automatic runs"), "{skipped:?}");
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(asked[0], json!({"type": "learnRequested", "sessions": []}), "a person's request has no trigger");
}

#[test]
fn automatic_runs_are_off_unless_settings_turn_them_on() {
    // Settings that say nothing of the mode.
    let env = Env::with_vars(&[("ANTHROPIC_API_KEY", "sk-test-trigger")]);
    fs::write(env.home.path().join("settings.json"), json!({"learning": {"idleSeconds": 1}}).to_string()).unwrap();
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &json!({"kind": "interrupted"}));
    wait_log(&env, &format!("session {} not scanned for learning: \"learning\" is off", w.id), 0);
    assert_eq!(learning(&env, &cwd), None);
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    assert_eq!(wait_events(&env, &cwd, "learnRequested", 1).len(), 1, "a person can still ask");
}

#[test]
fn off_scans_nothing_and_a_person_can_still_ask() {
    let env = daemon(&json!({"mode": "off", "idleSeconds": 1}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &done());
    w.exchange("no, the other file", &done());
    wait_log(&env, &format!("session {} not scanned for learning: \"learning\" is off", w.id), 0);
    assert_eq!(learning(&env, &cwd), None);
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    assert_eq!(wait_events(&env, &cwd, "learnRequested", 1).len(), 1);
}

#[test]
fn a_projects_own_settings_can_turn_learning_off_and_a_bad_one_does_too() {
    let env = daemon(&idle(), true);
    for (file, why) in [
        (json!({"learning": {"mode": "off"}}).to_string(), "\"learning\" is off"),
        (json!({"learning": {"mode": "suggest", "dailyRuns": 50}}).to_string(), "\"learning\" is off"),
    ] {
        let cwd = project();
        fs::create_dir_all(cwd.join(".strive")).unwrap();
        fs::write(cwd.join(".strive/settings.json"), file).unwrap();
        let mut w = Work::new(&env, &cwd);
        w.exchange("go", &json!({"kind": "interrupted"}));
        wait_log(&env, &format!("session {} not scanned for learning: {why}", w.id), 0);
        assert_eq!(learning(&env, &cwd), None);
    }
    assert!(log(&env).contains(".strive/settings.json can't be read"), "{}", log(&env));
}

#[test]
fn a_projects_own_settings_cant_raise_the_mode() {
    // The user's mode is off; the project asks for suggest.
    let env = daemon(&json!({"mode": "off", "idleSeconds": 1}), true);
    let cwd = project();
    fs::create_dir_all(cwd.join(".strive")).unwrap();
    fs::write(cwd.join(".strive/settings.json"), json!({"learning": {"mode": "suggest"}}).to_string()).unwrap();
    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &json!({"kind": "interrupted"}));
    wait_log(&env, &format!("session {} not scanned for learning: \"learning\" is off", w.id), 0);
    assert_eq!(learning(&env, &cwd), None);
}

#[test]
fn no_key_skips_the_run_and_says_so() {
    let env = daemon(&idle(), false);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &json!({"kind": "interrupted"}));
    let skipped = wait_events(&env, &cwd, "learnSkipped", 1);
    assert_eq!(
        skipped[0]["reason"], "there's no anthropic API key for the learner; `strive auth anthropic` sets one",
        "{skipped:?}"
    );
}

#[test]
fn a_budget_that_cant_cover_the_learners_first_call_skips_the_run() {
    let env = Env::with_vars(&[("ANTHROPIC_API_KEY", "sk-test-trigger")]);
    let settings = json!({"learning": idle(), "budget": {"usd": 0.01}});
    fs::write(env.home.path().join("settings.json"), settings.to_string()).unwrap();
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &json!({"kind": "interrupted"}));
    let skipped = wait_events(&env, &cwd, "learnSkipped", 1);
    let reason = skipped[0]["reason"].as_str().unwrap();
    assert!(reason.starts_with("the learning session's budget can't cover the learner's first call"), "{reason}");
}

#[test]
fn review_shows_what_triggered_an_automatic_runs_proposal() {
    let env = daemon(&idle(), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("run the tests", &done());
    let (fix, _) = w.exchange("no, use bun test", &done());
    wait_events(&env, &cwd, "learnRequested", 1);
    let mut learner = Learner::new(&env, &cwd);
    let made = learner.turn(&[memory(&w.id)]);

    // A person's run, for contrast.
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    let manual = learner.turn(&[memory(&w.id)]);

    let listed = review(&env, &cwd, &["review"]);
    let line = |id: u64| listed.lines().find(|l| l.starts_with(&format!("#{id} "))).unwrap().to_string();
    assert!(line(made[0]).ends_with("[automatic run]"), "{listed}");
    assert!(!line(manual[0]).contains('['), "{listed}");

    // Sessions are named by title, and which signs started the run are behind --full.
    let shown = review(&env, &cwd, &["review", &made[0].to_string()]);
    assert!(
        shown.contains(
            "changes .strive/memory.md; automatic, after a session went idle: a correction in \"run the tests\""
        ),
        "{shown}"
    );
    assert!(!shown.contains(&w.id), "{shown}");
    let full = review(&env, &cwd, &["review", &made[0].to_string(), "--full"]);
    assert!(full.contains(&format!("\"run the tests\" entry {fix}: a correction: no, use bun test")), "{full}");
    let shown = review(&env, &cwd, &["review", &manual[0].to_string()]);
    assert!(shown.contains("changes .strive/memory.md; asked with `strive learn` on"), "{shown}");

    let logged = review(&env, &cwd, &["log", &learning(&env, &cwd).unwrap()]);
    assert!(logged.contains("automatic learning run, after a session went idle: a correction in session"), "{logged}");
}

#[test]
fn a_mode_other_than_off_or_suggest_is_refused_on_load() {
    for mode in ["gated", "auto"] {
        let env = daemon(&json!({"mode": mode}), false);
        let out = env.strive(&["status"]);
        let err = String::from_utf8_lossy(&out.stderr).into_owned() + &log(&env);
        assert!(!out.status.success(), "a daemon started with mode {mode}");
        assert!(err.contains(&format!("unknown variant `{mode}`, expected `off` or `suggest`")), "{err}");
    }
}

/// A daemon with an Anthropic key whose settings are `settings`.
fn daemon_with(settings: &Value) -> Env {
    let env = Env::with_vars(&[("ANTHROPIC_API_KEY", "sk-test-trigger")]);
    fs::write(env.home.path().join("settings.json"), settings.to_string()).unwrap();
    env
}

#[test]
fn a_proposal_a_crash_left_checking_doesnt_hold_the_next_run_back() {
    // The judge on an OpenAI model is skipped at once.
    let env = daemon_with(&json!({"learning": idle(), "judgeModel": "gpt-4.1-mini"}));
    let cwd = project();
    let first = Work::new(&env, &cwd).id;
    let learning_id =
        common::slow_rpc(&env).ok("learning/open", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    env.stop();
    // What a crash in the judge's call leaves: a proposal with no judge verdict.
    let next = common::next_seq_offline(&env, &learning_id);
    common::append_offline(
        &env,
        &learning_id,
        &json!([
            {"type": "proposalMade", "proposal": memory(&first)},
            {"type": "gateFinished", "proposal": next, "gate": "static", "verdict": "pass", "detail": "fine"},
        ]),
    );

    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &json!({"kind": "interrupted"}));
    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(asked[0]["sessions"], json!([w.id]), "{asked:?}");
    assert_eq!(events(&env, &learning_id, "learnSkipped"), Vec::<Value>::new());
}

/// An agent host command that only notes each start (its arguments) in a
/// file, and exits: a test connection then plays the host it would be.
fn noting_host(env: &mut Env) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::Builder::new().prefix("strv-host").tempdir_in("/tmp").unwrap().keep();
    let (script, started) = (dir.join("host.sh"), dir.join("started"));
    fs::write(&script, format!("#!/bin/sh\necho \"$@\" >> {}\n", started.display())).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    env.vars.push(("STRIVE_HOST".into(), script.display().to_string()));
    started
}

fn wait_started(started: &Path, session: &str) {
    common::wait_for(&format!("a host started for {session}"), Duration::from_secs(20), || {
        fs::read_to_string(started).unwrap_or_default().contains(&format!("--session {session}"))
    });
}

#[test]
fn a_learner_run_a_crash_cut_off_is_finished_by_starting_its_host_again() {
    let mut env = daemon(&idle(), true);
    let started = noting_host(&mut env);
    let cwd = project();
    Work::new(&env, &cwd);
    let learning_id =
        common::slow_rpc(&env).ok("learning/open", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    env.stop();
    // What a crash in the middle of a learner's turn leaves.
    let asked = common::next_seq_offline(&env, &learning_id);
    common::append_offline(
        &env,
        &learning_id,
        &json!([
            {"type": "learnRequested", "sessions": []},
            {"type": "turnStarted", "turn": 1, "throughSeq": asked},
        ]),
    );

    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &json!({"kind": "interrupted"}));
    let skipped = wait_events(&env, &cwd, "learnSkipped", 1);
    assert_eq!(skipped[0]["reason"], "a learner run is still going");
    // Only its host's resume can end that turn, so the daemon starts it.
    wait_started(&started, &learning_id);

    // The host resumes: it ends the cut-off turn, which finishes the request.
    let mut host = common::slow_rpc(&env);
    host.ok("host/register", &json!({"id": learning_id}));
    let failed = json!({"kind": "failed", "error": "the agent host stopped during this turn"});
    host.ok("host/record", &json!({"id": learning_id, "event": {"type": "turnEnded", "turn": 1, "reason": failed}}));
    w.exchange("again", &json!({"kind": "interrupted"}));
    let asked = wait_events(&env, &cwd, "learnRequested", 2);
    assert_eq!(asked[1]["sessions"], json!([w.id]), "{asked:?}");
}

// The offer to learn from a session (`learning/signals`, `learning/dismiss`):
// what the TUI and the desktop ask a person, with automatic runs off.

fn signals(env: &Env, cwd: &Path, session: &str) -> Value {
    common::slow_rpc(env).ok("learning/signals", &json!({"cwd": cwd, "session": session}))
}

#[test]
fn a_session_with_a_correction_is_offered_for_learning_and_a_clean_one_is_not() {
    let env = daemon(&json!({"mode": "off"}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("run the tests", &done());
    let (fix, _) = w.exchange("no, use bun test", &done());
    let (_, interrupted) = w.exchange("now the linter", &json!({"kind": "interrupted"}));
    let (_, interrupted_again) = w.exchange("go on", &json!({"kind": "interrupted"}));

    assert_eq!(
        signals(&env, &cwd, &w.id),
        json!({
            "signals": [
                {"session": w.id, "seq": fix, "kind": "correction", "detail": "no, use bun test"},
                {"session": w.id, "seq": interrupted, "kind": "interrupted", "detail": "turn 3 was interrupted"},
                {"session": w.id, "seq": interrupted_again, "kind": "interrupted", "detail": "turn 4 was interrupted"},
            ],
            "summary": "a correction and 2 interrupted turns",
            "ask": true,
            // No learner has run anywhere yet: a typical run's 60,000 tokens in and
            // 2,000 out at claude-sonnet-4-5's $3 and $15 a million.
            "estimateUsdMicros": 210_000,
        })
    );
    // Asking costs nothing and records nothing: the project still has no learning session.
    assert_eq!(learning(&env, &cwd), None);

    let mut clean = Work::new(&env, &cwd);
    clean.exchange("add a --verbose flag", &done());
    clean.exchange("thanks", &done());
    let r = signals(&env, &cwd, &clean.id);
    assert_eq!((&r["signals"], &r["summary"], &r["ask"]), (&json!([]), &json!(""), &json!(false)), "{r}");

    // Only a work session of this project is asked about.
    let other = project();
    let r = common::slow_rpc(&env).call("learning/signals", &json!({"cwd": other, "session": w.id}));
    assert!(r["error"]["message"].as_str().unwrap().contains("not in"), "{r}");
}

#[test]
fn yes_asks_for_a_run_naming_the_session_and_its_signs_which_are_not_offered_again() {
    let env = daemon(&json!({"mode": "off"}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("run the tests", &done());
    let (fix, _) = w.exchange("no, use bun test", &done());

    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd, "sessions": [w.id]}));
    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(
        asked[0],
        json!({
            "type": "learnRequested",
            "sessions": [w.id],
            "signals": [{"session": w.id, "seq": fix, "kind": "correction", "detail": "no, use bun test"}],
        })
    );
    assert_eq!(signals(&env, &cwd, &w.id)["signals"], json!([]));
    assert_eq!(signals(&env, &cwd, &w.id)["ask"], false);
    assert!(
        review(&env, &cwd, &["log", learning(&env, &cwd).unwrap().as_str()])
            .contains(&format!("asked the learner to study {} (a correction in session {})", w.id, w.id))
    );

    // A later sign is offered on its own.
    let (_, interrupted) = w.exchange("now the linter", &json!({"kind": "interrupted"}));
    let r = signals(&env, &cwd, &w.id);
    assert_eq!(
        (&r["signals"][0]["seq"], &r["summary"], &r["ask"]),
        (&json!(interrupted), &json!("an interrupted turn"), &json!(true))
    );
    assert_eq!(r["signals"].as_array().unwrap().len(), 1, "{r}");
}

#[test]
fn a_dismissed_offer_is_not_made_again_and_no_trigger_acts_on_its_signs() {
    // Automatic runs on, scanning every third turn, so the scan comes after the dismissal.
    let env = daemon(&json!({"mode": "suggest", "idleSeconds": 3600, "everyTurns": 3}), true);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("run the tests", &done());
    let (fix, _) = w.exchange("no, use bun test", &done());

    let mut person = common::slow_rpc(&env);
    let r = person.call("learning/dismiss", &json!({"cwd": cwd, "session": w.id, "through": fix + 100}));
    assert!(r["error"]["message"].as_str().unwrap().contains("has no entry"), "{r}");
    // The agent's host isn't a person.
    let r = w.host.call("learning/dismiss", &json!({"cwd": cwd, "session": w.id, "through": fix}));
    assert!(r["error"]["message"].as_str().unwrap().contains("only a person"), "{r}");
    person.ok("learning/dismiss", &json!({"cwd": cwd, "session": w.id, "through": fix}));
    assert_eq!(
        events(&env, &learning(&env, &cwd).unwrap(), "learnDismissed"),
        [json!({"type": "learnDismissed", "session": w.id, "through": fix})]
    );
    assert_eq!(signals(&env, &cwd, &w.id)["signals"], json!([]));

    let scanned = format!("session {} scanned for learning: no new signs", w.id);
    let before = log(&env).matches(&scanned).count();
    w.exchange("thanks", &done());
    wait_log(&env, &scanned, before);
    assert_eq!(events(&env, &learning(&env, &cwd).unwrap(), "learnRequested"), Vec::<Value>::new());
}

#[test]
fn no_offer_when_learning_ask_is_false_or_the_learner_has_no_key() {
    for (settings, key) in [(json!({"mode": "off", "ask": false}), true), (json!({"mode": "off"}), false)] {
        let env = daemon(&settings, key);
        let cwd = project();
        let mut w = Work::new(&env, &cwd);
        w.exchange("run the tests", &done());
        w.exchange("no, use bun test", &done());
        let r = signals(&env, &cwd, &w.id);
        assert_eq!((&r["summary"], &r["ask"]), (&json!("a correction"), &json!(false)), "{settings} key {key}: {r}");
    }
}
