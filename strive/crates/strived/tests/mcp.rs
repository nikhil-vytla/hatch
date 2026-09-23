//! MCP servers: the daemon runs them for a session, and every tool call is
//! an effect: gated, journaled and cancellable.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use common::{Env, Rpc};
use serde_json::{Value, json};

/// The fake server `cargo test` builds from `examples/fake_mcp.rs`.
fn fake_server() -> PathBuf {
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let exe = deps.parent().unwrap().join("examples/fake_mcp");
    assert!(exe.is_file(), "{} is missing: `cargo test` builds it, or `cargo build --examples`", exe.display());
    exe
}

struct Ws {
    env: Env,
    dir: tempfile::TempDir,
    id: String,
    /// Registered as the session's host.
    host: Rpc,
    config: Value,
    log: PathBuf,
}

impl Ws {
    /// A session whose settings name the fake server (and a broken one).
    fn new(vars: &[(&str, &str)]) -> Self {
        let env = Env::with_vars(vars);
        let dir = tempfile::Builder::new().prefix("strv-mcp").tempdir_in("/tmp").unwrap();
        let log = env.home.path().join("fake-notifications.log");

        let settings = json!({"mcpServers": {
                        // Through a shell, as servers started with npx are: the server is
            // a grandchild of the daemon.
            "fake": {"command": "/bin/sh", "args": ["-c", "\"$0\"; true", fake_server()], "env": {"FAKE_VAR": "from settings", "FAKE_MCP_LOG": log,
                                "FAKE_MCP_PID": env.home.path().join("fake.pid"), "FAKE_MCP_STUBBORN": "1"}},
            "broken": {"command": fake_server(), "env": {"FAKE_MCP_BROKEN": "1"}},
        }});
        std::fs::write(env.home.path().join("settings.json"), settings.to_string()).unwrap();
        let mut host = env.rpc();
        let cwd = dir.path().canonicalize().unwrap();
        let id = host.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
        let config = host.ok("host/register", &json!({"id": id}));
        Self { env, dir, id, host, config, log }
    }
    /// Set by a person, as only a person may.
    fn mode(&self, mode: &str) {
        self.env.rpc().ok("session/approvals", &json!({"id": self.id, "mode": mode}));
    }
    fn call(&mut self, tool: &str, arguments: &Value) -> Value {
        let request = json!({"kind": "mcp", "server": "fake", "tool": tool, "arguments": arguments});
        self.host.ok("effect/run", &json!({"id": self.id, "callId": format!("call_{tool}"), "request": request}))
    }
    fn events(&mut self) -> Vec<Value> {
        let r = self.host.ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
}

#[test]
fn the_agent_is_given_every_tool_and_the_journal_says_which_servers_started() {
    let mut w = Ws::new(&[]);
    let tools: Vec<(String, String)> = w.config["mcpTools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| (t["server"].as_str().unwrap().into(), t["name"].as_str().unwrap().into()))
        .collect();
    let names: Vec<&str> = tools.iter().map(|(_, n)| n.as_str()).collect();
    assert_eq!(names, ["echo", "fail", "slow", "where"], "both pages of tools/list");
    assert!(tools.iter().all(|(s, _)| s == "fake"));
    assert_eq!(w.config["mcpTools"][0]["inputSchema"]["required"], json!(["text"]));
    let loaded = w.events().into_iter().find(|e| e["type"] == "contextLoaded").unwrap();
    assert_eq!(loaded["mcp"][1], json!({"server": "fake", "tools": 4}));
    assert_eq!(loaded["mcp"][0]["server"], "broken");
    assert_eq!(loaded["mcp"][0]["tools"], 0);
    assert!(loaded["mcp"][0]["error"].as_str().unwrap().contains("exited during initialize"), "{loaded}");
}

#[test]
fn a_tool_call_is_an_effect_with_its_arguments_in_the_content_store() {
    let mut w = Ws::new(&[]);
    w.mode("fullAuto");
    let r = w.call("echo", &json!({"text": "hi"}));
    assert_eq!(r["text"], "echo: hi");
    assert_eq!(r["outcome"]["kind"], "done");
    let started = w.events().into_iter().find(|e| e["type"] == "effectStarted").unwrap();
    assert_eq!(started["record"]["kind"], "mcp");
    assert_eq!(started["record"]["server"], "fake");
    assert_eq!(started["record"]["tool"], "echo");
    let digest = started["record"]["arguments"].clone();
    let blob = w.host.ok("blob/get", &json!({"digest": digest}));
    assert_eq!(serde_json::from_str::<Value>(blob["text"].as_str().unwrap()).unwrap(), json!({"text": "hi"}));
}

#[test]
fn an_error_result_reaches_the_agent_as_a_refusal() {
    let mut w = Ws::new(&[]);
    w.mode("fullAuto");
    assert_eq!(w.call("fail", &json!({}))["outcome"], json!({"kind": "refused", "reason": "it broke"}));
}

#[test]
fn a_tool_call_asks_first_unless_approvals_are_full_auto() {
    let w = Ws::new(&[]);
    let mut ui = w.env.rpc();
    ui.ok("session/attach", &json!({"id": w.id}));
    let mut agent = w.env.rpc();
    let params = json!({"id": w.id, "callId": "call_1",
        "request": {"kind": "mcp", "server": "fake", "tool": "echo", "arguments": {"text": "x"}}});
    let pending = std::thread::spawn(move || agent.ok("effect/run", &params));
    let asked = loop {
        let n = ui.notification();
        if n["params"]["entry"]["event"]["type"] == "approvalRequested" {
            break n["params"]["entry"]["event"].clone();
        }
    };
    assert_eq!(asked["description"], "use fake's echo tool");
    ui.ok("approval/respond", &json!({"id": w.id, "effect": asked["effect"], "decision": "allow"}));
    assert_eq!(pending.join().unwrap()["text"], "echo: x");
}

#[test]
fn a_cancelled_tool_call_is_cancelled_at_the_server_too() {
    let mut w = Ws::new(&[]);
    w.mode("fullAuto");
    let mut agent = w.env.rpc();
    let params = json!({"id": w.id, "callId": "call_slow",
        "request": {"kind": "mcp", "server": "fake", "tool": "slow", "arguments": {}}});
    let running = std::thread::spawn(move || agent.ok("effect/run", &params));
    common::wait_for("the server to get the call", Duration::from_secs(5), || {
        std::fs::read_to_string(&w.log).is_ok_and(|l| l.contains("call \"slow\""))
    });
    let started = Instant::now();
    w.host.ok("effect/cancel", &json!({"id": w.id, "callId": "call_slow"}));
    let r = running.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "cancelled after {:?}", started.elapsed());
    assert_eq!(r["outcome"], json!({"kind": "refused", "reason": "interrupted: fake's slow was cancelled"}));
    common::wait_for("the server to hear of it", Duration::from_secs(2), || {
        std::fs::read_to_string(&w.log).is_ok_and(|l| l.contains("notifications/cancelled"))
    });
}

#[test]
fn a_server_runs_in_the_session_directory_without_provider_keys() {
    let mut w = Ws::new(&[("ANTHROPIC_API_KEY", "sk-must-not-leak")]);
    w.mode("fullAuto");
    let cwd = w.dir.path().canonicalize().unwrap();
    assert_eq!(w.call("where", &json!({}))["text"], format!("cwd={} key=unset var=from settings", cwd.display()));
}

#[test]
fn stopping_the_daemon_stops_its_servers() {
    let w = Ws::new(&[]);
    let pid = std::fs::read_to_string(w.env.home.path().join("fake.pid")).unwrap();
    let alive = || std::process::Command::new("kill").args(["-0", pid.trim()]).status().unwrap().success();
    assert!(alive());
    w.env.stop();
    common::wait_for("the server to exit", Duration::from_secs(3), || !alive());
}

#[test]
fn a_call_to_a_server_that_isnt_running_is_refused() {
    let mut w = Ws::new(&[]);
    w.mode("fullAuto");
    let request = json!({"kind": "mcp", "server": "broken", "tool": "echo", "arguments": {}});
    let r = w.host.ok("effect/run", &json!({"id": w.id, "callId": "c", "request": request}));
    assert_eq!(r["outcome"]["reason"], "no MCP server named broken is running for this session");
}
