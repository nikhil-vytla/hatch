#![allow(dead_code, reason = "each test binary uses a different subset")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

pub struct Env {
    pub home: tempfile::TempDir,
    pub exe: PathBuf,
    /// Extra environment for every strive command, and so for the daemon.
    pub vars: Vec<(String, String)>,
}

impl Env {
    pub fn new() -> Self {
        // Short base path: Unix socket paths are limited to ~104 bytes on macOS.
        let home = tempfile::Builder::new().prefix("strv").tempdir_in("/tmp").unwrap();
        Self { home, exe: PathBuf::from(env!("CARGO_BIN_EXE_strive")), vars: Vec::new() }
    }
    pub fn with_vars(vars: &[(&str, &str)]) -> Self {
        let mut e = Self::new();
        e.vars = vars.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect();
        e
    }
    pub fn cmd(&self, exe: &Path, args: &[&str]) -> Output {
        self.command(exe, args).output().unwrap()
    }
    pub fn command(&self, exe: &Path, args: &[&str]) -> Command {
        let mut c = Command::new(exe);
        // Real keys and upstreams from the developer's shell must never reach
        // a test daemon: each test sets exactly what it needs.
        c.args(args)
            .env("STRIVE_HOME", self.home.path())
            .env_remove("STRIVE_IDLE_SECS")
            .env_remove("STRIVE_TUI")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("OPENAI_API_KEY")
            .env("STRIVE_UPSTREAM_ANTHROPIC", "http://127.0.0.1:9")
            .env("STRIVE_UPSTREAM_OPENAI", "http://127.0.0.1:9")
            // No agent host unless a test asks for one.
            .env("STRIVE_HOST", "none")
            .envs(self.vars.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        c
    }
    pub fn strive(&self, args: &[&str]) -> Output {
        self.cmd(&self.exe, args)
    }
    pub fn strive_in(&self, cwd: &Path, args: &[&str]) -> Output {
        self.command(&self.exe, args).current_dir(cwd).output().unwrap()
    }
    pub fn status(&self) -> Value {
        let out = self.strive(&["status", "--json"]);
        assert!(out.status.success(), "status failed ({}): {}", out.status, String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout).unwrap()
    }
    pub fn socket(&self) -> PathBuf {
        self.home.path().join("run/strived.sock")
    }
    pub fn stop(&self) {
        assert!(self.strive(&["stop"]).status.success());
    }
    /// A raw connection that has not sent `initialize`.
    pub fn raw(&self) -> Rpc {
        let s = UnixStream::connect(self.socket()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        Rpc { r: BufReader::new(s.try_clone().unwrap()), w: s, next_id: 100, notes: VecDeque::new() }
    }
    /// An initialized connection, starting the daemon if needed.
    pub fn rpc(&self) -> Rpc {
        self.status();
        let mut c = self.raw();
        let init = c.init();
        assert!(init.get("result").is_some(), "{init}");
        c
    }
    pub fn session_dir(&self, id: &str) -> PathBuf {
        self.home.path().join("sessions").join(id)
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = self.strive(&["stop"]);
    }
}

pub struct Rpc {
    r: BufReader<UnixStream>,
    w: UnixStream,
    next_id: i64,
    notes: VecDeque<Value>,
}

impl Rpc {
    fn read(&mut self) -> Value {
        let mut buf = String::new();
        self.r.read_line(&mut buf).unwrap();
        serde_json::from_str(&buf).unwrap_or_else(|e| panic!("bad line {buf:?}: {e}"))
    }
    /// Sends one line and returns the next response, keeping notifications.
    pub fn send_raw(&mut self, line: &str) -> Value {
        self.send_line(line);
        self.next_response()
    }
    pub fn send_line(&mut self, line: &str) {
        self.w.write_all(line.as_bytes()).unwrap();
        self.w.write_all(b"\n").unwrap();
    }
    /// The next response on this connection, keeping notifications.
    pub fn next_response(&mut self) -> Value {
        loop {
            let v = self.read();
            if v.get("method").is_some() && v.get("id").is_none() {
                self.notes.push_back(v);
            } else {
                return v;
            }
        }
    }
    pub fn call_id(&mut self, id: i64, method: &str, params: &Value) -> Value {
        self.send_raw(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string())
    }
    /// Calls a method and returns the whole response.
    pub fn call(&mut self, method: &str, params: &Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let v = self.call_id(id, method, params);
        assert_eq!(v["id"], id);
        v
    }
    /// Waits up to `limit` for each reply, for calls that take a while.
    pub fn wait_up_to(&mut self, limit: Duration) {
        self.r.get_ref().set_read_timeout(Some(limit)).unwrap();
    }
    /// Calls a method and returns its result, failing on an error response.
    pub fn ok(&mut self, method: &str, params: &Value) -> Value {
        let v = self.call(method, params);
        assert!(v.get("error").is_none(), "{method} failed: {v}");
        v["result"].clone()
    }
    pub fn init(&mut self) -> Value {
        self.call_id(
            0,
            "initialize",
            &json!({"protocolVersion": strive_proto::PROTOCOL_VERSION, "client": {"name": "test", "version": "0"}}),
        )
    }
    /// The next notification, waiting up to five seconds.
    pub fn notification(&mut self) -> Value {
        if let Some(n) = self.notes.pop_front() {
            return n;
        }
        let v = self.read();
        assert!(v.get("id").is_none(), "expected a notification, got {v}");
        v
    }
}

fn open_offline(env: &Env, session: &str) -> (strive_journal::Journal, Vec<strive_proto::Entry>) {
    let key: [u8; 32] = std::fs::read(env.home.path().join("keys/journal.key")).unwrap().try_into().unwrap();
    let key = strive_journal::Key::from_bytes(key);
    strive_journal::Journal::open(&env.session_dir(session), session, &key, 1).unwrap()
}

/// Appends `events` to a session's journal while no daemon runs, as a
/// daemon that crashed after writing them would leave it; their seqs.
pub fn append_offline(env: &Env, session: &str, events: &Value) -> Vec<u64> {
    let (mut journal, entries) = open_offline(env, session);
    let events: Vec<strive_proto::Event> = serde_json::from_value(events.clone()).unwrap();
    let written = journal.append(entries.last().unwrap().ts_ms, &events).unwrap();
    journal.commit().unwrap();
    written.iter().map(|e| e.seq).collect()
}

/// A session's events, read while no daemon runs, as JSON.
pub fn events_offline(env: &Env, session: &str) -> Vec<Value> {
    let key: [u8; 32] = std::fs::read(env.home.path().join("keys/journal.key")).unwrap().try_into().unwrap();
    let key = strive_journal::Key::from_bytes(key);
    let report = strive_journal::read(&env.session_dir(session), session, &key).unwrap();
    assert!(report.problem.is_none(), "{:?}", report.problem);
    report.entries.into_iter().map(|e| serde_json::to_value(e.event).unwrap()).collect()
}

/// The seq the next entry of a session's journal gets, while no daemon runs.
pub fn next_seq_offline(env: &Env, session: &str) -> u64 {
    open_offline(env, session).1.last().unwrap().seq + 1
}

/// A connection that waits up to 30s for each reply, for calls that do long
/// work on a loaded machine.
pub fn slow_rpc(env: &Env) -> Rpc {
    let mut c = env.rpc();
    c.wait_up_to(Duration::from_secs(30));
    c
}

pub fn pid(status: &Value) -> u64 {
    status["server"]["pid"].as_u64().unwrap()
}

pub fn wait_for(what: &str, timeout: Duration, mut f: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !f() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
