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
fn daemon(learning: &Value, key: bool) -> Env {
    let env = if key { Env::with_vars(&[("ANTHROPIC_API_KEY", "sk-test-trigger")]) } else { Env::new() };
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
        let mut person = env.rpc();
        let id = person.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
        let mut host = env.rpc();
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
    let r = env.rpc().ok("session/list", &json!({"cwd": cwd, "kind": "learning"}));
    r["sessions"].as_array().unwrap().first().map(|s| s["id"].as_str().unwrap().to_string())
}

fn events(env: &Env, id: &str, kind: &str) -> Vec<Value> {
    let r = env.rpc().ok("session/read", &json!({"id": id}));
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
    common::wait_for(&format!("the log to say {needle:?}"), Duration::from_secs(20), || {
        log(env).matches(needle).count() > before
    });
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
        let mut host = env.rpc();
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

fn idle() -> Value {
    json!({"idleSeconds": 1})
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
    let env = daemon(&json!({"idleSeconds": 2}), true);
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
    assert_eq!(wait_events(&env, &cwd, "learnRequested", 1).len(), 1);
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
    assert_eq!(wait_events(&env, &cwd, "learnRequested", 1).len(), 1);

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
    env.rpc().ok("learning/run", &json!({"cwd": cwd}));
    let asked = wait_events(&env, &cwd, "learnRequested", 1);
    assert_eq!(asked[0], json!({"type": "learnRequested", "sessions": []}), "a person's request has no trigger");
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
    env.rpc().ok("learning/run", &json!({"cwd": cwd}));
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
    env.rpc().ok("learning/run", &json!({"cwd": cwd}));
    let manual = learner.turn(&[memory(&w.id)]);

    let listed = review(&env, &cwd, &["review"]);
    let line = |id: u64| listed.lines().find(|l| l.starts_with(&format!("#{id} "))).unwrap().to_string();
    assert!(line(made[0]).ends_with("[automatic run]"), "{listed}");
    assert!(!line(manual[0]).contains('['), "{listed}");

    let shown = review(&env, &cwd, &["review", &made[0].to_string()]);
    assert!(
        shown.contains(&format!("run         automatic, after a session went idle: a correction in session {}", w.id)),
        "{shown}"
    );
    assert!(shown.contains(&format!("session {} entry {fix}: a correction: no, use bun test", w.id)), "{shown}");
    let shown = review(&env, &cwd, &["review", &manual[0].to_string()]);
    assert!(shown.contains("run         asked for by a person"), "{shown}");

    let logged = review(&env, &cwd, &["log", &learning(&env, &cwd).unwrap()]);
    assert!(logged.contains("automatic learning run, after a session went idle: a correction in session"), "{logged}");
}

#[test]
fn auto_is_refused_on_load_naming_gated() {
    let env = daemon(&json!({"mode": "auto"}), false);
    let out = env.strive(&["status"]);
    let err = String::from_utf8_lossy(&out.stderr).into_owned() + &log(&env);
    assert!(!out.status.success(), "a daemon started with mode auto");
    assert!(err.contains("learning.mode \"auto\" isn't available") && err.contains("use \"gated\""), "{err}");
}

#[test]
fn gated_leaves_a_proposal_with_a_skipped_check_to_a_person_and_a_client_named_gate_is_still_a_person() {
    // No key: the judge is skipped, and so is replay.
    let env = daemon(&json!({"mode": "gated"}), false);
    let cwd = project();
    let mut w = Work::new(&env, &cwd);
    w.exchange("go", &done());
    env.rpc().ok("learning/open", &json!({"cwd": cwd}));
    let id = Learner::new(&env, &cwd).turn(&[memory(&w.id)])[0];
    let listed = env.rpc().ok("proposal/list", &json!({"cwd": cwd}));
    let p = listed["proposals"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone();
    assert_eq!(p["status"], "ready", "{p}");
    let verdicts: Vec<&Value> = p["gates"].as_array().unwrap().iter().map(|g| &g["verdict"]).collect();
    assert_eq!(verdicts, vec!["pass", "skipped", "skipped"], "{p}");
    let learning_id = learning(&env, &cwd).unwrap();
    assert_eq!(events(&env, &learning_id, "proposalDecided"), Vec::<Value>::new(), "not accepted without a person");
    assert!(!cwd.join(".strive/memory.md").exists());

    // A person whose client calls itself "gate" decides as a person.
    let mut gate = env.raw();
    let init = gate.call_id(
        0,
        "initialize",
        &json!({"protocolVersion": strive_proto::PROTOCOL_VERSION, "client": {"name": "gate", "version": "0"}}),
    );
    assert!(init.get("result").is_some(), "{init}");
    gate.ok("proposal/decide", &json!({"cwd": cwd, "proposal": id, "decision": "accept"}));
    let decided = events(&env, &learning_id, "proposalDecided");
    assert_eq!(decided, vec![json!({"type": "proposalDecided", "proposal": id, "decision": "accept", "by": "gate"})]);
    let listed = env.rpc().ok("proposal/list", &json!({"cwd": cwd}));
    let p = listed["proposals"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone();
    assert_eq!((p["status"].as_str(), p.get("automatic")), (Some("applied"), None), "{p}");
    let shown = review(&env, &cwd, &["review", &id.to_string()]);
    assert!(!shown.contains("accepted automatically"), "{shown}");
    // The log names the client as a client, so it can't read as the gate's own accept.
    let logged = review(&env, &cwd, &["log", &learning_id]);
    assert!(logged.contains(&format!("proposal #{id} accepted by gate (a client)")), "{logged}");
}
