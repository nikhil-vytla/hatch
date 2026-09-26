//! Predictions checked (ADR-0019): an applied proposal's watch, evaluated by
//! the daemon on the project's later work sessions, journaled in its
//! learning session, tallied in `proposal/list`, and shown by `strive
//! review`, which suggests a rollback it never performs.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use common::{Env, Rpc};
use serde_json::{Value, json};
use strive_proto::rpc::RpcError;

fn project() -> PathBuf {
    let dir = tempfile::Builder::new().prefix("strv-pred").tempdir_in("/tmp").unwrap().keep();
    dir.canonicalize().unwrap()
}

fn work_session(env: &Env, cwd: &Path) -> String {
    common::slow_rpc(env).ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string()
}

fn learner(env: &Env, cwd: &Path) -> (Rpc, String) {
    let id = common::slow_rpc(env).ok("learning/open", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let mut host = common::slow_rpc(env);
    host.ok("host/register", &json!({"id": id}));
    (host, id)
}

/// "In sessions that run `bun test`, no output of it says `no display`."
fn no_display() -> Value {
    json!({
        "when": {"command": "bun test"},
        "expect": {"kind": "never", "step": {"command": "bun test", "output": "no display"}},
    })
}

fn memory(evidence: &str, watch: Option<Value>) -> Value {
    let mut p = json!({
        "artifact": {"kind": "memory"},
        "content": "- Run the tests with `bun test packages/host`: the root run needs a display.\n",
        "summary": "Run the host tests only",
        "rationale": "bun test failed with no display",
        "evidence": [{"session": evidence, "seqs": [1], "note": "the session began here"}],
        "prediction": "Sessions that run bun test won't fail with no display.",
    });
    if let Some(w) = watch {
        p["watch"] = w;
    }
    p
}

fn propose(host: &mut Rpc, id: &str, proposal: &Value) -> u64 {
    let r = host.call("host/record", &json!({"id": id, "event": {"type": "proposalMade", "proposal": proposal}}));
    assert!(r.get("error").is_none(), "proposing failed: {r}");
    r["result"]["seq"].as_u64().unwrap()
}

fn proposal(env: &Env, cwd: &Path, id: u64) -> Value {
    let r = common::slow_rpc(env).ok("proposal/list", &json!({"cwd": cwd}));
    r["proposals"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone()
}

fn events(env: &Env, id: &str, kind: &str) -> Vec<Value> {
    let r = common::slow_rpc(env).ok("session/read", &json!({"id": id}));
    r["entries"].as_array().unwrap().iter().filter(|e| e["event"]["type"] == kind).map(|e| e["event"].clone()).collect()
}

/// A proposal with `watch`, accepted by a person; its id.
fn applied(env: &Env, cwd: &Path, watch: Option<Value>) -> (u64, String, Rpc) {
    let cited = work_session(env, cwd);
    let (mut host, id) = learner(env, cwd);
    let p = propose(&mut host, &id, &memory(&cited, watch));
    let r = common::slow_rpc(env).call("proposal/decide", &json!({"cwd": cwd, "proposal": p, "decision": "accept"}));
    assert!(r.get("error").is_none(), "{r}");
    (p, id, host)
}

/// A work session whose host runs one turn of `commands`, recording its
/// end as a host does, and leaves; its id.
fn work_turn(env: &Env, cwd: &Path, commands: &[&str]) -> String {
    let id = work_session(env, cwd);
    let mut person = common::slow_rpc(env);
    person.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
    person.ok("session/prompt", &json!({"id": id, "text": "run the tests"}));
    let mut host = common::slow_rpc(env);
    host.ok("host/register", &json!({"id": id}));
    turn(&mut host, &id, 1, commands);
    id
}

fn turn(host: &mut Rpc, id: &str, n: u64, commands: &[&str]) {
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": n}}));
    for (i, c) in commands.iter().enumerate() {
        let params = json!({"id": id, "callId": format!("c{n}-{i}"), "request": {"kind": "bash", "command": c}});
        host.wait_up_to(Duration::from_secs(30));
        host.ok("effect/run", &params);
    }
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnEnded", "turn": n, "reason": {"kind": "done"}}}));
}

/// The learning session's checks of `proposal` against `session`, once there are `n`.
fn checks(env: &Env, learning: &str, proposal: u64, session: &str, n: usize) -> Vec<Value> {
    let mine = || -> Vec<Value> {
        events(env, learning, "predictionChecked")
            .into_iter()
            .filter(|e| e["proposal"] == proposal && e["session"] == session)
            .collect()
    };
    common::wait_for("the prediction's check", Duration::from_secs(20), || mine().len() >= n);
    mine()
}

fn review(env: &Env, cwd: &Path, args: &[&str]) -> String {
    let out = env.strive_in(cwd, args);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[test]
fn a_watch_is_confirmed_contradicted_or_not_applicable_as_each_work_turn_ends() {
    let env = Env::new();
    let cwd = project();
    let (p, learning, _host) = applied(&env, &cwd, Some(no_display()));

    let ok = work_turn(&env, &cwd, &["echo 'bun test: 12 pass'; : bun test"]);
    let bad = work_turn(&env, &cwd, &["echo 'error: No display'; exit 1; : bun test"]);
    let other = work_turn(&env, &cwd, &["echo tidy"]);

    let got = checks(&env, &learning, p, &ok, 1);
    assert_eq!(got[0]["outcome"], "confirmed", "{got:?}");
    let got = checks(&env, &learning, p, &bad, 1);
    assert_eq!(got[0]["outcome"], "contradicted", "{got:?}");
    assert!(got[0]["detail"].as_str().unwrap().contains("(exit 1)"), "{got:?}");
    let read = common::slow_rpc(&env).ok("session/read", &json!({"id": bad}));
    let last = read["entries"].as_array().unwrap().last().unwrap()["seq"].clone();
    assert_eq!(got[0]["throughSeq"], last, "read up to the turn's end");
    let got = checks(&env, &learning, p, &other, 1);
    assert_eq!(got[0]["outcome"], "notApplicable", "{got:?}");

    let tally = &proposal(&env, &cwd, p)["prediction"];
    assert_eq!(
        (&tally["confirmed"], &tally["contradicted"], &tally["notApplicable"], &tally["notHolding"]),
        (&json!(1), &json!(1), &json!(1), &json!(false)),
        "{tally}"
    );
}

#[test]
fn checking_again_journals_nothing_until_a_sessions_answer_changes() {
    let env = Env::new();
    let cwd = project();
    let (p, learning, _host) = applied(&env, &cwd, Some(no_display()));
    let work = work_session(&env, &cwd);
    let mut person = common::slow_rpc(&env);
    person.ok("session/approvals", &json!({"id": work, "mode": "fullAuto"}));
    person.ok("session/prompt", &json!({"id": work, "text": "run the tests"}));
    let mut host = common::slow_rpc(&env);
    host.ok("host/register", &json!({"id": work}));
    turn(&mut host, &work, 1, &["echo ok; : bun test"]);
    assert_eq!(checks(&env, &learning, p, &work, 1).len(), 1);

    // learning/run checks every session again; nothing about this one is new.
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    common::wait_for("the learning request", Duration::from_secs(10), || {
        !events(&env, &learning, "learnRequested").is_empty()
    });
    // A turn that checks the same thing again changes nothing either.
    person.ok("session/prompt", &json!({"id": work, "text": "again"}));
    turn(&mut host, &work, 2, &["echo still ok; : bun test"]);
    person.ok("session/prompt", &json!({"id": work, "text": "and again"}));
    turn(&mut host, &work, 3, &["echo 'no display'; : bun test"]);
    let got = checks(&env, &learning, p, &work, 2);
    assert_eq!(
        got.iter().map(|e| e["outcome"].as_str().unwrap()).collect::<Vec<_>>(),
        ["confirmed", "contradicted"],
        "one record per change of answer: {got:?}"
    );
    let tally = &proposal(&env, &cwd, p)["prediction"];
    assert_eq!((&tally["confirmed"], &tally["contradicted"]), (&json!(0), &json!(1)), "counted once, by the latest");
}

#[test]
fn three_contradictions_mark_it_not_holding_and_review_suggests_the_rollback_a_person_makes() {
    let env = Env::new();
    let cwd = project();
    let (p, learning, mut learner_host) = applied(&env, &cwd, Some(no_display()));
    let file = cwd.join(".strive/memory.md");
    let written = fs::read_to_string(&file).unwrap();
    let mut bad = Vec::new();
    for i in 0..3 {
        let s = work_turn(&env, &cwd, &["echo 'No display'; : bun test"]);
        checks(&env, &learning, p, &s, 1);
        let t = proposal(&env, &cwd, p)["prediction"].clone();
        assert_eq!(t["notHolding"], json!(i == 2), "not holding only at the third: {t}");
        bad.push(s);
    }

    let listed = review(&env, &cwd, &["review"]);
    let hint = format!("`strive review {p} rollback` puts .strive/memory.md back as it was");
    assert!(listed.contains(&format!("#{p} may be hurting")) && listed.contains(&hint), "{listed}");
    let shown = review(&env, &cwd, &["review", &p.to_string()]);
    for want in [
        "watch: in sessions with a command containing \"bun test\": never a command containing \"bun test\" whose output contains \"no display\"",
        "so far: not holding: confirmed in 0, contradicted in 3 of 3 sessions",
        &hint,
    ] {
        assert!(shown.contains(want), "{want:?} in:\n{shown}");
    }

    // Suggested, never done: the file is as accepted, and nothing rolled it back.
    assert_eq!(fs::read_to_string(&file).unwrap(), written);
    assert!(events(&env, &learning, "proposalRolledBack").is_empty());
    let r = learner_host.call("proposal/rollback", &json!({"cwd": cwd, "proposal": p}));
    assert_eq!(r["error"]["code"], RpcError::NOT_A_PERSON, "{r}");

    review(&env, &cwd, &["review", &p.to_string(), "rollback"]);
    assert!(!file.exists(), "the person's rollback removes the file it created");
    let after = work_turn(&env, &cwd, &["echo 'no display'; : bun test"]);
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    common::wait_for("the learning request", Duration::from_secs(10), || {
        !events(&env, &learning, "learnRequested").is_empty()
    });
    let later: Vec<Value> =
        events(&env, &learning, "predictionChecked").into_iter().filter(|e| e["session"] == after).collect();
    assert!(later.is_empty(), "a rolled-back proposal isn't checked: {later:?}");
    let listed = review(&env, &cwd, &["review"]);
    assert!(!listed.contains("may be hurting"), "{listed}");
}

#[test]
fn only_sessions_after_the_apply_are_checked_and_a_proposal_without_a_watch_says_so() {
    let env = Env::new();
    let cwd = project();
    let before = work_session(&env, &cwd);
    let (plain, learning, mut host) = applied(&env, &cwd, None);
    let shown = review(&env, &cwd, &["review", &plain.to_string()]);
    assert!(shown.contains("prediction not machine-checked"), "{shown}");
    assert!(proposal(&env, &cwd, plain).get("prediction").is_none());
    let unwatched = work_turn(&env, &cwd, &["echo 'no display'; : bun test"]);

    // A watched proposal applied later: a session begun before it isn't read.
    // Registering again shows the learner the file as the plain one left it.
    host.ok("host/register", &json!({"id": learning}));
    let watched = propose(&mut host, &learning, &memory(&before, Some(no_display())));
    let mut person = common::slow_rpc(&env);
    person.ok("session/approvals", &json!({"id": before, "mode": "fullAuto"}));
    person.ok("session/prompt", &json!({"id": before, "text": "run the tests"}));
    let r = person.call("proposal/decide", &json!({"cwd": cwd, "proposal": watched, "decision": "accept"}));
    assert!(r.get("error").is_none(), "{r}");
    let mut work_host = common::slow_rpc(&env);
    work_host.ok("host/register", &json!({"id": before}));
    turn(&mut work_host, &before, 1, &["echo 'no display'; : bun test"]);
    let after = work_turn(&env, &cwd, &["echo 'no display'; : bun test"]);
    checks(&env, &learning, watched, &after, 1);
    // learning/run checks every session; still only the one after the apply is read.
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    common::wait_for("the learning request", Duration::from_secs(10), || {
        !events(&env, &learning, "learnRequested").is_empty()
    });
    let all = events(&env, &learning, "predictionChecked");
    assert!(all.iter().all(|e| e["session"] == after && e["proposal"] == watched), "{all:?} ({unwatched} unread)");
}

#[test]
fn a_turn_that_ended_without_its_host_is_checked_on_the_next_learning_run() {
    let env = Env::new();
    let cwd = project();
    let (p, learning, _host) = applied(&env, &cwd, Some(no_display()));
    let work = work_session(&env, &cwd);
    let mut person = common::slow_rpc(&env);
    person.ok("session/approvals", &json!({"id": work, "mode": "fullAuto"}));
    person.ok("session/prompt", &json!({"id": work, "text": "run the tests"}));
    {
        let mut host = common::slow_rpc(&env);
        host.ok("host/register", &json!({"id": work}));
        host.ok("host/record", &json!({"id": work, "event": {"type": "turnStarted", "turn": 1}}));
        let params =
            json!({"id": work, "callId": "c", "request": {"kind": "bash", "command": "echo 'no display'; : bun test"}});
        host.ok("effect/run", &params);
    }
    // The host's connection closed mid-turn: the daemon ends the turn itself.
    common::wait_for("the daemon to end the turn", Duration::from_secs(10), || {
        !events(&env, &work, "turnEnded").is_empty()
    });
    assert!(events(&env, &learning, "predictionChecked").is_empty());
    common::slow_rpc(&env).ok("learning/run", &json!({"cwd": cwd}));
    let got = checks(&env, &learning, p, &work, 1);
    assert_eq!(got[0]["outcome"], "contradicted", "{got:?}");
}

#[test]
fn a_huge_output_is_checked_within_bounds() {
    let env = Env::new();
    let cwd = project();
    let (p, learning, _host) = applied(&env, &cwd, Some(no_display()));
    // 20 MB of output; the daemon keeps its start and end, and the check reads those.
    let s = work_turn(&env, &cwd, &["head -c 20000000 /dev/zero | tr '\\0' a; echo; echo 'no display'; : bun test"]);
    let got = checks(&env, &learning, p, &s, 1);
    assert_eq!(got[0]["outcome"], "contradicted", "the error at the end is read: {got:?}");
}

#[test]
fn a_malformed_watch_fails_the_static_gate_and_an_unknown_field_is_refused() {
    let env = Env::new();
    let cwd = project();
    let work = work_session(&env, &cwd);
    let (mut host, id) = learner(&env, &cwd);
    let empty = json!({"expect": {"kind": "never", "step": {}}});
    let p = propose(&mut host, &id, &memory(&work, Some(empty)));
    let got = proposal(&env, &cwd, p);
    assert_eq!(got["status"], "failed", "{got}");
    let gate = got["gates"].as_array().unwrap().iter().find(|g| g["gate"] == "static").unwrap().clone();
    assert!(gate["detail"].as_str().unwrap().contains("watch: the expected step names nothing to match"), "{gate}");

    let long = "x".repeat(300);
    let p = propose(&mut host, &id, &memory(&work, Some(json!({"expect": {"kind": "any", "step": {"prompt": long}}}))));
    assert_eq!(proposal(&env, &cwd, p)["status"], "failed");

    let regex = json!({"expect": {"kind": "never", "step": {"command": "x", "regex": "(a+)+$"}}});
    let event = json!({"type": "proposalMade", "proposal": memory(&work, Some(regex))});
    let r = host.call("host/record", &json!({"id": id, "event": event}));
    assert!(r["error"]["message"].as_str().unwrap().contains("regex"), "{r}");
}

#[test]
fn a_memory_line_naming_a_path_that_is_gone_may_be_stale() {
    let env = Env::new();
    let cwd = project();
    fs::create_dir_all(cwd.join(".strive")).unwrap();
    fs::create_dir_all(cwd.join("docs")).unwrap();
    fs::write(cwd.join("docs/testing.md"), "how").unwrap();
    fs::write(cwd.join("src.ts"), "").unwrap();
    let memory = "- Tests: see `docs/testing.md`.\n- The parser is `src/parse.ts:40`.\n- Run `bun test src`.\n";
    fs::write(cwd.join(".strive/memory.md"), memory).unwrap();
    let listed = common::slow_rpc(&env).ok("proposal/list", &json!({"cwd": cwd}));
    assert_eq!(
        listed["mayBeStale"],
        json!([{"file": ".strive/memory.md", "line": 2, "missing": "src/parse.ts"}]),
        "{listed}"
    );
    let out = review(&env, &cwd, &["review"]);
    assert!(
        out.contains(".strive/memory.md line 2 may be stale: it names src/parse.ts, which isn't in the project"),
        "{out}"
    );
    fs::create_dir_all(cwd.join("src")).unwrap();
    fs::write(cwd.join("src/parse.ts"), "").unwrap();
    assert_eq!(common::slow_rpc(&env).ok("proposal/list", &json!({"cwd": cwd}))["mayBeStale"], json!([]));
}
