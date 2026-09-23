//! Approval modes: what the agent may do on its own, and asking a person
//! (any attached client) for the rest.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::time::Duration;

use common::{Env, Rpc};
use serde_json::{Value, json};

struct Ws {
    env: Env,
    dir: tempfile::TempDir,
    id: String,
}

impl Ws {
    fn new() -> Self {
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-ws").tempdir_in("/tmp").unwrap();
        let cwd = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
        Self { env, dir, id }
    }
    fn file(&self, rel: &str) -> std::path::PathBuf {
        self.dir.path().canonicalize().unwrap().join(rel)
    }
    fn mode(&self, mode: &str) {
        self.env.rpc().ok("session/approvals", &json!({"id": self.id, "mode": mode}));
    }
    /// Runs an effect on its own connection in a thread, since it may block
    /// waiting for approval.
    fn spawn_effect(&self, request: Value) -> std::thread::JoinHandle<Value> {
        let mut c = self.env.rpc();
        let mut params = json!({"id": self.id, "callId": "call_9"});
        params["request"] = request;
        std::thread::spawn(move || c.ok("effect/run", &params))
    }
    fn attached(&self) -> Rpc {
        let mut c = self.env.rpc();
        c.ok("session/attach", &json!({"id": self.id}));
        c
    }
    fn events(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
}

/// The next approval request an attached client sees.
fn next_request(c: &mut Rpc) -> Value {
    loop {
        let n = c.notification();
        let e = &n["params"]["entry"]["event"];
        if e["type"] == "approvalRequested" {
            return e.clone();
        }
    }
}

#[test]
fn sessions_start_in_auto_edit_mode() {
    let w = Ws::new();
    assert_eq!(w.events()[2], json!({"type": "approvalModeSet", "mode": "autoEdit"}));
}

#[test]
fn auto_edit_writes_in_the_workspace_without_asking() {
    let w = Ws::new();
    let r = w.spawn_effect(json!({"kind": "write", "path": "a.txt", "content": "x"})).join().unwrap();
    assert_eq!(r["text"], "wrote a.txt (1 bytes)");
    assert!(!w.events().iter().any(|e| e["type"] == "approvalRequested"));
}

#[test]
fn a_command_waits_for_an_attached_client_to_allow_it() {
    let w = Ws::new();
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "echo hi"}));
    let req = next_request(&mut ui);
    assert_eq!(req, json!({"type": "approvalRequested", "effect": 1, "description": "run: echo hi"}));
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allow"}));
    let r = pending.join().unwrap();
    assert_eq!(r["text"], "hi\n");
    let kinds: Vec<Value> = w.events().iter().skip(3).map(|e| e["type"].clone()).collect();
    assert_eq!(kinds, vec!["effectStarted", "approvalRequested", "approvalDecided", "effectFinished"]);
    assert_eq!(w.events()[5], json!({"type": "approvalDecided", "effect": 1, "decision": "allow", "by": "test"}));
}

#[test]
fn a_declined_command_does_not_run() {
    let w = Ws::new();
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "touch made.txt"}));
    next_request(&mut ui);
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "deny"}));
    let r = pending.join().unwrap();
    assert_eq!(r["outcome"], json!({"kind": "refused", "reason": "declined: run: touch made.txt"}));
    assert!(!w.file("made.txt").exists());
}

#[test]
fn with_no_one_attached_a_request_is_refused_at_once() {
    let w = Ws::new();
    let started = std::time::Instant::now();
    let r = w.spawn_effect(json!({"kind": "bash", "command": "touch made.txt"})).join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        r["text"],
        "run: touch made.txt needs approval, but no client is attached to give it; use full-auto approvals for unattended runs"
    );
    assert!(!w.file("made.txt").exists());
}

#[test]
fn allowing_for_the_session_switches_to_full_auto() {
    let w = Ws::new();
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "echo one"}));
    next_request(&mut ui);
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allowSession"}));
    assert_eq!(pending.join().unwrap()["text"], "one\n");
    let r = w.spawn_effect(json!({"kind": "bash", "command": "echo two"})).join().unwrap();
    assert_eq!(r["text"], "two\n", "no second question");
    assert!(w.events().iter().any(|e| *e == json!({"type": "approvalModeSet", "mode": "fullAuto"})));
}

#[test]
fn ask_mode_asks_before_editing_the_workspace() {
    let w = Ws::new();
    w.mode("ask");
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "write", "path": "a.txt", "content": "x"}));
    assert_eq!(next_request(&mut ui)["description"], "write a.txt");
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allow"}));
    assert_eq!(pending.join().unwrap()["text"], "wrote a.txt (1 bytes)");
}

#[test]
fn full_auto_still_asks_before_writing_outside_the_workspace() {
    let w = Ws::new();
    w.mode("fullAuto");
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().canonicalize().unwrap().join("out.txt");
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "write", "path": target, "content": "x"}));
    let req = next_request(&mut ui);
    assert_eq!(req["description"], format!("write outside the workspace: {}", target.display()));
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allow"}));
    pending.join().unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "x");
}

#[test]
fn strives_state_is_refused_without_asking_in_any_mode() {
    let w = Ws::new();
    w.mode("fullAuto");
    let _ui = w.attached();
    let key = w.env.home.path().join("keys/journal.key");
    let r = w.spawn_effect(json!({"kind": "write", "path": key, "content": "x"})).join().unwrap();
    assert_eq!(r["text"], "the agent can't read strive's own state");
    assert!(!w.events().iter().any(|e| e["type"] == "approvalRequested"));
}

#[test]
fn one_connection_keeps_answering_while_a_request_waits_for_approval() {
    let w = Ws::new();
    let mut ui = w.attached();
    let mut c = w.env.rpc();
    c.send_line(
        &json!({"jsonrpc": "2.0", "id": 50, "method": "effect/run",
                "params": {"id": w.id, "callId": "c", "request": {"kind": "bash", "command": "echo later"}}})
        .to_string(),
    );
    next_request(&mut ui);
    c.send_line(&json!({"jsonrpc": "2.0", "id": 51, "method": "daemon/status", "params": {}}).to_string());
    assert_eq!(c.next_response()["id"], 51, "status answers while the effect waits");
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allow"}));
    let done = c.next_response();
    assert_eq!((done["id"].clone(), done["result"]["text"].clone()), (json!(50), json!("later\n")));
}

#[test]
fn deciding_an_unknown_or_settled_request_is_an_error() {
    let w = Ws::new();
    let mut ui = w.attached();
    let r = ui.call("approval/respond", &json!({"id": w.id, "effect": 7, "decision": "allow"}));
    assert_eq!(r["error"]["code"], -32012);
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "echo x"}));
    next_request(&mut ui);
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allow"}));
    pending.join().unwrap();
    let again = ui.call("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "deny"}));
    assert_eq!(again["error"]["code"], -32012);
}

/// The agent asks; only a person decides. A host that sees the request
/// (it sees every entry) can't answer it, even for itself.
#[test]
fn an_agent_host_cannot_approve_its_own_request() {
    let w = Ws::new();
    let mut host = w.env.rpc();
    host.ok("host/register", &json!({"id": w.id}));
    host.ok("session/attach", &json!({"id": w.id}));
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "touch made.txt"}));
    next_request(&mut ui);
    let refused = host.call("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allowSession"}));
    assert_eq!(refused["error"]["code"], strive_proto::rpc::RpcError::NOT_A_PERSON, "{refused}");
    assert!(!w.file("made.txt").exists());
    ui.ok("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "deny"}));
    assert_eq!(pending.join().unwrap()["outcome"]["kind"], "refused");
    assert!(!w.events().iter().any(|e| e["type"] == "approvalModeSet" && e["mode"] == "fullAuto"));
}

/// A request no one is left to answer is refused, not left waiting forever.
#[test]
fn a_request_is_refused_when_the_last_person_detaches() {
    let w = Ws::new();
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "touch made.txt"}));
    next_request(&mut ui);
    drop(ui);
    let started = std::time::Instant::now();
    let r = pending.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(3), "refused {:?} after the person left", started.elapsed());
    assert_eq!(r["outcome"]["kind"], "refused", "{r}");
    assert!(!w.file("made.txt").exists());
}

/// Stopping the daemon doesn't wait on a decision that may never come.
#[test]
fn the_daemon_stops_while_a_request_waits_for_approval() {
    let w = Ws::new();
    let mut ui = w.attached();
    let _pending = w.spawn_effect(json!({"kind": "bash", "command": "touch made.txt"}));
    next_request(&mut ui);
    let started = std::time::Instant::now();
    w.env.stop(); // returns once the daemon is gone
    assert!(started.elapsed() < Duration::from_secs(5), "stopped after {:?}", started.elapsed());
    assert!(!w.file("made.txt").exists());
}

/// The agent gives up on a request (the person pressed Esc, or the turn ran
/// out of time): it is refused, and approving it later does nothing.
#[test]
fn a_cancelled_request_is_refused_and_cant_be_approved_later() {
    let w = Ws::new();
    let mut ui = w.attached();
    let pending = w.spawn_effect(json!({"kind": "bash", "command": "touch made.txt"}));
    next_request(&mut ui);
    w.env.rpc().ok("effect/cancel", &json!({"id": w.id, "callId": "call_9"}));
    let r = pending.join().unwrap();
    assert_eq!(r["outcome"], json!({"kind": "refused", "reason": "interrupted: run: touch made.txt"}));
    let late = ui.call("approval/respond", &json!({"id": w.id, "effect": 1, "decision": "allow"}));
    assert_eq!(late["error"]["code"], strive_proto::rpc::RpcError::APPROVAL_NOT_PENDING, "{late}");
    assert!(!w.file("made.txt").exists());
}
