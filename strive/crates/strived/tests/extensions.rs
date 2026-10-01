//! Code extensions (ADR-0027): tools a project's TypeScript declares, each
//! call run as a command in the sandbox, unasked only in a form a person
//! accepted.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::PathBuf;

use common::{Env, Rpc};
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
        let dir = tempfile::Builder::new().prefix("strv-ext").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        Self { env, _dir: dir, root, id }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    /// Writes the extension `shout`, whose tool `loud` returns its text in capitals.
    fn shout(&self, suffix: &str) {
        self.write(
            ".strive/extensions/shout/extension.json",
            &json!({
                "name": "shout",
                "description": "Says things loudly",
                "tools": [{
                    "name": "loud",
                    "description": "The text in capitals",
                    "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
                }],
            })
            .to_string(),
        );
        self.write(
            ".strive/extensions/shout/index.ts",
            &format!("export const tools = {{ loud: async ({{ text }}: {{ text: string }}) => text.toUpperCase() + \"{suffix}\" }};\n"),
        );
    }
    fn call(&self, c: &mut Rpc, call: &str, tool: &str, arguments: &Value) -> Value {
        c.call(
            "effect/run",
            &json!({"id": self.id, "callId": call, "request": {"kind": "extension", "name": "shout", "tool": tool, "arguments": arguments}}),
        )
    }
    fn spawn(&self, call: &str, arguments: &Value) -> std::thread::JoinHandle<Value> {
        let (mut c, params) = (
            self.env.rpc(),
            json!({"id": self.id, "callId": call, "request": {"kind": "extension", "name": "shout", "tool": "loud", "arguments": arguments}}),
        );
        std::thread::spawn(move || c.ok("effect/run", &params))
    }
}

/// The next approval request an attached client sees, answered with `decision`.
fn answer(ui: &mut Rpc, session: &str, decision: &str) -> Value {
    loop {
        let n = ui.notification();
        let e = &n["params"]["entry"]["event"];
        if e["type"] == "approvalRequested" {
            ui.ok("approval/respond", &json!({"id": session, "effect": e["effect"], "decision": decision}));
            return e.clone();
        }
    }
}

fn sandboxed() -> bool {
    if cfg!(target_os = "macos") {
        return std::path::Path::new("/usr/bin/sandbox-exec").exists();
    }
    std::process::Command::new("bwrap")
        .args(["--ro-bind", "/", "/", "--unshare-net", "true"])
        .status()
        .is_ok_and(|s| s.success())
}

#[test]
fn a_tool_asks_until_a_person_allows_it_then_runs_and_asks_again_once_changed() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine: every extension call asks");
        return;
    }
    let w = Ws::new();
    w.shout("!");
    // Nobody is attached to accept it, so it doesn't run.
    let mut c = w.env.rpc();
    let r = w.call(&mut c, "c1", "loud", &json!({"text": "hi"}));
    assert!(
        r["result"]["outcome"]["reason"].as_str().unwrap().contains("shout's tool loud, which no one has accepted"),
        "{r}"
    );

    let mut ui = w.env.rpc();
    ui.ok("session/attach", &json!({"id": w.id}));
    let pending = w.spawn("c2", &json!({"text": "hi"}));
    answer(&mut ui, &w.id, "allowSession");
    let ran = pending.join().unwrap();
    assert_eq!(ran["text"], "HI!", "{ran}");
    assert_eq!(ran["record"]["kind"], "extension");
    assert!(ran["record"]["extension"].as_str().unwrap().starts_with("sha256:"));
    // Allowed for the session: the next call doesn't ask.
    assert_eq!(w.spawn("c3", &json!({"text": "again"})).join().unwrap()["text"], "AGAIN!");

    // Changed, it's code no one has accepted.
    w.shout("?!");
    let pending = w.spawn("c4", &json!({"text": "hi"}));
    let asked = answer(&mut ui, &w.id, "deny");
    assert!(asked["sessionFile"].as_str().unwrap().starts_with("extension:shout:sha256:"), "{asked}");
    assert!(pending.join().unwrap()["outcome"]["reason"].as_str().unwrap().starts_with("declined"));
}

#[test]
fn only_a_declared_tool_with_an_object_of_arguments_is_called() {
    let w = Ws::new();
    w.shout("");
    let mut c = w.env.rpc();
    let r = w.call(&mut c, "c1", "whisper", &json!({}));
    assert!(r["error"]["message"].as_str().unwrap().contains("declares no tool \"whisper\""), "{r}");
    let r = w.call(&mut c, "c2", "loud", &json!(["hi"]));
    assert!(r["error"]["message"].as_str().unwrap().contains("as a JSON object"), "{r}");
    let r = c.call(
        "effect/run",
        &json!({"id": w.id, "callId": "c3", "request": {"kind": "extension", "name": "absent", "tool": "x", "arguments": {}}}),
    );
    assert!(r["error"]["message"].as_str().unwrap().contains("the extension absent can't run"), "{r}");
}

#[test]
fn a_host_is_told_each_extensions_tools_and_a_bad_one_is_noted_for_a_person() {
    let w = Ws::new();
    w.shout("");
    w.write(".strive/extensions/broken/extension.json", "{\"name\": \"broken\"}");
    let config = w.env.rpc().ok("host/register", &json!({"id": w.id}));
    let exts = config["extensions"].as_array().unwrap();
    assert_eq!(exts.len(), 1, "{config}");
    assert_eq!((exts[0]["name"].as_str(), exts[0]["tools"][0]["name"].as_str()), (Some("shout"), Some("loud")));
    let r = w.env.rpc().ok("session/read", &json!({"id": w.id}));
    let loaded =
        r["entries"].as_array().unwrap().iter().map(|e| &e["event"]).find(|e| e["type"] == "contextLoaded").unwrap();
    assert_eq!(loaded["extensions"], json!(["shout"]));
    let skipped = loaded["skipped"].as_array().unwrap();
    assert!(
        skipped.iter().any(|s| s.as_str().unwrap().starts_with(".strive/extensions/broken was not loaded")),
        "{skipped:?}"
    );
}

#[test]
fn extension_code_runs_in_the_sandbox_and_cant_read_strives_home() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine");
        return;
    }
    let w = Ws::new();
    w.write(
        ".strive/extensions/peek/extension.json",
        &json!({"name": "peek", "description": "Reads a file", "tools": [{"name": "read", "description": "A file's text", "parameters": {"type": "object"}}]}).to_string(),
    );
    w.write(
        ".strive/extensions/peek/index.ts",
        "export const tools = { read: async ({ path }: { path: string }) => await Bun.file(path).text() };\n",
    );
    w.write("mine.txt", "the workspace's own\n");
    w.env.rpc().ok("session/approvals", &json!({"id": w.id, "mode": "fullAuto"}));
    let mut ui = w.env.rpc();
    ui.ok("session/attach", &json!({"id": w.id}));
    let peek = |call: &str, path: String| {
        let (mut c, params) = (
            w.env.rpc(),
            json!({"id": w.id, "callId": call, "request": {"kind": "extension", "name": "peek", "tool": "read", "arguments": {"path": path}}}),
        );
        std::thread::spawn(move || c.ok("effect/run", &params))
    };
    let pending = peek("c1", w.root.join("mine.txt").display().to_string());
    answer(&mut ui, &w.id, "allowSession");
    assert_eq!(pending.join().unwrap()["text"], "the workspace's own\n");
    // A file in strive's home, as its keys and journals are.
    let secret = w.env.home.path().join("secret.txt");
    fs::write(&secret, "s3cret").unwrap();
    let denied = peek("c2", secret.display().to_string()).join().unwrap();
    assert_ne!(denied["outcome"]["exitCode"], 0, "{denied}");
    assert!(!denied["text"].as_str().unwrap().contains("s3cret"), "{denied}");
}

#[test]
fn an_agents_change_to_an_extension_asks_a_person_even_in_full_auto() {
    let w = Ws::new();
    w.env.rpc().ok("session/approvals", &json!({"id": w.id, "mode": "fullAuto"}));
    let r = w.env.rpc().ok(
        "effect/run",
        &json!({"id": w.id, "callId": "c", "request": {"kind": "write", "path": ".strive/extensions/x/index.ts", "content": "x"}}),
    );
    assert!(r["outcome"]["reason"].as_str().unwrap_or_default().contains("future session"), "{r}");
}
