//! End-to-end tests against the real `strive` binary, each with its own
//! `STRIVE_HOME`, so they never touch a developer's daemon.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use common::{Env, pid, wait_for};
use serde_json::{Value, json};

#[test]
fn starts_once_and_reuses_the_daemon() {
    let env = Env::new();
    let a = env.status();
    let b = env.status();
    assert_eq!(pid(&a), pid(&b));
    assert_eq!(a["server"]["version"], env!("CARGO_PKG_VERSION"));
    let mode =
        std::fs::metadata(env.socket()).map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions())).unwrap();
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
    assert_eq!(pids.len(), 1, "racing starts produced several daemons: {pids:?}");
}

#[test]
fn stop_stops_it() {
    let env = Env::new();
    env.status();
    let out = env.strive(&["stop"]);
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("stopped daemon"));
    assert!(!env.socket().exists());
    let out = env.strive(&["stop"]);
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "no daemon running");
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
    wait_for("idle exit", Duration::from_secs(5), || !env.socket().exists());
}

/// A copy of `strive` that looks like another build: build ids compare the
/// executable's length and mtime, and a rebuild changes the mtime.
fn older_build(env: &Env) -> std::path::PathBuf {
    let old = env.home.path().join("old-strive");
    std::fs::copy(&env.exe, &old).unwrap();
    let f = std::fs::File::options().write(true).open(&old).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(3600)).unwrap();
    old
}

#[test]
fn replaces_a_stale_daemon_from_another_build() {
    let env = Env::new();
    let old = older_build(&env);
    let out = env.cmd(&old, &["status", "--json"]);
    let old_status: Value = serde_json::from_slice(&out.stdout).unwrap();
    let new_status = env.status();
    assert_ne!(old_status["server"]["build"], new_status["server"]["build"]);
    assert_ne!(pid(&old_status), pid(&new_status), "the stale daemon should have been replaced");
}

/// Cargo puts a fresh copy of `strive` in place on every run, rebuilt or not:
/// same bytes, same mtime, a new inode. A daemon started from the previous
/// copy is the same build, and a launcher must not shut it down under the
/// sessions it's running.
#[test]
fn a_fresh_copy_of_the_same_build_keeps_the_daemon() {
    let env = Env::new();
    let running = pid(&env.status());
    let copy = env.home.path().join("same-strive");
    std::fs::copy(&env.exe, &copy).unwrap();
    let mtime = std::fs::metadata(&env.exe).unwrap().modified().unwrap();
    std::fs::File::options().write(true).open(&copy).unwrap().set_modified(mtime).unwrap();
    let out = env.cmd(&copy, &["status", "--json"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let status: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(pid(&status), running, "the daemon was replaced by a copy of its own build");
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
    for _ in 0..5 {
        let old = older_build(&env);
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
                assert!(out.status.success(), "launcher failed: {}", String::from_utf8_lossy(&out.stderr));
                pid(&serde_json::from_slice(&out.stdout).unwrap())
            })
            .collect();
        assert_eq!(pids.len(), 1, "expected one replacement daemon: {pids:?}");
        std::fs::remove_file(&old).unwrap();
    }
}

fn status_with_idle(env: &Env, idle_secs: &str) -> Output {
    Command::new(&env.exe)
        .args(["status", "--json"])
        .env("STRIVE_HOME", env.home.path())
        .env("STRIVE_IDLE_SECS", idle_secs)
        .output()
        .unwrap()
}

/// Race: the daemon decides to exit for idleness while a launcher is
/// connecting. Launches ~100 ms apart keep the daemon at the edge of its
/// idle window; every one must still succeed.
#[test]
fn launches_succeed_near_idle_exits() {
    let env = Env::new();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(3) {
        let out = status_with_idle(&env, "1");
        assert!(out.status.success(), "launch failed near an idle exit: {}", String::from_utf8_lossy(&out.stderr));
        std::thread::sleep(Duration::from_millis(97));
    }
}

/// After an observed idle exit, the next launch starts a new daemon.
#[test]
fn a_launch_after_idle_exit_starts_a_new_daemon() {
    let env = Env::new();
    let mut previous = pid(&serde_json::from_slice(&status_with_idle(&env, "1").stdout).unwrap());
    for _ in 0..3 {
        wait_for("idle exit", Duration::from_secs(5), || !env.socket().exists());
        let out = status_with_idle(&env, "1");
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let next = pid(&serde_json::from_slice(&out.stdout).unwrap());
        assert_ne!(next, previous, "the idle daemon should have been replaced");
        previous = next;
    }
}

/// Starts threads that connect and disconnect as fast as they can, until the
/// returned flag is set.
fn flood(socket: &Path) -> (std::sync::Arc<std::sync::atomic::AtomicBool>, Vec<std::thread::JoinHandle<()>>) {
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
    assert!(out.status.success(), "stop under load failed: {}", String::from_utf8_lossy(&out.stderr));
    done.store(true, Ordering::Relaxed);
    for t in threads {
        t.join().unwrap();
    }

    let daemon = pid(&env.status());
    let (done, threads) = flood(&env.socket());
    std::thread::sleep(Duration::from_millis(100));
    assert!(Command::new("kill").arg(daemon.to_string()).status().unwrap().success());
    wait_for("SIGTERM under load", Duration::from_secs(3), || !env.socket().exists());
    done.store(true, Ordering::Relaxed);
    for t in threads {
        t.join().unwrap();
    }
}

#[test]
fn protocol_errors() {
    let env = Env::new();
    env.status();
    let mut c = env.raw();
    assert_eq!(c.call_id(1, "daemon/status", &json!({}))["error"]["code"], -32002, "must initialize first");
    let bad = c.call_id(2, "initialize", &json!({"protocolVersion": 999, "client": {"name": "t", "version": "0"}}));
    assert_eq!(bad["error"]["code"], -32003);
    assert_eq!(bad["error"]["data"]["protocolVersion"], strive_proto::PROTOCOL_VERSION);
    assert_eq!(c.init()["result"]["protocolVersion"], strive_proto::PROTOCOL_VERSION);
    assert_eq!(c.send_raw("{not json")["error"]["code"], -32700);
    assert_eq!(c.call_id(3, "no/such", &json!({}))["error"]["code"], -32601);
    assert_eq!(c.call_id(4, "initialize", &json!({"protocolVersion": "x"}))["error"]["code"], -32602);
    // The `strive status` that started the daemon has disconnected by now,
    // but the daemon may not have observed it yet.
    let mut id = 5;
    wait_for("only this client connected", Duration::from_secs(2), || {
        id += 1;
        let s = c.call_id(id, "daemon/status", &json!({}));
        assert_eq!(s["id"], id);
        s["result"]["clients"] == 1
    });
}

#[test]
fn doctor_fails_without_a_tui_and_passes_with_one() {
    let env = Env::new();
    let out = env.strive(&["doctor"]);
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(1), "{text}");
    let tui = text.lines().find(|l| l.contains(" tui ")).unwrap();
    assert!(tui.starts_with("FAIL"), "{tui}");
    assert!(tui.contains("strive-tui not found"), "{tui}");

    let out = Command::new(&env.exe)
        .arg("doctor")
        .env("STRIVE_HOME", env.home.path())
        .env("STRIVE_TUI", "/bin/echo tui")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(0), "{text}");
    let daemon = text.lines().find(|l| l.contains(" daemon ")).unwrap();
    assert!(
        daemon.starts_with("ok") && daemon.contains(&format!("pid {}, protocol 1", pid(&env.status()))),
        "{daemon}"
    );
    let tui = text.lines().find(|l| l.contains(" tui ")).unwrap();
    assert!(tui.starts_with("ok") && tui.ends_with("/bin/echo tui"), "{tui}");
}

/// A daemon nobody can reach anymore (its home was deleted, say) exits
/// instead of idling on.
#[test]
fn the_daemon_exits_when_its_socket_is_removed() {
    let env = Env::new();
    let pid = common::pid(&env.status()).to_string();
    let alive = || std::process::Command::new("kill").args(["-0", &pid]).status().unwrap().success();
    assert!(alive());
    std::fs::remove_file(env.socket()).unwrap();
    common::wait_for("the daemon to exit", Duration::from_secs(5), || !alive());
}
