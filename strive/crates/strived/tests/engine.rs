//! Vendor engines (ADR-0031): a session Claude Code runs, whose every tool
//! call the daemon gates before it runs and journals as observed.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::PathBuf;

use common::Env;
use serde_json::{Value, json};

struct Ws {
    env: Env,
    _dir: tempfile::TempDir,
    root: PathBuf,
    id: String,
}

impl Ws {
    fn new(mode: &str) -> Self {
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-eng").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root, "engine": "claude-code"}))["id"]
            .as_str()
            .unwrap()
            .to_string();
        env.rpc().ok("session/approvals", &json!({"id": id, "mode": mode}));
        Self { env, _dir: dir, root, id }
    }
    fn observe(&self, call: &str, tool: &str, input: &Value) -> Value {
        self.env.rpc().ok("effect/observe", &json!({"id": self.id, "callId": call, "tool": tool, "input": input}))
    }
    fn events(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
    fn of(&self, kind: &str, effect: &Value) -> Vec<Value> {
        self.events().into_iter().filter(|e| e["type"] == kind && &e["effect"] == effect).collect()
    }
}

#[test]
fn a_session_says_which_engine_runs_it_and_its_host_is_told() {
    let w = Ws::new("ask");
    assert!(w.events().iter().any(|e| e == &json!({"type": "engineSet", "engine": "claude-code"})));
    let config = w.env.rpc().ok("host/register", &json!({"id": w.id}));
    assert_eq!(config["engine"], "claude-code");
    assert!(config["engineHome"].as_str().unwrap().ends_with("/engine"), "{config}");
    // Without one, strive's own agent runs it, and the journal says nothing.
    let native = w.env.rpc().ok("session/create", &json!({"cwd": w.root}))["id"].as_str().unwrap().to_string();
    let config = w.env.rpc().ok("host/register", &json!({"id": native}));
    assert!(config.get("engine").is_none(), "{config}");
}

#[test]
fn an_allowed_call_is_journaled_before_it_runs_and_its_report_finishes_it() {
    let w = Ws::new("fullAuto");
    fs::write(w.root.join("a.txt"), "hello\n").unwrap();
    let r = w.observe("toolu_1", "Read", &json!({"file_path": w.root.join("a.txt")}));
    assert_eq!(r["allowed"], true, "{r}");
    let effect = r["effect"].clone();
    let started = &w.of("effectStarted", &effect)[0];
    assert_eq!((&started["callId"], &started["record"]["kind"]), (&json!("toolu_1"), &json!("observed")));
    assert_eq!(started["record"]["tool"], "Read");
    assert_eq!(w.of("effectCleared", &effect).len(), 1);
    assert_eq!(w.of("effectFinished", &effect).len(), 0, "it runs in the vendor, after this");

    w.env.rpc().ok("effect/report", &json!({"id": w.id, "effect": effect, "output": "1\thello"}));
    let finished = &w.of("effectFinished", &effect)[0];
    assert_eq!(finished["outcome"]["kind"], "done");
    let out = w.env.rpc().ok("blob/get", &json!({"digest": finished["outcome"]["output"]}));
    assert_eq!(out["text"], "1\thello");
    // Once: a second report has nothing open to finish.
    let again = w.env.rpc().call("effect/report", &json!({"id": w.id, "effect": effect, "output": "x"}));
    assert!(again["error"]["message"].as_str().unwrap().contains("already reported"), "{again}");
    assert_eq!(w.of("effectFinished", &effect).len(), 1);
}

#[test]
fn a_call_is_refused_as_strives_own_would_be() {
    let w = Ws::new("fullAuto");
    // strive's own state stays out of reach, whatever runs the turn.
    let secret = w.env.home.path().join("keys/journal.key");
    let r = w.observe("toolu_1", "Read", &json!({"file_path": secret}));
    assert_eq!(r["allowed"], false, "{r}");
    assert!(r["reason"].as_str().unwrap().contains("strive's own state"), "{r}");
    assert_eq!(w.of("effectFinished", &r["effect"])[0]["outcome"]["kind"], "refused");
    assert_eq!(w.of("effectCleared", &r["effect"]).len(), 0);
    // What shapes later sessions asks a person even in full-auto; no one is here.
    let r = w.observe("toolu_2", "Write", &json!({"file_path": w.root.join("AGENTS.md"), "content": "x"}));
    assert_eq!(r["allowed"], false, "{r}");
    assert!(r["reason"].as_str().unwrap().contains("needs a person's approval"), "{r}");
    // A report for a call never allowed is refused.
    let r = w.env.rpc().call("effect/report", &json!({"id": w.id, "effect": r["effect"], "output": "x"}));
    assert!(r["error"]["message"].as_str().unwrap().contains("isn't an observed call the daemon allowed"), "{r}");
}

#[test]
fn a_command_and_an_unknown_tool_ask_unless_full_auto_and_a_plan_never_does() {
    let w = Ws::new("autoEdit");
    let r = w.observe("toolu_1", "Bash", &json!({"command": "ls"}));
    assert_eq!(r["allowed"], false);
    assert!(r["reason"].as_str().unwrap().starts_with("run: ls needs a person's approval"), "{r}");
    let r = w.observe("toolu_2", "WebFetch", &json!({"url": "https://example.com"}));
    assert!(r["reason"].as_str().unwrap().contains("use Claude Code's WebFetch tool"), "{r}");
    assert_eq!(w.observe("toolu_3", "TodoWrite", &json!({"todos": []}))["allowed"], true);
    // An edit in the workspace is auto-edit's to allow.
    fs::write(w.root.join("b.txt"), "x").unwrap();
    assert_eq!(w.observe("toolu_4", "Edit", &json!({"file_path": w.root.join("b.txt")}))["allowed"], true);

    w.env.rpc().ok("session/approvals", &json!({"id": w.id, "mode": "fullAuto"}));
    assert_eq!(w.observe("toolu_5", "Bash", &json!({"command": "ls"}))["allowed"], true);
}
