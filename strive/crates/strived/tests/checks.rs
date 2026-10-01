//! Verification checks (ADR-0023): the daemon runs the command a check's
//! file holds, by name, and guards the files as it guards learned ones.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::Env;
use serde_json::{Value, json};

struct Ws {
    env: Env,
    _dir: tempfile::TempDir,
    root: PathBuf,
    id: String,
}

impl Ws {
    fn new() -> Self {
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-ck").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        Self { env, _dir: dir, root, id }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    fn mode(&self, mode: &str) {
        self.env.rpc().ok("session/approvals", &json!({"id": self.id, "mode": mode}));
    }
    fn run(&self, request: &Value) -> Value {
        self.env.rpc().call("effect/run", &json!({"id": self.id, "callId": "check:1:1:t", "request": request}))
    }
    fn events(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
}

fn check(name: &str, run: &str) -> String {
    format!("---\nname: {name}\ndescription: {name} passes\nrun: {run}\n---\n")
}

/// The next approval request an attached client sees.
fn next_request(c: &mut common::Rpc) -> Value {
    loop {
        let n = c.notification();
        let e = &n["params"]["entry"]["event"];
        if e["type"] == "approvalRequested" {
            return e.clone();
        }
    }
}

#[test]
fn a_check_no_one_accepted_asks_once_then_runs_without_asking_until_it_changes() {
    let w = Ws::new();
    w.write(".strive/checks/t.md", &check("t", "echo checked; exit 3"));
    w.mode("ask");
    // Nobody is attached to say a person wrote it, so it doesn't run.
    let r = w.run(&json!({"kind": "check", "name": "t"}));
    let reason = r["result"]["outcome"]["reason"].as_str().unwrap();
    assert!(reason.contains("no one has accepted in this form yet"), "{r}");
    assert!(reason.contains("even in full-auto"), "full-auto wouldn't let it run: {reason}");

    // A person allows it once...
    let mut ui = w.env.rpc();
    ui.ok("session/attach", &json!({"id": w.id}));
    let (env, id) = (w.env.rpc(), w.id.clone());
    let pending = std::thread::spawn(move || {
        let mut c = env;
        c.ok("effect/run", &json!({"id": id, "callId": "check:1:2:t", "request": {"kind": "check", "name": "t"}}))
    });
    let asked = next_request(&mut ui);
    assert!(asked["description"].as_str().unwrap().starts_with("run the check t, which no one has accepted"));
    let effect = asked["effect"].clone();
    ui.ok("approval/respond", &json!({"id": w.id, "effect": effect, "decision": "allow"}));
    let ran = pending.join().unwrap();
    assert_eq!(ran["outcome"]["exitCode"], 3, "{ran}");
    assert_eq!(ran["text"], "checked\n");
    // ...and the journal holds the command that ran, read from the file.
    assert_eq!(
        ran["record"],
        json!({"kind": "check", "name": "t", "command": "echo checked; exit 3", "timeoutMs": 120_000, "note": ""})
    );

    // From then on, in any session of the project, it runs without asking.
    let other = w.env.rpc().ok("session/create", &json!({"cwd": w.root}))["id"].as_str().unwrap().to_string();
    w.env.rpc().ok("session/approvals", &json!({"id": other, "mode": "ask"}));
    let again = w
        .env
        .rpc()
        .ok("effect/run", &json!({"id": other, "callId": "check:1:1:t", "request": {"kind": "check", "name": "t"}}));
    assert_eq!(again["outcome"]["exitCode"], 3, "{again}");

    // A changed file is a check no one has accepted yet (asked in the
    // session no client is attached to, so refused at once).
    w.write(".strive/checks/t.md", &check("t", "echo changed"));
    let changed = w
        .env
        .rpc()
        .ok("effect/run", &json!({"id": other, "callId": "check:1:2:t", "request": {"kind": "check", "name": "t"}}));
    assert!(changed["outcome"]["reason"].as_str().unwrap().contains("no one has accepted"), "{changed}");
    drop(ui);
}

#[test]
fn a_check_that_isnt_there_or_isnt_well_formed_is_refused_before_anything_runs() {
    let w = Ws::new();
    let missing = w.run(&json!({"kind": "check", "name": "absent"}));
    assert!(missing["error"]["message"].as_str().unwrap().contains("the check absent can't run"), "{missing}");
    w.write(".strive/checks/bad.md", "---\nname: bad\ndescription: d\n---\n");
    let bad = w.run(&json!({"kind": "check", "name": "bad"}));
    assert!(bad["error"]["message"].as_str().unwrap().contains("it has no run"), "{bad}");
    assert!(!w.events().iter().any(|e| e["type"] == "effectStarted"));
}

#[test]
fn a_check_reached_through_a_symlink_isnt_run() {
    let w = Ws::new();
    w.write("docs/t.md", &check("t", "echo linked"));
    fs::create_dir_all(w.root.join(".strive/checks")).unwrap();
    std::os::unix::fs::symlink(w.root.join("docs/t.md"), w.root.join(".strive/checks/t.md")).unwrap();
    let r = w.run(&json!({"kind": "check", "name": "t"}));
    assert!(r["error"]["message"].as_str().unwrap().contains("without a symlink"), "{r}");
}

#[test]
fn an_agents_change_to_a_check_asks_a_person_even_in_full_auto() {
    let w = Ws::new();
    w.mode("fullAuto");
    // No client is attached, so a request to ask is refused at once.
    let r = w.run(&json!({"kind": "write", "path": ".strive/checks/t.md", "content": check("t", "true")}));
    let reason = r["result"]["outcome"]["reason"].as_str().unwrap_or_default().to_string();
    assert!(reason.contains("changes what every future session in this project is told"), "{r}");
    assert!(!w.root.join(".strive/checks/t.md").exists());
}

fn register(env: &Env, cwd: &Path) -> (String, Value) {
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let config = c.ok("host/register", &json!({"id": id}));
    (id, config)
}

#[test]
fn a_host_is_told_when_each_check_applies_and_a_bad_one_is_noted_for_a_person() {
    let w = Ws::new();
    w.write(
        ".strive/checks/host.md",
        "---\nname: host\ndescription: host tests pass\nrun: bun test packages/host\npaths: packages/host/**\n---\n",
    );
    w.write(".strive/checks/typo.md", "---\nname: typo\ndescription: d\nrun: x\npath: src/**\n---\n");
    let (id, config) = register(&w.env, &w.root);
    // Not what it runs: the daemon reads that when it runs it.
    assert_eq!(
        config["checks"],
        json!([{"name": "host", "description": "host tests pass", "paths": ["packages/host/**"]}])
    );
    let r = w.env.rpc().ok("session/read", &json!({"id": id}));
    let loaded =
        r["entries"].as_array().unwrap().iter().map(|e| &e["event"]).find(|e| e["type"] == "contextLoaded").unwrap();
    assert_eq!(loaded["checks"], json!(["host"]));
    let skipped = loaded["skipped"].as_array().unwrap();
    assert!(
        skipped.iter().any(|s| s
            .as_str()
            .unwrap()
            .contains("typo.md was not loaded: the frontmatter has an unknown field \"path\"")),
        "{skipped:?}"
    );
}
