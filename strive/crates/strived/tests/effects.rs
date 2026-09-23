//! Effects end to end: the daemon reads, writes, edits and runs commands for
//! the agent, inside the session's directory and the OS sandbox, and
//! journals each one.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use common::{Env, Rpc};
use serde_json::{Value, json};

struct Ws {
    env: Env,
    dir: tempfile::TempDir,
    id: String,
    c: Rpc,
}

impl Ws {
    fn new() -> Self {
        Self::with_vars(&[])
    }
    fn with_vars(vars: &[(&str, &str)]) -> Self {
        let env = Env::with_vars(vars);
        let dir = tempfile::Builder::new().prefix("strv-ws").tempdir_in("/tmp").unwrap();
        let mut c = env.rpc();
        let cwd = dir.path().canonicalize().unwrap();
        let id = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
        // These tests are about effects themselves; approvals have their own.
        c.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
        Self { env, dir, id, c }
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.dir.path().canonicalize().unwrap().join(rel)
    }
    fn run(&mut self, request: Value) -> Value {
        let mut params = json!({"id": self.id, "callId": "call_1"});
        params["request"] = request;
        self.c.ok("effect/run", &params)
    }
    fn text(&mut self, request: Value) -> String {
        self.run(request)["text"].as_str().unwrap().to_string()
    }
    fn kind(&mut self, request: Value) -> (String, String) {
        let r = self.run(request);
        (r["outcome"]["kind"].as_str().unwrap().to_string(), r["text"].as_str().unwrap().to_string())
    }
    fn events(&mut self) -> Vec<Value> {
        let r = self.c.ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
}

#[test]
fn read_returns_the_requested_lines() {
    let mut w = Ws::new();
    fs::write(w.path("a.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    assert_eq!(w.text(json!({"kind": "read", "path": "a.txt"})), "one\ntwo\nthree\nfour\n");
    assert_eq!(
        w.text(json!({"kind": "read", "path": "a.txt", "offset": 2, "limit": 2})),
        "two\nthree\n[... more lines; read with offset 4 to continue]\n",
        "a read cut short says where to continue"
    );
    let abs = w.path("a.txt");
    assert_eq!(w.text(json!({"kind": "read", "path": abs, "offset": 4})), "four\n");
}

#[test]
fn read_explains_missing_and_binary_files() {
    let mut w = Ws::new();
    assert_eq!(
        w.kind(json!({"kind": "read", "path": "nope.txt"})),
        ("refused".into(), "no such file: nope.txt".into())
    );
    fs::write(w.path("blob.bin"), [0u8, 159, 146, 150, 0, 1]).unwrap();
    assert_eq!(w.text(json!({"kind": "read", "path": "blob.bin"})), "blob.bin is a binary file (6 bytes)");
}

#[test]
fn write_creates_files_and_directories_in_the_workspace() {
    let mut w = Ws::new();
    assert_eq!(
        w.text(json!({"kind": "write", "path": "src/lib/new.rs", "content": "fn main() {}\n"})),
        "wrote src/lib/new.rs (13 bytes)"
    );
    assert_eq!(fs::read_to_string(w.path("src/lib/new.rs")).unwrap(), "fn main() {}\n");
}

#[test]
fn edit_replaces_exactly_one_occurrence() {
    let mut w = Ws::new();
    fs::write(w.path("f.txt"), "alpha beta gamma beta\n").unwrap();
    assert_eq!(
        w.kind(json!({"kind": "edit", "path": "f.txt", "oldText": "beta", "newText": "B"})),
        (
            "refused".into(),
            "\"beta\" appears 2 times in f.txt; include more surrounding text so it matches once".into()
        )
    );
    assert_eq!(
        w.kind(json!({"kind": "edit", "path": "f.txt", "oldText": "delta", "newText": "D"})),
        ("refused".into(), "\"delta\" does not appear in f.txt".into())
    );
    assert_eq!(
        fs::read_to_string(w.path("f.txt")).unwrap(),
        "alpha beta gamma beta\n",
        "a refused edit changes nothing"
    );
    assert_eq!(
        w.text(json!({"kind": "edit", "path": "f.txt", "oldText": "gamma beta", "newText": "G"})),
        "edited f.txt"
    );
    assert_eq!(fs::read_to_string(w.path("f.txt")).unwrap(), "alpha beta G\n");
}

#[test]
fn writes_outside_the_workspace_are_refused() {
    let mut w = Ws::new();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("x.txt");
    let (kind, text) = w.kind(json!({"kind": "write", "path": target, "content": "no"}));
    assert_eq!(kind, "refused");
    assert!(text.starts_with("write outside the workspace: "), "{text}");
    assert!(
        text.ends_with(
            "needs approval, but no client is attached to give it; use full-auto approvals for unattended runs"
        ),
        "{text}"
    );
    assert!(!target.exists());
    let (kind, _) = w.kind(json!({"kind": "write", "path": "../escape.txt", "content": "no"}));
    assert_eq!(kind, "refused");
    assert!(!w.dir.path().parent().unwrap().join("escape.txt").exists());
}

#[test]
fn a_symlink_cannot_carry_a_write_out_of_the_workspace() {
    let mut w = Ws::new();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), w.path("link")).unwrap();
    let (kind, _) = w.kind(json!({"kind": "write", "path": "link/x.txt", "content": "no"}));
    assert_eq!(kind, "refused");
    assert!(!outside.path().join("x.txt").exists());
}

#[test]
fn strives_own_state_is_off_limits_even_through_a_symlink() {
    let mut w = Ws::new();
    let key = w.env.home.path().join("keys/journal.key");
    let (kind, text) = w.kind(json!({"kind": "read", "path": key}));
    assert_eq!((kind.as_str(), text.as_str()), ("refused", "the agent can't read strive's own state"));
    std::os::unix::fs::symlink(&key, w.path("innocent.txt")).unwrap();
    assert_eq!(w.kind(json!({"kind": "read", "path": "innocent.txt"})).0, "refused");
}

#[test]
fn bash_runs_in_the_workspace_and_reports_its_exit_status() {
    let mut w = Ws::new();
    let r = w.run(json!({"kind": "bash", "command": "pwd; echo out; echo err >&2; exit 3"}));
    assert_eq!(r["outcome"]["exitCode"], 3);
    assert_eq!(r["text"], format!("{}\nout\nerr\n", w.path("").to_str().unwrap().trim_end_matches('/')));
}

/// `set -m` puts a background job in its own process group, out of reach of
/// a group kill; it (and the output pipe it holds) must not outlive the timeout.
#[test]
fn a_child_in_its_own_process_group_is_killed_at_the_timeout_too() {
    let mut w = Ws::new();
    let marker = w.path("late.txt");
    let started = std::time::Instant::now();
    let r = w.run(json!({"kind": "bash", "command": "set -m; (sleep 1; touch late.txt) & wait", "timeoutMs": 300}));
    assert!(started.elapsed() < Duration::from_secs(4), "returned after {:?}", started.elapsed());
    assert_eq!(r["text"], "the command timed out after 0.3s and was stopped");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!marker.exists(), "the job in its own process group was killed too");
}

/// Cancelling a running command stops it (and its children) at once.
#[test]
fn a_cancelled_command_is_stopped() {
    let w = Ws::new();
    let marker = w.path("late.txt");
    let mut c = w.env.rpc();
    let params = json!({"id": w.id, "callId": "call_7", "request": {"kind": "bash", "command": "(sleep 1; touch late.txt) & sleep 30"}});
    let running = std::thread::spawn(move || c.ok("effect/run", &params));
    common::wait_for("the command to start", Duration::from_secs(5), || {
        let r = w.env.rpc().ok("session/read", &json!({"id": w.id}));
        r["entries"].as_array().unwrap().iter().any(|e| e["event"]["type"] == "effectStarted")
    });
    std::thread::sleep(Duration::from_millis(200));
    let started = std::time::Instant::now();
    w.env.rpc().ok("effect/cancel", &json!({"id": w.id, "callId": "call_7"}));
    let r = running.join().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2), "stopped after {:?}", started.elapsed());
    assert_eq!(r["text"], "the command was interrupted and stopped");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!marker.exists(), "its background child was killed too");
}

#[test]
fn bash_is_killed_at_its_timeout_with_its_children() {
    let mut w = Ws::new();
    let marker = w.path("late.txt");
    let started = std::time::Instant::now();
    let r = w.run(json!({"kind": "bash", "command": "(sleep 1; touch late.txt) & sleep 30", "timeoutMs": 300}));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(r["outcome"].get("exitCode"), None);
    assert_eq!(r["text"], "the command timed out after 0.3s and was stopped");
    std::thread::sleep(Duration::from_millis(1500));
    assert!(!marker.exists(), "the command's background child was killed too");
}

#[test]
fn bash_output_is_capped_keeping_the_start_and_the_end() {
    let mut w = Ws::new();
    let r = w.run(
        json!({"kind": "bash", "command": "echo FIRST; head -c 3000000 /dev/zero | tr '\\\\0' x; echo; echo LAST"}),
    );
    let text = r["text"].as_str().unwrap();
    assert_eq!(r["outcome"]["truncated"], true);
    assert!(text.starts_with("FIRST\n"), "{}", &text[..40]);
    assert!(text.ends_with("LAST\n"));
    assert!(text.contains("[... output cut:"));
    assert!(text.len() < 300_000);
}

#[test]
fn bash_does_not_see_provider_keys() {
    let mut w = Ws::with_vars(&[("ANTHROPIC_API_KEY", "sk-must-not-leak"), ("OPENAI_API_KEY", "sk-nor-this")]);
    let text = w.text(json!({"kind": "bash", "command": "echo \"[$ANTHROPIC_API_KEY][$OPENAI_API_KEY]\""}));
    assert_eq!(text, "[][]\n");
}

#[test]
fn every_effect_is_journaled_with_its_payloads_in_the_content_store() {
    let mut w = Ws::new();
    w.run(json!({"kind": "write", "path": "a.txt", "content": "hello"}));
    let e = w.events();
    let n = e.len();
    assert_eq!(e[n - 2]["type"], "effectStarted");
    assert_eq!(e[n - 2]["effect"], 1);
    assert_eq!(e[n - 2]["callId"], "call_1");
    assert_eq!(
        e[n - 2]["record"],
        json!({"kind": "write", "path": "a.txt", "bytes": 5,
               "content": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"})
    );
    assert_eq!(e[n - 1]["type"], "effectFinished");
    assert_eq!(e[n - 1]["outcome"]["kind"], "done");
    let out = w.c.ok("blob/get", &json!({"digest": e[n - 1]["outcome"]["output"]}));
    assert_eq!(out["text"], "wrote a.txt (5 bytes)");
}

/// The sandbox is checked only where it exists; without one, commands must
/// not run at all (see the next test).
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
fn the_sandbox_blocks_writes_outside_the_workspace_and_reading_strive_state() {
    if !sandboxed() {
        eprintln!("no usable sandbox on this machine; covered by the refusal test");
        return;
    }
    let mut w = Ws::new();
    let outside = tempfile::Builder::new().prefix("strv-out").tempdir_in(std::env::var("HOME").unwrap()).unwrap();
    let target = outside.path().join("escaped.txt");
    let cmd = format!("echo no > '{}'; echo status=$?", target.display());
    let text = w.text(json!({"kind": "bash", "command": cmd}));
    assert!(text.ends_with("status=1\n"), "{text}");
    assert!(!target.exists());

    let key = w.env.home.path().join("keys/journal.key");
    let text =
        w.text(json!({"kind": "bash", "command": format!("cat '{}' >/dev/null; echo status=$?", key.display())}));
    assert!(text.ends_with("status=1\n"), "{text}");

    let text = w.text(json!({"kind": "bash", "command": "echo inside > in.txt && cat in.txt"}));
    assert_eq!(text, "inside\n");
}

#[test]
fn the_sandbox_blocks_the_network() {
    if !sandboxed() {
        return;
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut w = Ws::new();
    let cmd = format!("(exec 3<>/dev/tcp/127.0.0.1/{port}) 2>/dev/null; echo status=$?");
    assert_eq!(w.text(json!({"kind": "bash", "command": cmd})), "status=1\n");
}

#[test]
fn an_effect_in_a_session_whose_directory_is_gone_says_so() {
    let env = Env::new();
    let gone = tempfile::tempdir().unwrap();
    let cwd = gone.path().canonicalize().unwrap();
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    drop(gone);
    let r = c.call("effect/run", &json!({"id": id, "callId": "c", "request": {"kind": "read", "path": "a"}}));
    assert_eq!(
        r["error"]["message"],
        format!("the session's directory {} is missing: No such file or directory (os error 2)", cwd.display())
    );
    let entries = c.ok("session/read", &json!({"id": id}))["entries"].clone();
    assert!(
        !entries.as_array().unwrap().iter().any(|e| e["event"]["type"] == "effectStarted"),
        "nothing is journaled for an effect that couldn't begin"
    );
}

/// Effect numbers pair starts with finishes, so they never repeat in a
/// session, within one daemon run or across restarts.
#[test]
fn effect_numbers_continue_across_effects_and_restarts() {
    let mut w = Ws::new();
    assert_eq!(w.run(json!({"kind": "write", "path": "a", "content": "1"}))["effect"], 1);
    assert_eq!(w.run(json!({"kind": "write", "path": "b", "content": "2"}))["effect"], 2);
    w.env.stop();
    w.c = w.env.rpc();
    assert_eq!(w.run(json!({"kind": "write", "path": "c", "content": "3"}))["effect"], 3);
    let numbers: Vec<u64> =
        w.events().iter().filter(|e| e["type"] == "effectStarted").map(|e| e["effect"].as_u64().unwrap()).collect();
    assert_eq!(numbers, vec![1, 2, 3]);
}
