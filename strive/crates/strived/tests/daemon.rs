//! End-to-end tests against the real `strive` binary, each with its own
//! `STRIVE_HOME`, so they never touch a developer's daemon.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

struct Env {
    home: tempfile::TempDir,
    exe: PathBuf,
}

impl Env {
    fn new() -> Self {
        Self::with_exe(PathBuf::from(env!("CARGO_BIN_EXE_strive")))
    }
    fn with_exe(exe: PathBuf) -> Self {
        // Short base path: Unix socket paths are limited to ~104 bytes on macOS.
        let home = tempfile::Builder::new()
            .prefix("strv")
            .tempdir_in("/tmp")
            .unwrap();
        Self { home, exe }
    }
    fn cmd(&self, exe: &Path, args: &[&str]) -> Output {
        Command::new(exe)
            .args(args)
            .env("STRIVE_HOME", self.home.path())
            .env_remove("STRIVE_IDLE_SECS")
            .output()
            .unwrap()
    }
    fn strive(&self, args: &[&str]) -> Output {
        self.cmd(&self.exe, args)
    }
    fn status(&self) -> Value {
        let out = self.strive(&["status", "--json"]);
        assert!(
            out.status.success(),
            "status failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        serde_json::from_slice(&out.stdout).unwrap()
    }
    fn socket(&self) -> PathBuf {
        self.home.path().join("run/strived.sock")
    }
    fn rpc(&self) -> Rpc {
        let s = UnixStream::connect(self.socket()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        Rpc {
            r: BufReader::new(s.try_clone().unwrap()),
            w: s,
        }
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = self.strive(&["stop"]);
    }
}

struct Rpc {
    r: BufReader<UnixStream>,
    w: UnixStream,
}

impl Rpc {
    fn send_raw(&mut self, line: &str) -> Value {
        self.w.write_all(line.as_bytes()).unwrap();
        self.w.write_all(b"\n").unwrap();
        let mut buf = String::new();
        self.r.read_line(&mut buf).unwrap();
        serde_json::from_str(&buf).unwrap()
    }
    fn call(&mut self, id: i64, method: &str, params: &Value) -> Value {
        self.send_raw(
            &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
        )
    }
    fn init(&mut self) -> Value {
        self.call(0, "initialize", &json!({"protocolVersion": strive_proto::PROTOCOL_VERSION, "client": {"name": "test", "version": "0"}}))
    }
}

fn pid(status: &Value) -> u64 {
    status["server"]["pid"].as_u64().unwrap()
}

fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn starts_once_and_reuses_the_daemon() {
    let env = Env::new();
    let a = env.status();
    let b = env.status();
    assert_eq!(pid(&a), pid(&b));
    assert_eq!(a["server"]["version"], env!("CARGO_PKG_VERSION"));
    let mode = std::fs::metadata(env.socket())
        .map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()))
        .unwrap();
    assert_eq!(mode & 0o777, 0o600, "socket must be private to the user");
}

#[test]
fn concurrent_starts_yield_one_daemon() {
    let env = Env::new();
    let children: Vec<_> = (0..8)
        .map(|_| {
            Command::new(&env.exe)
                .args(["status", "--json"])
                .env("STRIVE_HOME", env.home.path())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        })
        .collect();
    let pids: std::collections::BTreeSet<u64> = children
        .into_iter()
        .map(|c| {
            let out = c.wait_with_output().unwrap();
            assert!(out.status.success());
            pid(&serde_json::from_slice(&out.stdout).unwrap())
        })
        .collect();
    assert_eq!(
        pids.len(),
        1,
        "racing starts produced several daemons: {pids:?}"
    );
}

#[test]
fn stop_stops_it() {
    let env = Env::new();
    env.status();
    let out = env.strive(&["stop"]);
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("stopped daemon"));
    assert!(!env.socket().exists());
    let out = env.strive(&["stop"]);
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "no daemon running"
    );
}

#[test]
fn exits_when_idle() {
    let env = Env::new();
    let out = Command::new(&env.exe)
        .args(["status", "--json"])
        .env("STRIVE_HOME", env.home.path())
        .env("STRIVE_IDLE_SECS", "1")
        .output()
        .unwrap();
    assert!(out.status.success());
    wait_for("idle exit", Duration::from_secs(5), || {
        !env.socket().exists()
    });
}

#[test]
fn replaces_a_stale_daemon_from_another_build() {
    let env = Env::new();
    let old = env.home.path().join("old-strive");
    std::fs::copy(&env.exe, &old).unwrap();
    let out = env.cmd(&old, &["status", "--json"]);
    let old_status: Value = serde_json::from_slice(&out.stdout).unwrap();
    let new_status = env.status();
    assert_ne!(old_status["server"]["build"], new_status["server"]["build"]);
    assert_ne!(
        pid(&old_status),
        pid(&new_status),
        "the stale daemon should have been replaced"
    );
}

/// Race: a daemon that is exiting has unlinked its socket but still holds the
/// lock. A successor started in that window must wait for the lock, not stand
/// down and leave the launcher with no daemon.
#[test]
fn stop_then_start_hands_off_cleanly() {
    let env = Env::new();
    for _ in 0..10 {
        let before = pid(&env.status());
        assert!(env.strive(&["stop"]).status.success());
        let after = pid(&env.status());
        assert_ne!(before, after);
    }
}

/// Race: several launchers of a newer build find the same stale daemon at
/// once. Each asks it to exit and races to start a replacement; all must end
/// up on one current daemon.
#[test]
fn concurrent_launchers_replace_a_stale_daemon_once() {
    let env = Env::new();
    let old = env.home.path().join("old-strive");
    for _ in 0..5 {
        std::fs::copy(&env.exe, &old).unwrap();
        let stale = env.cmd(&old, &["status", "--json"]);
        assert!(stale.status.success());
        let children: Vec<_> = (0..6)
            .map(|_| {
                Command::new(&env.exe)
                    .args(["status", "--json"])
                    .env("STRIVE_HOME", env.home.path())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .unwrap()
            })
            .collect();
        let pids: std::collections::BTreeSet<u64> = children
            .into_iter()
            .map(|c| {
                let out = c.wait_with_output().unwrap();
                assert!(
                    out.status.success(),
                    "launcher failed: {}",
                    String::from_utf8_lossy(&out.stderr)
                );
                pid(&serde_json::from_slice(&out.stdout).unwrap())
            })
            .collect();
        assert_eq!(pids.len(), 1, "expected one replacement daemon: {pids:?}");
        std::fs::remove_file(&old).unwrap();
    }
}

/// Race: the daemon decides to exit for idleness while a launcher is
/// connecting. The launcher must recover by starting a new daemon.
#[test]
fn launches_succeed_across_idle_exits() {
    let env = Env::new();
    let start = Instant::now();
    let mut pids = std::collections::BTreeSet::new();
    while start.elapsed() < Duration::from_secs(4) {
        let out = Command::new(&env.exe)
            .args(["status", "--json"])
            .env("STRIVE_HOME", env.home.path())
            .env("STRIVE_IDLE_SECS", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "launch failed near an idle exit: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        pids.insert(pid(&serde_json::from_slice(&out.stdout).unwrap()));
        std::thread::sleep(Duration::from_millis(97));
    }
    // With launches ~100 ms apart the daemon never idles for 1 s, so this
    // mostly exercises the boundary; the sleep-past-idle cases follow.
    for _ in 0..4 {
        std::thread::sleep(Duration::from_millis(1000));
        let out = Command::new(&env.exe)
            .args(["status", "--json"])
            .env("STRIVE_HOME", env.home.path())
            .env("STRIVE_IDLE_SECS", "1")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "launch failed at the idle boundary: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        pids.insert(pid(&serde_json::from_slice(&out.stdout).unwrap()));
    }
    assert!(!pids.is_empty());
}

/// Starts threads that connect and disconnect as fast as they can, until the
/// returned flag is set.
fn flood(
    socket: &Path,
) -> (
    std::sync::Arc<std::sync::atomic::AtomicBool>,
    Vec<std::thread::JoinHandle<()>>,
) {
    let done = std::sync::Arc::new(AtomicBool::new(false));
    let threads = (0..4)
        .map(|_| {
            let (done, socket) = (done.clone(), socket.to_path_buf());
            std::thread::spawn(move || {
                while !done.load(Ordering::Relaxed) {
                    let _ = UnixStream::connect(&socket);
                }
            })
        })
        .collect();
    (done, threads)
}

/// A steady stream of connections must not starve shutdown requests or
/// signals (accept must not outrank them).
#[test]
fn shutdown_is_not_starved_by_connection_floods() {
    let env = Env::new();

    env.status();
    let (done, threads) = flood(&env.socket());
    std::thread::sleep(Duration::from_millis(100));
    let out = env.strive(&["stop"]);
    assert!(
        out.status.success(),
        "stop under load failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    done.store(true, Ordering::Relaxed);
    for t in threads {
        t.join().unwrap();
    }

    let daemon = pid(&env.status());
    let (done, threads) = flood(&env.socket());
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        Command::new("kill")
            .arg(daemon.to_string())
            .status()
            .unwrap()
            .success()
    );
    wait_for("SIGTERM under load", Duration::from_secs(3), || {
        !env.socket().exists()
    });
    done.store(true, Ordering::Relaxed);
    for t in threads {
        t.join().unwrap();
    }
}

#[test]
fn protocol_errors() {
    let env = Env::new();
    env.status();
    let mut c = env.rpc();
    assert_eq!(
        c.call(1, "daemon/status", &json!({}))["error"]["code"],
        -32002,
        "must initialize first"
    );
    let bad = c.call(
        2,
        "initialize",
        &json!({"protocolVersion": 999, "client": {"name": "t", "version": "0"}}),
    );
    assert_eq!(bad["error"]["code"], -32003);
    assert_eq!(
        bad["error"]["data"]["protocolVersion"],
        strive_proto::PROTOCOL_VERSION
    );
    assert_eq!(
        c.init()["result"]["protocolVersion"],
        strive_proto::PROTOCOL_VERSION
    );
    assert_eq!(c.send_raw("{not json")["error"]["code"], -32700);
    assert_eq!(c.call(3, "no/such", &json!({}))["error"]["code"], -32601);
    assert_eq!(
        c.call(4, "initialize", &json!({"protocolVersion": "x"}))["error"]["code"],
        -32602
    );
    let s = c.call(5, "daemon/status", &json!({}));
    assert_eq!(s["id"], 5);
    assert!(s["result"]["clients"].as_u64().unwrap() >= 1);
}

#[test]
fn doctor_reports() {
    let env = Env::new();
    let out = env.strive(&["doctor"]);
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("daemon"), "{text}");
    assert!(
        text.lines()
            .any(|l| l.starts_with("ok") && l.contains("daemon")),
        "{text}"
    );
}
