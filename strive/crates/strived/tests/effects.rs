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
    // The child waits for a go-file, not a timer: however long the test takes
    // to cancel, only a child that survived the cancel can make the marker.
    let params = json!({"id": w.id, "callId": "call_7", "request": {"kind": "bash",
        "command": "(while [ ! -e go ]; do sleep 0.05; done; touch late.txt) & sleep 30"}});
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
    fs::write(w.path("go"), "").unwrap();
    std::thread::sleep(Duration::from_millis(600));
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

/// Unix sockets outside the workspace (a Docker daemon, the user's D-Bus)
/// can start processes outside the sandbox, so commands can't reach them.
#[test]
fn the_sandbox_blocks_unix_sockets_outside_it() {
    if !sandboxed() {
        return;
    }
    let mut w = Ws::new();
    // Not under /tmp or /run, which the Linux sandbox replaces: like a socket
    // in the user's home (Docker Desktop's is ~/.docker/run/docker.sock).
    let outside = tempfile::Builder::new().prefix("sock").tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let path = outside.path().join("service.sock");
    let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    let deps = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
    let probe = deps.parent().unwrap().join("examples/sock_probe");
    assert!(probe.is_file(), "{} is missing: `cargo test` builds it, or `cargo build --examples`", probe.display());
    let text = w.text(json!({"kind": "bash", "command": format!("{} {}", probe.display(), path.display())}));
    assert!(text.starts_with("refused"), "{text}");
    // A datagram socket from socketpair can still address a socket by path.
    let dgram_path = outside.path().join("datagrams.sock");
    let service = std::os::unix::net::UnixDatagram::bind(&dgram_path).unwrap();
    service.set_nonblocking(true).unwrap();
    let text =
        w.text(json!({"kind": "bash", "command": format!("{} --dgram {}", probe.display(), dgram_path.display())}));
    assert!(text.starts_with("refused"), "{text}");
    assert!(service.recv(&mut [0; 16]).is_err(), "nothing arrived");
}

/// A sandboxed command has only its standard descriptors: nothing strive
/// hands the sandbox (its seccomp program) or other commands leaks in.
#[test]
fn a_sandboxed_command_sees_only_its_standard_descriptors() {
    if !sandboxed() || !cfg!(target_os = "linux") {
        return;
    }
    let mut w = Ws::new();
    // ls's own descriptor for the directory it lists is the fourth.
    let text = w.text(json!({"kind": "bash", "command": "ls /proc/self/fd"}));
    assert_eq!(text.split_whitespace().count(), 4, "{text}");
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

/// Parallel tool calls may write the same file; each write must replace it
/// whole with its own content, and leave no temporary files behind.
#[test]
fn parallel_writes_to_one_file_each_land_whole() {
    let w = Ws::new();
    let writers: Vec<_> = (0..16)
        .map(|i| {
            let mut c = w.env.rpc();
            let params = json!({"id": w.id, "callId": format!("call_{i}"),
                "request": {"kind": "write", "path": "same.txt", "content": "x".repeat(1000 + i)}});
            std::thread::spawn(move || c.ok("effect/run", &params))
        })
        .collect();
    for (i, t) in writers.into_iter().enumerate() {
        let r = t.join().unwrap();
        assert_eq!(r["text"], format!("wrote same.txt ({} bytes)", 1000 + i), "{r}");
    }
    let len = fs::read(w.path("same.txt")).unwrap().len();
    assert!((1000..1016).contains(&len), "the file is one write's content, whole: {len} bytes");
    let names: Vec<String> =
        fs::read_dir(w.dir.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec!["same.txt"]);
}

/// A model may return several edits to one file in a single step; the host
/// runs them in parallel. Each must apply to what the others left, so none
/// is lost.
#[test]
fn parallel_edits_to_one_file_all_land() {
    let w = Ws::new();
    let lines: Vec<String> = (0..24).map(|i| format!("line {i} old")).collect();
    fs::write(w.path("many.txt"), lines.join("\n")).unwrap();
    let editors: Vec<_> = (0..24)
        .map(|i| {
            let mut c = w.env.rpc();
            let params = json!({"id": w.id, "callId": format!("call_{i}"), "request": {
                "kind": "edit", "path": "many.txt",
                "oldText": format!("line {i} old"), "newText": format!("line {i} new")}});
            std::thread::spawn(move || c.ok("effect/run", &params))
        })
        .collect();
    for t in editors {
        let r = t.join().unwrap();
        assert_eq!(r["outcome"]["kind"], "done", "{r}");
    }
    let text = fs::read_to_string(w.path("many.txt")).unwrap();
    let lost: Vec<&str> = text.lines().filter(|l| l.ends_with(" old")).collect();
    assert!(lost.is_empty(), "every edit landed; still old: {lost:?}");
}

/// Reading a device or a FIFO would never end (or never start); only
/// regular files are read.
#[test]
fn only_regular_files_are_read() {
    let mut w = Ws::new();
    assert!(std::process::Command::new("mkfifo").arg(w.path("pipe")).status().unwrap().success());
    let started = std::time::Instant::now();
    assert_eq!(
        w.kind(json!({"kind": "read", "path": "pipe"})),
        ("refused".into(), "pipe is not a regular file".into())
    );
    assert_eq!(
        w.kind(json!({"kind": "read", "path": "/dev/zero"})),
        ("refused".into(), "/dev/zero is not a regular file".into())
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

/// A cancel that arrives before its effect runs (the agent gave up while
/// the effect waited its turn) stops it from running at all.
#[test]
fn an_effect_cancelled_before_it_runs_does_nothing() {
    let w = Ws::new();
    let mut c = w.env.rpc();
    for (call, request) in [
        ("call_w", json!({"kind": "write", "path": "made.txt", "content": "x"})),
        ("call_b", json!({"kind": "bash", "command": "touch ran.txt"})),
    ] {
        c.ok("effect/cancel", &json!({"id": w.id, "callId": call}));
        let r = c.ok("effect/run", &json!({"id": w.id, "callId": call, "request": request}));
        assert_eq!(r["outcome"]["kind"], "refused", "{r}");
        assert!(r["outcome"]["reason"].as_str().unwrap().starts_with("interrupted"), "{r}");
    }
    assert!(!w.path("made.txt").exists());
    assert!(!w.path("ran.txt").exists());
}

/// Stopping the daemon stops the commands it is running: a successor that
/// takes over the sessions (and may rewind them) never races one.
#[test]
fn stopping_the_daemon_stops_its_running_commands() {
    let w = Ws::new();
    let mut c = w.env.rpc();
    let params = json!({"id": w.id, "callId": "call_1", "request": {"kind": "bash", "command": "sleep 2; echo late > late.txt"}});
    let running = std::thread::spawn(move || c.call("effect/run", &params));
    common::wait_for("the command to start", Duration::from_secs(5), || {
        let r = w.env.rpc().ok("session/read", &json!({"id": w.id}));
        r["entries"].as_array().unwrap().iter().any(|e| e["event"]["type"] == "effectStarted")
    });
    std::thread::sleep(Duration::from_millis(200));
    w.env.stop();
    let _ = running.join();
    std::thread::sleep(Duration::from_millis(2500));
    assert!(!w.path("late.txt").exists(), "the command was stopped with the daemon");
    // Journaled as stopped by this daemon, not closed after the fact as a
    // command whose end nobody saw.
    let mut reader = w.env.rpc();
    let r = reader.ok("session/read", &json!({"id": w.id}));
    let finished = r["entries"].as_array().unwrap().iter().find(|e| e["event"]["type"] == "effectFinished").cloned();
    let outcome = finished.expect("the effect's end is journaled")["event"]["outcome"].clone();
    assert_eq!(outcome["kind"], "done", "{outcome}");
    let text = reader.ok("blob/get", &json!({"digest": outcome["output"]}));
    assert_eq!(text["text"], "the command was interrupted and stopped");
}

/// Inside a disposable container (a benchmark's task, say) the container is
/// the sandbox: with `"sandbox": "off"` commands run unconfined, gated by
/// the approval mode as sandboxed ones are.
#[test]
fn with_the_sandbox_off_commands_run_unconfined_under_the_approval_mode() {
    let env = Env::new();
    std::fs::write(env.home.path().join("settings.json"), r#"{"sandbox": "off"}"#).unwrap();
    let dir = tempfile::Builder::new().prefix("strv-ws").tempdir_in("/tmp").unwrap();
    let outside = tempfile::Builder::new().prefix("strv-out").tempdir_in("/tmp").unwrap();
    let mut c = env.rpc();
    let id =
        c.ok("session/create", &json!({"cwd": dir.path().canonicalize().unwrap()}))["id"].as_str().unwrap().to_string();
    c.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
    let target = outside.path().join("made.txt");
    let command = format!("echo unconfined > {}", target.display());
    let r = c.ok("effect/run", &json!({"id": id, "callId": "c", "request": {"kind": "bash", "command": command}}));
    assert_eq!(r["outcome"]["kind"], "done", "{r}");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "unconfined\n");
    // In ask mode it asks as for any command, not as for one without a sandbox.
    c.ok("session/approvals", &json!({"id": id, "mode": "ask"}));
    let r = c.ok("effect/run", &json!({"id": id, "callId": "d", "request": {"kind": "bash", "command": "true"}}));
    assert_eq!(
        r["outcome"]["reason"],
        "run: true needs approval, but no client is attached to give it; use full-auto approvals for unattended runs"
    );
}

/// The macOS sandbox profile names the workspace in a string literal; a
/// path with a quote in it could end the literal and add rules. Such a
/// workspace's commands are refused, never run with a broken sandbox.
#[cfg(target_os = "macos")]
#[test]
fn a_workspace_path_the_sandbox_profile_cant_hold_is_refused() {
    let env = Env::new();
    let parent = tempfile::Builder::new().prefix("strv-ws").tempdir_in("/tmp").unwrap();
    let dir = parent.path().canonicalize().unwrap().join(r#"a") (allow file-write* (subpath "/"#);
    fs::create_dir_all(&dir).unwrap();
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": dir}))["id"].as_str().unwrap().to_string();
    c.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
    let marker = parent.path().join("escaped.txt");
    let r = c.ok(
        "effect/run",
        &json!({"id": id, "callId": "c", "request": {"kind": "bash",
        "command": format!("touch {}", marker.display())}}),
    );
    assert_eq!(r["outcome"]["kind"], "refused", "{r}");
    assert!(r["text"].as_str().unwrap().contains("sandbox profile can't hold"), "{r}");
    assert!(!marker.exists());
}

/// A session's directory swapped for a symlink (easy under /tmp, where
/// anyone can replace an entry) must not carry the agent's writes, or the
/// sandbox's writable area, to wherever the link points.
#[test]
fn a_session_directory_swapped_for_a_symlink_is_not_followed() {
    let mut w = Ws::new();
    let elsewhere = tempfile::Builder::new().prefix("strv-elsewhere").tempdir_in("/tmp").unwrap();
    let ws = w.dir.path().canonicalize().unwrap();
    fs::remove_dir(&ws).unwrap();
    std::os::unix::fs::symlink(elsewhere.path(), &ws).unwrap();
    let r = w.c.call(
        "effect/run",
        &json!({"id": w.id, "callId": "c", "request": {"kind": "write", "path": "x.txt", "content": "hi"}}),
    );
    assert!(r["error"]["message"].as_str().unwrap_or_default().contains("now leads to"), "{r}");
    assert!(!elsewhere.path().join("x.txt").exists(), "nothing was written through the link");
}
