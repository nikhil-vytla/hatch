//! The judge gate (ADR-0017) end to end: the real daemon calls a scripted
//! model through its own gateway, on the learning session's budget, and
//! journals the verdict.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::response::Response;
use common::{Env, Rpc};
use serde_json::{Value, json};
use strive_proto::rpc::RpcError;

/// A fake Anthropic API that answers every call with the same body, after
/// a delay, and keeps each request's body.
struct Model {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Value>>>,
}

impl Model {
    fn start(reply: Value, delay_ms: u64) -> Self {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = std::sync::mpsc::channel();
        let s = seen.clone();
        std::thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                let app = axum::Router::new().fallback(move |body: Bytes| {
                    let (s, reply) = (s.clone(), reply.clone());
                    async move {
                        s.lock().unwrap().push(serde_json::from_slice(&body).unwrap());
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
        Self { addr: rx.recv().unwrap(), seen }
    }
    fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    fn seen(&self) -> Vec<Value> {
        self.seen.lock().unwrap().clone()
    }
}

/// A Messages API response that calls `record_verdict` with `input`.
fn answer(input: &Value) -> Value {
    json!({
        "id": "msg_judge", "type": "message", "role": "assistant", "model": "claude-haiku-4-5",
        "content": [{"type": "tool_use", "id": "toolu_1", "name": "record_verdict", "input": input}],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 900, "output_tokens": 120},
    })
}

const CRITERIA: [&str; 5] = ["supported", "generalizes", "novel", "safe", "checkable"];

/// A verdict; the criteria in `failing` fail.
fn verdict(failing: &[&str]) -> Value {
    let criteria: serde_json::Map<String, Value> = CRITERIA
        .iter()
        .map(|c| {
            let pass = !failing.contains(c);
            (
                (*c).to_string(),
                json!({"pass": pass, "reason": format!("{c} reason: {}", if pass { "holds" } else { "broken" })}),
            )
        })
        .collect();
    json!({
        "criteria": criteria,
        "verdict": if failing.is_empty() { "pass" } else { "fail" },
        "summary": "The judge's summary.",
    })
}

struct Judge {
    env: Env,
    model: Model,
    cwd: PathBuf,
}

/// A daemon with an Anthropic key whose judge is the scripted `reply`.
fn judge(reply: Value) -> Judge {
    judge_after(reply, 0)
}

fn judge_after(reply: Value, delay_ms: u64) -> Judge {
    let model = Model::start(reply, delay_ms);
    let url = model.url();
    let env = Env::with_vars(&[("STRIVE_UPSTREAM_ANTHROPIC", &url), ("ANTHROPIC_API_KEY", "sk-test-judge")]);
    fs::write(env.home.path().join("settings.json"), json!({"judgeModel": "claude-haiku-4-5"}).to_string()).unwrap();
    let cwd = tempfile::Builder::new().prefix("strv-proj").tempdir_in("/tmp").unwrap().keep().canonicalize().unwrap();
    Judge { env, model, cwd }
}

impl Judge {
    /// A work session with one prompt; its id and the prompt's seq.
    fn session(&self, prompt: &str) -> (String, u64) {
        let mut c = self.env.rpc();
        let id = c.ok("session/create", &json!({"cwd": self.cwd}))["id"].as_str().unwrap().to_string();
        let seq = c.ok("session/prompt", &json!({"id": id, "text": prompt}))["seq"].as_u64().unwrap();
        (id, seq)
    }
    fn learner(&self) -> (Rpc, String) {
        let id = self.env.rpc().ok("learning/open", &json!({"cwd": self.cwd}))["id"].as_str().unwrap().to_string();
        let mut host = self.env.rpc();
        host.ok("host/register", &json!({"id": id}));
        (host, id)
    }
    fn propose(host: &mut Rpc, id: &str, proposal: &Value) -> u64 {
        let r = host.call("host/record", &json!({"id": id, "event": {"type": "proposalMade", "proposal": proposal}}));
        assert!(r.get("error").is_none(), "proposing failed: {r}");
        r["result"]["seq"].as_u64().unwrap()
    }
    fn proposal(&self, id: u64) -> Value {
        let r = self.env.rpc().ok("proposal/list", &json!({"cwd": self.cwd}));
        r["proposals"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap().clone()
    }
    /// The judge's outcome, once it has one: (verdict, detail).
    fn judged(&self, id: u64) -> (String, String) {
        let mut out = None;
        common::wait_for("the judge's verdict", Duration::from_secs(20), || {
            let p = self.proposal(id);
            out = p["gates"]
                .as_array()
                .unwrap()
                .iter()
                .find(|g| g["gate"] == "judge")
                .map(|g| (g["verdict"].as_str().unwrap().to_string(), g["detail"].as_str().unwrap().to_string()));
            out.is_some()
        });
        out.unwrap()
    }
    fn events(&self, id: &str, kind: &str) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": id}));
        r["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["event"]["type"] == kind)
            .map(|e| e["event"].clone())
            .collect()
    }
    fn decide(&self, id: u64, decision: &str) -> Value {
        self.env.rpc().call("proposal/decide", &json!({"cwd": self.cwd, "proposal": id, "decision": decision}))
    }
}

fn memory(evidence: &[(&str, u64)]) -> Value {
    json!({
        "artifact": {"kind": "memory"},
        "content": "Run `bun test src`; the root holds failing fixtures.\n",
        "summary": "Run the real suite with bun test src",
        "rationale": "RATIONALE-TEXT: bun test at the root ran the fixtures and failed",
        "evidence": evidence.iter().map(|(s, seq)| json!({"session": s, "seqs": [seq], "note": "what happened"})).collect::<Vec<_>>(),
        "prediction": "the next session runs bun test src first",
    })
}

/// The JSON document the judge was given, from a request it received.
fn document(request: &Value) -> Value {
    let text = request["messages"][0]["content"].as_str().unwrap();
    serde_json::from_str(&text[text.find('{').unwrap()..]).unwrap()
}

fn ids(sessions: &Value) -> Vec<String> {
    sessions.as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn a_sound_proposal_passes_the_judge_on_the_learning_sessions_budget() {
    let j = judge(answer(&verdict(&[])));
    let (cited, seq) = j.session("CITED-PROMPT: run the tests");
    let (held, _) = j.session("HELD-PROMPT: fix the parser");
    let (mut host, learning) = j.learner();
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));

    let (v, detail) = j.judged(id);
    assert_eq!(v, "pass", "{detail}");
    assert!(detail.starts_with("passed all five criteria (claude-haiku-4-5"), "{detail}");
    assert!(detail.contains(&held) && detail.contains("The judge's summary."), "{detail}");
    for c in CRITERIA {
        assert!(detail.contains(&format!("pass {c}: {c} reason: holds")), "{c} in {detail}");
    }
    assert_eq!(j.proposal(id)["status"], "ready");

    let seen = j.model.seen();
    assert_eq!(seen.len(), 1);
    let req = &seen[0];
    assert_eq!(
        (req["model"].as_str(), req["tool_choice"]["name"].as_str()),
        (Some("claude-haiku-4-5"), Some("record_verdict"))
    );
    let doc = document(req);
    assert_eq!(doc["proposal"]["summary"], "Run the real suite with bun test src");
    assert!(
        doc["cited_sessions"][0]["journal"].as_str().unwrap().contains(&format!("#{seq} user: CITED-PROMPT")),
        "{doc}"
    );
    assert!(doc["held_out_sessions"][0]["journal"].as_str().unwrap().contains("HELD-PROMPT"), "{doc}");

    // The call is the learning session's: journaled and charged there.
    let finished = j.events(&learning, "modelCallFinished");
    assert_eq!(finished.len(), 1);
    assert!(finished[0]["outcome"]["costUsdMicros"].as_u64().unwrap() > 0, "{finished:?}");
    assert!(j.events(&cited, "modelCallStarted").is_empty());

    // A reviewer reads each criterion on its own line, under the gate's.
    let out = j.env.strive_in(&j.cwd, &["review", &id.to_string()]);
    let shown = String::from_utf8_lossy(&out.stdout);
    assert!(shown.contains("  judge   passed   passed all five criteria"), "{shown}");
    assert!(shown.contains(&format!("\n{:19}pass safe: safe reason: holds\n", "")), "{shown}");

    assert!(j.decide(id, "accept").get("error").is_none());
    assert_eq!(j.proposal(id)["status"], "applied");
}

#[test]
fn a_judge_fail_blocks_accepting() {
    let j = judge(answer(&verdict(&["safe", "generalizes"])));
    let (cited, seq) = j.session("run the tests");
    j.session("another task");
    let (mut host, learning) = j.learner();
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));

    let (v, detail) = j.judged(id);
    assert_eq!(v, "fail", "{detail}");
    assert!(detail.starts_with("failed generalizes, safe"), "{detail}");
    assert!(detail.contains("FAIL safe: safe reason: broken") && detail.contains("pass novel:"), "{detail}");
    assert_eq!(j.proposal(id)["status"], "failed");
    let r = j.decide(id, "accept");
    assert_eq!(r["error"]["code"], RpcError::INVALID_REQUEST, "{r}");
    assert!(r["error"]["message"].as_str().unwrap().contains("failed its checks"), "{r}");
    assert!(!j.cwd.join(".strive/memory.md").exists());
}

#[test]
fn an_answer_that_cant_be_read_fails() {
    let text = json!({
        "id": "msg_judge", "type": "message", "role": "assistant", "model": "claude-haiku-4-5",
        "content": [{"type": "text", "text": "{\"verdict\": \"pass\"} I think this passes."}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 900, "output_tokens": 12},
    });
    let j = judge(text);
    let (cited, seq) = j.session("run the tests");
    j.session("another task");
    let (mut host, learning) = j.learner();
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));
    let (v, detail) = j.judged(id);
    assert_eq!(v, "fail", "{detail}");
    assert!(detail.contains("couldn't be read, so it counts as a fail") && detail.contains("end_turn"), "{detail}");
    assert_eq!(j.proposal(id)["status"], "failed");
}

#[test]
fn a_verdict_that_disagrees_with_its_criteria_fails() {
    let mut said = verdict(&[]);
    said["verdict"] = json!("fail");
    let j = judge(answer(&said));
    let (cited, seq) = j.session("run the tests");
    j.session("another task");
    let (mut host, learning) = j.learner();
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));
    let (v, detail) = j.judged(id);
    assert_eq!(v, "fail", "{detail}");
    assert!(detail.contains("verdict was fail though every criterion passed"), "{detail}");
}

#[test]
fn with_no_session_to_hold_out_the_judge_is_skipped() {
    let j = judge(answer(&verdict(&[])));
    let (cited, seq) = j.session("run the tests");
    // A session with no prompt has nothing to judge against.
    j.env.rpc().ok("session/create", &json!({"cwd": j.cwd}));
    let (mut host, learning) = j.learner();
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));
    let p = j.proposal(id);
    assert_eq!(p["status"], "ready", "a skip doesn't block: {p}");
    let (v, detail) = j.judged(id);
    assert_eq!(v, "skipped");
    assert!(detail.contains("no work session of this project could be held out"), "{detail}");
    assert!(j.model.seen().is_empty(), "nothing was sent");
}

#[test]
fn with_no_budget_left_the_judge_is_skipped() {
    let j = judge(answer(&verdict(&[])));
    let (cited, seq) = j.session("run the tests");
    j.session("another task");
    let (mut host, learning) = j.learner();
    j.env.rpc().ok("session/budget", &json!({"id": learning, "usdMicros": 1}));
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));
    let (v, detail) = j.judged(id);
    assert_eq!(v, "skipped", "{detail}");
    assert!(detail.starts_with("not run: the learning session's budget can't pay for the judge"), "{detail}");
    assert!(detail.contains("session budget is left"), "the gateway's reason: {detail}");
    assert_eq!(j.proposal(id)["status"], "ready");
    assert!(j.model.seen().is_empty(), "nothing was sent");
}

#[test]
fn with_no_key_the_judge_is_skipped() {
    let env = Env::new();
    let cwd = tempfile::Builder::new().prefix("strv-proj").tempdir_in("/tmp").unwrap().keep().canonicalize().unwrap();
    let mut c = env.rpc();
    let work = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let seq = c.ok("session/prompt", &json!({"id": work, "text": "run the tests"}))["seq"].as_u64().unwrap();
    let other = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    c.ok("session/prompt", &json!({"id": other, "text": "another"}));
    let learning = c.ok("learning/open", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let mut host = env.rpc();
    host.ok("host/register", &json!({"id": learning}));
    let r = host.call(
        "host/record",
        &json!({"id": learning, "event": {"type": "proposalMade", "proposal": memory(&[(&work, seq)])}}),
    );
    let id = r["result"]["seq"].as_u64().unwrap();
    let p = env.rpc().ok("proposal/list", &json!({"cwd": cwd}))["proposals"][0].clone();
    assert_eq!((p["id"].as_u64(), p["status"].as_str()), (Some(id), Some("ready")));
    let g = p["gates"].as_array().unwrap().iter().find(|g| g["gate"] == "judge").unwrap().clone();
    assert_eq!(g["verdict"], "skipped");
    assert!(g["detail"].as_str().unwrap().contains("`strive auth anthropic`"), "{g}");
}

#[test]
fn the_judge_sees_the_proposal_but_not_the_learners_reasoning() {
    let j = judge(answer(&verdict(&[])));
    let (cited, seq) = j.session("run the tests");
    j.session("another task");
    let (mut host, learning) = j.learner();
    host.ok("host/record", &json!({"id": learning, "event": {"type": "turnStarted", "turn": 1}}));
    let reply = "LEARNER-REASONING: the user seemed annoyed, so this lesson matters";
    host.ok(
        "host/record",
        &json!({"id": learning, "event": {"type": "assistantMessage", "turn": 1, "text": reply, "toolCalls": [],
                "message": {"role": "assistant", "content": reply}}}),
    );
    let id = Judge::propose(&mut host, &learning, &memory(&[(&cited, seq)]));
    j.judged(id);
    let sent = j.model.seen()[0].to_string();
    assert!(sent.contains("RATIONALE-TEXT"), "the proposal's own text is judged");
    assert!(!sent.contains("LEARNER-REASONING"), "the learner's replies aren't: {sent}");
    assert!(!sent.contains(&learning), "nor anything of the learning session's");
}

#[test]
fn held_out_sessions_are_the_newest_the_proposal_doesnt_cite() {
    let j = judge(answer(&verdict(&[])));
    let (first, first_seq) = j.session("cited one");
    let mut uncited: Vec<String> = (0..4).map(|n| j.session(&format!("task {n}")).0).collect();
    let (last, last_seq) = j.session("cited two");
    let (mut host, learning) = j.learner();
    let id = Judge::propose(&mut host, &learning, &memory(&[(&first, first_seq), (&last, last_seq)]));
    let (_, detail) = j.judged(id);

    let doc = document(&j.model.seen()[0]);
    let held = ids(&doc["held_out_sessions"]);
    uncited.sort();
    let newest: Vec<String> = uncited.iter().rev().take(3).cloned().collect();
    assert_eq!(held, newest, "the newest three uncited");
    let mut cited = ids(&doc["cited_sessions"]);
    cited.sort();
    let mut want = vec![first, last];
    want.sort();
    assert_eq!(cited, want);
    assert!(held.iter().all(|h| detail.contains(h.as_str())), "{detail}");
}

#[test]
fn a_judge_cut_short_by_a_crash_runs_again_on_the_next_look() {
    let j = judge_after(answer(&verdict(&[])), 300);
    let (cited, seq) = j.session("run the tests");
    j.session("another task");
    let learning = j.env.rpc().ok("learning/open", &json!({"cwd": j.cwd}))["id"].as_str().unwrap().to_string();
    j.env.stop();
    // What a crash during the judge's call leaves: the proposal and the
    // gates decided at once, and no judge verdict.
    let key: [u8; 32] = fs::read(j.env.home.path().join("keys/journal.key")).unwrap().try_into().unwrap();
    let key = strive_journal::Key::from_bytes(key);
    let dir: &Path = &j.env.session_dir(&learning);
    let (mut journal, entries) = strive_journal::Journal::open(dir, &learning, &key, 1).unwrap();
    let next = entries.last().unwrap().seq + 1;
    let events: Vec<strive_proto::Event> = serde_json::from_value(json!([
        {"type": "proposalMade", "proposal": memory(&[(&cited, seq)])},
        {"type": "gateFinished", "proposal": next, "gate": "static", "verdict": "pass", "detail": "fine"},
        {"type": "gateFinished", "proposal": next, "gate": "replay", "verdict": "skipped", "detail": "not built"},
    ]))
    .unwrap();
    let id = journal.append(entries.last().unwrap().ts_ms, &events).unwrap()[0].seq;
    journal.commit().unwrap();
    drop(journal);

    assert_eq!(j.proposal(id)["status"], "checking", "the judge is running again");
    j.proposal(id);
    let (v, _) = j.judged(id);
    assert_eq!(v, "pass");
    assert_eq!(j.proposal(id)["status"], "ready");
    assert_eq!(j.model.seen().len(), 1, "judged once, though looked at while it ran");
    assert_eq!(j.events(&learning, "gateFinished").iter().filter(|g| g["gate"] == "judge").count(), 1);
}
