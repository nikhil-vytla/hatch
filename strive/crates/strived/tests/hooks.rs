//! Hooks (ADR-0028): an accepted extension's code before each tool call,
//! which may ask a person about it or refuse it, and never allow it.
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

/// Refuses `git push`, asks before a change under `migrations/` and before
/// a write too large to see whole; sees commands and writes only.
const GUARD: &str = r#"export const hooks = {
  tool_call: async (call: any) => {
    if (call.kind === "bash" && call.command.includes("git push")) return { decision: "deny", reason: "pushing leaves this machine" };
    if (call.kind === "write" && call.path.startsWith("migrations/")) return { decision: "ask", reason: "migrations are shared" };
    if (call.truncated) return { decision: "ask", reason: "it can't see the whole call" };
  },
};
"#;

impl Ws {
    fn new() -> Self {
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-hook").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        env.rpc().ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
        Self { env, _dir: dir, root, id }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    /// The extension `guard`, with `code` as its index.ts, in `at`.
    fn guard(&self, at: &str, code: &str) {
        let manifest = json!({"name": "guard", "description": "Guards the project", "hooks": [{"event": "tool_call", "tools": ["bash", "write"]}]});
        self.write(&format!("{at}/guard/extension.json"), &manifest.to_string());
        self.write(&format!("{at}/guard/index.ts"), code);
    }
    /// `guard`, with `code`, proposed by this session and accepted by a person.
    fn accepted(&self, code: &str) -> u64 {
        self.guard(".strive/drafts/extensions", code);
        self.env.rpc().ok("session/prompt", &json!({"id": self.id, "text": "guard pushes and migrations"}));
        let mut host = self.env.rpc();
        host.ok("host/register", &json!({"id": self.id}));
        let r = host.ok(
            "host/proposeExtension",
            &json!({"id": self.id, "name": "guard", "summary": "Add guard", "rationale": "asked for", "prediction": "no pushes"}),
        );
        let id = r["proposal"].as_u64().unwrap_or_else(|| panic!("{r}"));
        let decided =
            self.env.rpc().call("proposal/decide", &json!({"cwd": self.root, "proposal": id, "decision": "accept"}));
        assert!(decided.get("error").is_none(), "{decided}");
        id
    }
    fn run(&self, call: &str, request: &Value) -> Value {
        self.env.rpc().ok("effect/run", &json!({"id": self.id, "callId": call, "request": request}))
    }
    fn bash(&self, call: &str, command: &str) -> Value {
        self.run(call, &json!({"kind": "bash", "command": command}))
    }
}

fn reason(r: &Value) -> &str {
    r["outcome"]["reason"].as_str().unwrap_or_default()
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
fn an_accepted_hook_refuses_or_asks_about_what_full_auto_would_let_run() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine: hooks and commands ask");
        return;
    }
    let w = Ws::new();
    let id = w.accepted(GUARD);
    let review = w.env.strive_in(&w.root, &["review", &id.to_string()]);
    let shown = String::from_utf8_lossy(&review.stdout);
    assert!(
        shown.contains("hook: runs before each bash or write call, and may ask a person about it or refuse it"),
        "{shown}"
    );
    assert_eq!(w.bash("c1", "echo fine")["text"], "fine\n");
    let pushed = w.bash("c2", "echo git push");
    assert_eq!(reason(&pushed), "guard's hook refused this: pushing leaves this machine", "{pushed}");

    let migration = w.run("c3", &json!({"kind": "write", "path": "migrations/1.sql", "content": "x"}));
    let why = reason(&migration);
    assert!(why.contains("write migrations/1.sql (guard's hook asks: migrations are shared)"), "{migration}");
    assert!(why.contains("needs a person's approval even in full-auto"), "full-auto wouldn't let it run: {why}");
    assert!(!w.root.join("migrations/1.sql").exists());
    assert!(w.run("c4", &json!({"kind": "write", "path": "notes.txt", "content": "x"}))["outcome"]["reason"].is_null());

    // Too large to show whole, a write is shown without its text, and says so.
    let big = w.run("c5", &json!({"kind": "write", "path": "big.txt", "content": "x".repeat(40_000)}));
    assert!(reason(&big).contains("guard's hook asks: it can't see the whole call"), "{big}");
    // It sees commands and writes, not reads.
    assert!(w.run("c6", &json!({"kind": "read", "path": "notes.txt"}))["text"].as_str().unwrap().contains('x'));
}

#[test]
fn a_hook_no_one_accepted_doesnt_run() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine");
        return;
    }
    let w = Ws::new();
    w.guard(".strive/extensions", GUARD);
    assert_eq!(w.bash("c1", "echo git push")["text"], "git push\n");
}

#[test]
fn a_hook_that_answers_allow_fails_and_asks_every_time() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine");
        return;
    }
    let w = Ws::new();
    let _ = w.accepted("export const hooks = { tool_call: async () => ({ decision: \"allow\" }) };\n");
    // An agent that could make a guard fail can't make it stop guarding.
    for call in ["c1", "c2", "c3", "c4"] {
        let r = w.bash(call, "echo once");
        assert!(reason(&r).contains("guard's hook failed: it answered {\"decision\":\"allow\"}"), "{r}");
        assert!(reason(&r).contains("rolling guard back stops it"), "{r}");
    }
}

#[test]
fn a_hook_that_throws_is_a_failure() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine");
        return;
    }
    let w = Ws::new();
    let _ = w.accepted("export const hooks = { tool_call: async () => { throw new Error(\"boom\"); } };\n");
    let r = w.bash("c1", "echo hi");
    assert!(reason(&r).contains("guard's hook failed: it exited 1"), "{r}");
}

#[test]
fn a_session_in_safe_mode_runs_no_hooks() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine");
        return;
    }
    let w = Ws::new();
    let _ = w.accepted(GUARD);
    let safe =
        w.env.rpc().ok("session/create", &json!({"cwd": w.root, "safe": true}))["id"].as_str().unwrap().to_string();
    w.env.rpc().ok("session/approvals", &json!({"id": safe, "mode": "fullAuto"}));
    let r = w.env.rpc().ok(
        "effect/run",
        &json!({"id": safe, "callId": "c1", "request": {"kind": "bash", "command": "echo git push"}}),
    );
    assert_eq!(r["text"], "git push\n", "{r}");
}

#[test]
fn each_hooks_answer_is_journaled_and_only_a_call_allowed_to_run_is_cleared() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine");
        return;
    }
    let w = Ws::new();
    let _ = w.accepted(GUARD);
    let fine = w.bash("c1", "echo fine")["effect"].as_u64().unwrap();
    let pushed = w.bash("c2", "echo git push")["effect"].as_u64().unwrap();
    let r = w.env.rpc().ok("session/read", &json!({"id": w.id}));
    let events: Vec<Value> = r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect();
    let of = |kind: &str, effect: u64| {
        events.iter().filter(|e| e["type"] == kind && e["effect"] == effect).cloned().collect::<Vec<_>>()
    };

    let said = of("hookDecided", fine);
    assert_eq!(
        (said.len(), &said[0]["extension"], &said[0]["answer"]),
        (1, &json!("guard"), &json!("nothing")),
        "{said:?}"
    );
    assert!(said[0]["digest"].as_str().unwrap().starts_with("sha256:"));
    assert_eq!(of("effectCleared", fine).len(), 1);
    // Journaled before it ran, so a crash in between shows it was running.
    let at = |kind: &str| events.iter().position(|e| e["type"] == kind && e["effect"] == fine).unwrap();
    assert!(at("hookDecided") < at("effectCleared") && at("effectCleared") < at("effectFinished"));

    let refused = of("hookDecided", pushed);
    assert_eq!((&refused[0]["answer"], &refused[0]["reason"]), (&json!("deny"), &json!("pushing leaves this machine")));
    assert_eq!(of("effectCleared", pushed), Vec::<Value>::new(), "a refused call never ran");
}
