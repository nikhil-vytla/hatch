//! The replay gate's lifecycle through the real daemon (ADR-0018): its hold
//! on the learning session's budget, how it ends, and `gated`'s accept at
//! its pass. A test connection plays each run's agent host, so what a run
//! does is scripted; the daemon, its gateway, sandbox and checks are real,
//! and a fake model answers at the network boundary.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::collections::HashSet;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::response::Response;
use common::{Env, Rpc};
use serde_json::{Value, json};

/// A fake Anthropic API: every call gets a judge's passing verdict, which
/// is also a model answer a run's calls can be charged for. Each answer
/// comes after `delay_ms`.
fn model(delay_ms: u64) -> SocketAddr {
    let criteria: serde_json::Map<String, Value> = ["supported", "generalizes", "novel", "safe", "checkable"]
        .iter()
        .map(|c| ((*c).to_string(), json!({"pass": true, "reason": "holds"})))
        .collect();
    let reply = json!({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-4-5",
        "content": [{"type": "tool_use", "id": "toolu_1", "name": "record_verdict",
                     "input": {"criteria": criteria, "verdict": "pass", "summary": "Sound."}}],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 900, "output_tokens": 120},
    });
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tokio::runtime::Runtime::new().unwrap().block_on(async move {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            tx.send(listener.local_addr().unwrap()).unwrap();
            let app = axum::Router::new().fallback(move |_: Bytes| {
                let reply = reply.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    Response::builder()
                        .status(200)
                        .header("content-type", "application/json")
                        .body(Body::from(reply.to_string()))
                        .unwrap()
                }
            });
            axum::serve(listener, app).await.unwrap();
        });
    });
    rx.recv().unwrap()
}

/// The command that ends a run's check: it fails until the run touches `ok`.
const CHECK: &str = "test -f ok";

struct Replay {
    env: Env,
    cwd: PathBuf,
    learning: String,
    /// The learner's connection, kept open.
    _learner: Rpc,
    proposal: u64,
    /// Replay sessions already seen.
    runs: HashSet<String>,
}

fn project() -> PathBuf {
    let dir = tempfile::Builder::new().prefix("strv-proj").tempdir_in("/tmp").unwrap().keep().canonicalize().unwrap();
    fs::write(dir.join("README"), "a project\n").unwrap();
    dir
}

/// An agent host command that exits at once: the test registers in its place.
fn absent_host(env: &mut Env) {
    use std::os::unix::fs::PermissionsExt as _;
    let dir = tempfile::Builder::new().prefix("strv-host").tempdir_in("/tmp").unwrap().keep();
    let script = dir.join("host.sh");
    fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
    env.vars.push(("STRIVE_HOST".into(), script.display().to_string()));
}

/// A daemon with a key, the fake model, `settings` over one-run replays,
/// a task session whose check went red to green, and a proposal whose
/// replay has begun (the judge passes it at once).
fn replay(settings: &Value) -> Replay {
    replay_after(settings, 0)
}

/// As `replay`, with a model that answers each call after `delay_ms`: the
/// proposal is being judged when this returns.
fn replay_after(settings: &Value, delay_ms: u64) -> Replay {
    let addr = model(delay_ms);
    let mut env = Env::with_vars(&[
        ("STRIVE_UPSTREAM_ANTHROPIC", &format!("http://{addr}")),
        ("ANTHROPIC_API_KEY", "sk-test-replay"),
    ]);
    absent_host(&mut env);
    let mut all = json!({
        "model": "claude-haiku-4-5",
        "judgeModel": "claude-haiku-4-5",
        "replay": {"runs": 1, "tasks": 1},
        "learning": {"idleSeconds": 3600},
    });
    for (k, v) in settings.as_object().unwrap() {
        all[k] = v.clone();
    }
    fs::write(env.home.path().join("settings.json"), all.to_string()).unwrap();
    let cwd = project();

    // The task: a turn whose check failed, then passed.
    let mut person = common::slow_rpc(&env);
    let task = person.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    person.ok("session/approvals", &json!({"id": task, "mode": "fullAuto"}));
    person.ok("session/prompt", &json!({"id": task, "text": "make the check pass"}));
    let mut host = common::slow_rpc(&env);
    host.ok("host/register", &json!({"id": task}));
    host.ok("host/record", &json!({"id": task, "event": {"type": "turnStarted", "turn": 1}}));
    for (n, command) in [CHECK, "touch ok", CHECK].iter().enumerate() {
        let request = json!({"kind": "bash", "command": command});
        host.ok("effect/run", &json!({"id": task, "callId": format!("c{n}"), "request": request}));
    }
    host.ok("host/record", &json!({"id": task, "event": {"type": "turnEnded", "turn": 1, "reason": {"kind": "done"}}}));
    fs::remove_file(cwd.join("ok")).unwrap();

    // The session the proposal cites, which replay doesn't mine.
    let cited = person.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    person.ok("session/prompt", &json!({"id": cited, "text": "the session the lesson came from"}));

    let learning = person.ok("learning/open", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let mut learner = common::slow_rpc(&env);
    learner.ok("host/register", &json!({"id": learning}));
    let proposal = json!({
        "artifact": {"kind": "memory"},
        "content": "- Touch `ok` before running the check.\n",
        "summary": "Touch ok first",
        "rationale": "The check passed once ok existed",
        "evidence": [{"session": cited, "seqs": [1], "note": "the session began here"}],
        "prediction": "later checks pass first time",
    });
    let r =
        learner.ok("host/record", &json!({"id": learning, "event": {"type": "proposalMade", "proposal": proposal}}));
    let proposal = r["seq"].as_u64().unwrap();
    Replay { env, cwd, learning, _learner: learner, proposal, runs: HashSet::new() }
}

/// One run, as its host plays it.
struct Run {
    id: String,
    host: Rpc,
    with_change: bool,
}

impl Replay {
    /// A session's events, in order.
    fn entries(&self, id: &str) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }

    fn events(&self, id: &str, kind: &str) -> Vec<Value> {
        self.entries(id).into_iter().filter(|e| e["type"] == kind).collect()
    }

    fn wait_events(&self, id: &str, kind: &str, n: usize) -> Vec<Value> {
        let mut got = Vec::new();
        common::wait_for(&format!("{n} {kind} in {id}"), Duration::from_secs(60), || {
            got = self.events(id, kind);
            got.len() >= n
        });
        got
    }

    /// The next run the daemon starts, prompted and waiting for its turn,
    /// with the test registered as its host.
    fn next_run(&mut self) -> Run {
        let mut found = None;
        common::wait_for("the next replay run", Duration::from_secs(60), || {
            let r = self.env.rpc().ok("session/list", &json!({"kind": "replay"}));
            found = r["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| !self.runs.contains(s["id"].as_str().unwrap()))
                .map(|s| (s["id"].as_str().unwrap().to_string(), s["cwd"].as_str().unwrap().to_string()));
            found.is_some()
        });
        let (id, cwd) = found.unwrap();
        self.runs.insert(id.clone());
        self.wait_events(&id, "userMessage", 1);
        let mut host = common::slow_rpc(&self.env);
        host.ok("host/register", &json!({"id": id}));
        let with_change = Path::new(&cwd).join(".strive/memory.md").exists();
        host.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
        Run { id, host, with_change }
    }

    /// A run that follows the lesson when it has it: its check passes only then.
    fn play(&mut self) -> Run {
        let mut run = self.next_run();
        if run.with_change {
            let request = json!({"kind": "bash", "command": "touch ok"});
            run.host.ok("effect/run", &json!({"id": run.id, "callId": "t", "request": request}));
        }
        run
    }

    fn end(run: &mut Run) {
        let ended = json!({"type": "turnEnded", "turn": 1, "reason": {"kind": "done"}});
        run.host.ok("host/record", &json!({"id": run.id, "event": ended}));
    }

    fn proposal(&self) -> Value {
        let r = self.env.rpc().ok("proposal/list", &json!({"cwd": self.cwd}));
        r["proposals"].as_array().unwrap().iter().find(|p| p["id"] == self.proposal).unwrap().clone()
    }

    fn gate(&self, gate: &str) -> Option<(String, String)> {
        self.proposal()["gates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|g| g["gate"] == gate)
            .map(|g| (g["verdict"].as_str().unwrap().to_string(), g["detail"].as_str().unwrap().to_string()))
    }

    fn wait_gate(&self, gate: &str) -> (String, String) {
        let mut got = None;
        common::wait_for(&format!("the {gate} verdict"), Duration::from_secs(60), || {
            got = self.gate(gate);
            got.is_some()
        });
        got.unwrap()
    }

    fn log(&self) -> String {
        fs::read_to_string(self.env.home.path().join("logs/strived.log")).unwrap_or_default()
    }
}

#[test]
fn gated_records_nothing_when_the_file_changed_since_the_learner_read_it() {
    let mut r = replay(&json!({"learning": {"mode": "gated", "idleSeconds": 3600}}));
    let mut without = r.play();
    assert!(!without.with_change);
    Replay::end(&mut without);
    let mut with = r.play();
    assert!(with.with_change);
    // Someone edits the memory before the replay's pass lands.
    fs::create_dir_all(r.cwd.join(".strive")).unwrap();
    fs::write(r.cwd.join(".strive/memory.md"), "- mine\n").unwrap();
    Replay::end(&mut with);

    let (verdict, detail) = r.wait_gate("replay");
    assert_eq!(verdict, "pass", "{detail}");
    assert_eq!(r.gate("judge").map(|g| g.0), Some("pass".into()));
    common::wait_for("the gate to give up", Duration::from_secs(20), || {
        r.log().contains("its file changed since the learner read it; left for a person")
    });
    assert_eq!(r.proposal()["status"], "ready", "{}", r.proposal());
    assert_eq!(r.events(&r.learning, "proposalDecided"), Vec::<Value>::new());
    assert_eq!(fs::read_to_string(r.cwd.join(".strive/memory.md")).unwrap(), "- mine\n");
}

#[test]
fn a_gate_that_cant_accept_says_so_in_the_log() {
    let mut r = replay(&json!({"learning": {"mode": "gated", "idleSeconds": 3600}}));
    let mut without = r.play();
    Replay::end(&mut without);
    let mut with = r.play();
    // The memory becomes a symlink: the gate's write is refused.
    let elsewhere = tempfile::Builder::new().prefix("strv-else").tempdir_in("/tmp").unwrap().keep();
    fs::create_dir_all(r.cwd.join(".strive")).unwrap();
    std::os::unix::fs::symlink(elsewhere.join("memory.md"), r.cwd.join(".strive/memory.md")).unwrap();
    Replay::end(&mut with);

    assert_eq!(r.wait_gate("replay").0, "pass");
    let said = format!("proposal #{} passed every check, but the gate could not accept it", r.proposal);
    common::wait_for("the gate's failure in the log", Duration::from_secs(20), || r.log().contains(&said));
    assert!(!r.log().contains("could not journal the replay"), "the replay was journaled: {}", r.log());
    assert_eq!(r.proposal()["status"], "ready");
}

impl Replay {
    fn reject(&self) {
        let params = json!({"cwd": self.cwd, "proposal": self.proposal, "decision": "reject"});
        common::slow_rpc(&self.env).ok("proposal/decide", &params);
    }
}

#[test]
fn a_proposal_rejected_while_it_is_judged_isnt_replayed() {
    let r = replay_after(&json!({}), 1500);
    r.reject();
    assert_eq!(r.wait_gate("judge").0, "pass");
    let said = format!("proposal #{} was rejected before its checks finished; it isn't replayed", r.proposal);
    common::wait_for("the log to say it isn't replayed", Duration::from_secs(20), || r.log().contains(&said));
    assert_eq!(r.events(&r.learning, "replayStarted"), Vec::<Value>::new());
    assert_eq!(r.proposal()["status"], "rejected");
}

#[test]
fn rejecting_a_proposal_stops_its_replay_after_the_run_under_way() {
    let mut r = replay(&json!({"replay": {"runs": 2, "tasks": 1}}));
    let mut first = r.play();
    r.reject();
    Replay::end(&mut first);
    let finished = r.wait_events(&r.learning, "replayFinished", 1);
    let runs: Vec<&Value> = finished[0]["runs"].as_array().unwrap().iter().map(|run| &run["session"]).collect();
    assert_eq!(runs, [&json!(first.id)], "{finished:?}");
    let listed = r.env.rpc().ok("session/list", &json!({"kind": "replay"}));
    assert_eq!(listed["sessions"].as_array().unwrap().len(), 1, "no run started after the reject: {listed}");
    assert_eq!(r.gate("replay"), None, "a rejected proposal gets no replay verdict");
    assert_eq!(r.proposal()["status"], "rejected");
}

/// A model call through the gateway as `session`'s agent: its HTTP status.
fn call_model(env: &Env, session: &str) -> u16 {
    let base = env.rpc().ok("session/gateway", &json!({"id": session}))["anthropic"].as_str().unwrap().to_string();
    let body = json!({"model": "claude-haiku-4-5", "max_tokens": 100, "messages": [{"role": "user", "content": "hi"}]});
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let r = reqwest::Client::new()
            .post(format!("{base}/v1/messages"))
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .body(body.to_string())
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        r.bytes().await.unwrap();
        status
    })
}

/// What `events` (a session's) charge for their model calls.
fn charged(events: &[Value]) -> u64 {
    events
        .iter()
        .filter(|e| e["type"] == "modelCallFinished")
        .map(|e| e["outcome"]["costUsdMicros"].as_u64().unwrap())
        .sum()
}

/// Kills the daemon as a crash would, and waits for it to be gone.
fn crash(env: &Env) {
    let pid = common::pid(&env.status());
    assert!(std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap().success());
    common::wait_for("the daemon to die", Duration::from_secs(10), || {
        !std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().unwrap().success()
    });
}

#[test]
fn a_hold_a_crash_cut_off_is_charged_what_its_runs_spent_when_the_daemon_starts_again() {
    let mut r = replay(&json!({}));
    let run = r.play();
    assert_eq!(call_model(&r.env, &run.id), 200);
    let started = r.events(&r.learning, "replayStarted");
    crash(&r.env);

    let finished = r.wait_events(&r.learning, "replayFinished", 1);
    let spent = charged(&r.entries(&run.id));
    assert!(spent > 0);
    assert_eq!(finished[0]["costUsdMicros"], spent, "{finished:?}");
    assert_eq!(finished[0]["proposal"], started[0]["proposal"]);
    assert_eq!(
        r.events(&r.learning, "replayRunStarted"),
        [json!({"type": "replayRunStarted", "proposal": r.proposal, "session": run.id})]
    );
}
