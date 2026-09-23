//! The session commands a user types: `strive log`, `verify`, `sessions`.

mod common;

use std::fs;
use std::path::PathBuf;

use common::Env;
use serde_json::{Value, json};

struct Repo {
    env: Env,
    dir: tempfile::TempDir,
}

impl Repo {
    fn new() -> Self {
        Self { env: Env::new(), dir: tempfile::tempdir().unwrap() }
    }
    fn path(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }
    fn session(&self, prompts: &[&str]) -> String {
        let mut c = self.env.rpc();
        let id = c.ok("session/create", &json!({"cwd": self.path()}))["id"].as_str().unwrap().to_string();
        for p in prompts {
            c.ok("session/prompt", &json!({"id": id, "text": p}));
        }
        id
    }
    fn run(&self, args: &[&str]) -> (i32, String, String) {
        let out = self.env.strive_in(&self.path(), args);
        (out.status.code().unwrap(), String::from_utf8(out.stdout).unwrap(), String::from_utf8(out.stderr).unwrap())
    }
    fn tamper(&self, id: &str, from: &str, to: &str) {
        let path = self.env.session_dir(id).join("journal.jsonl");
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, text.replace(from, to)).unwrap();
    }
}

/// `#N HH:MM:SS  what` — the time is local, so match around it.
fn entry_line(out: &str, seq: u64) -> &str {
    let prefix = format!("#{seq} ");
    out.lines().find(|l| l.starts_with(&prefix)).unwrap_or_else(|| panic!("no entry #{seq} in:\n{out}"))
}

#[test]
fn log_shows_the_latest_session_in_this_directory() {
    let r = Repo::new();
    r.session(&["older prompt"]);
    let id = r.session(&["fix the flaky test"]);
    let (code, out, _) = r.run(&["log"]);
    assert_eq!(code, 0, "{out}");
    assert_eq!(out.lines().next().unwrap(), format!("session {id}  {}", r.path().display()));
    assert!(entry_line(&out, 1).ends_with(&format!("  started in {}", r.path().display())), "{out}");
    assert!(entry_line(&out, 2).ends_with("  budget: $5.0000"), "new sessions get the default budget: {out}");
    assert!(entry_line(&out, 3).ends_with("  approvals: auto-edit"), "new sessions get the default approvals: {out}");
    assert!(entry_line(&out, 4).ends_with("  you: fix the flaky test"), "{out}");
    assert!(!out.contains("older prompt"), "{out}");
}

#[test]
fn log_takes_an_explicit_session_id() {
    let r = Repo::new();
    let older = r.session(&["older prompt"]);
    r.session(&["newer prompt"]);
    let (code, out, _) = r.run(&["log", &older]);
    assert_eq!(code, 0);
    assert!(entry_line(&out, 4).ends_with("  you: older prompt"), "{out}");
}

#[test]
fn log_json_is_the_verified_journal() {
    let r = Repo::new();
    let id = r.session(&["hello"]);
    let (code, out, _) = r.run(&["log", "--json"]);
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["session"]["id"], id);
    assert_eq!(v["entries"][3]["event"], json!({"type": "userMessage", "text": "hello"}));
    assert_eq!(v.get("problem"), None);
}

#[test]
fn log_without_sessions_says_how_to_start_one() {
    let r = Repo::new();
    let (code, out, err) = r.run(&["log"]);
    assert_eq!((code, out.as_str()), (1, ""));
    assert_eq!(err.trim(), format!("strive: no sessions in {}; start one with `strive`", r.path().display()));
}

#[test]
fn log_of_a_tampered_session_shows_what_verified_and_fails() {
    let r = Repo::new();
    let id = r.session(&["one", "two"]);
    r.tamper(&id, r#""text":"two""#, r#""text":"TWO""#);
    let (code, out, _) = r.run(&["log"]);
    assert_eq!(code, 1);
    assert!(entry_line(&out, 4).ends_with("  you: one"), "{out}");
    assert!(!out.contains("#5 "), "{out}");
    assert_eq!(out.lines().last().unwrap(), "journal FAILED verification: entry 5 was modified, removed or moved");
}

#[test]
fn verify_passes_intact_sessions_and_names_the_broken_one() {
    let r = Repo::new();
    let good = r.session(&["fine"]);
    let bad = r.session(&["about to change"]);
    let (code, out, _) = r.run(&["verify", &good]);
    assert_eq!((code, out.trim()), (0, format!("ok    {good}  4 entries").as_str()));

    r.tamper(&bad, "about to change", "changed!");
    let (code, out, _) = r.run(&["verify", "--all"]);
    assert_eq!(code, 1);
    assert_eq!(
        out.lines().collect::<Vec<_>>(),
        vec![format!("FAIL  {bad}  entry 4 was modified, removed or moved"), format!("ok    {good}  4 entries"),]
    );
}

#[test]
fn verify_without_an_id_checks_the_latest_session_here() {
    let r = Repo::new();
    let id = r.session(&[]);
    let (code, out, _) = r.run(&["verify"]);
    assert_eq!((code, out.trim()), (0, format!("ok    {id}  3 entries").as_str()));
}

#[test]
fn sessions_lists_this_directory_newest_first() {
    let r = Repo::new();
    let a = r.session(&[]);
    let b = r.session(&["x"]);
    let other = tempfile::tempdir().unwrap();
    let elsewhere = r.env.rpc().ok("session/create", &json!({"cwd": other.path()}))["id"].as_str().unwrap().to_string();

    let (code, out, _) = r.run(&["sessions"]);
    assert_eq!(code, 0);
    let ids: Vec<&str> = out.lines().map(|l| l.split_whitespace().next().unwrap()).collect();
    assert_eq!(ids, vec![b.as_str(), a.as_str()]);

    let (_, out, _) = r.run(&["sessions", "--all"]);
    let ids: Vec<&str> = out.lines().map(|l| l.split_whitespace().next().unwrap()).collect();
    assert_eq!(ids, vec![elsewhere.as_str(), b.as_str(), a.as_str()]);
    assert!(out.lines().next().unwrap().ends_with(&other.path().display().to_string()), "{out}");
}

#[test]
fn continue_and_resume_are_mutually_exclusive() {
    let r = Repo::new();
    let (code, _, err) = r.run(&["--continue", "--resume", "01J8ZZZZZZZZZZZZZZZZZZZZZZ"]);
    assert_eq!(code, 2);
    assert!(err.contains("cannot be used with"), "{err}");
}

#[test]
fn verify_all_reports_sessions_whose_journal_cannot_be_read() {
    let r = Repo::new();
    let emptied = r.session(&["x"]);
    let garbled = r.session(&[]);
    let fine = r.session(&[]);
    fs::write(r.env.session_dir(&emptied).join("journal.jsonl"), b"").unwrap();
    fs::write(r.env.session_dir(&garbled).join("journal.jsonl"), b"not json\n").unwrap();

    let (code, out, _) = r.run(&["verify", "--all"]);
    assert_eq!(code, 1, "{out}");
    assert_eq!(
        out.lines().collect::<Vec<_>>(),
        vec![
            format!("ok    {fine}  3 entries"),
            format!("FAIL  {garbled}  entry 1 was modified, removed or moved"),
            format!("FAIL  {emptied}  entries were removed from the end (0 of 4 committed entries remain)"),
        ]
    );
    let (_, out, _) = r.run(&["sessions", "--all"]);
    assert!(out.lines().any(|l| l == format!("{garbled}  unreadable journal")), "{out}");
    let (_, out, _) = r.run(&["sessions"]);
    assert!(
        !out.contains("unreadable"),
        "a directory's listing can't claim sessions whose directory is unknown: {out}"
    );
    let (code, _, err) = r.run(&["log", &garbled]);
    assert_eq!(code, 1);
    assert_eq!(err.trim(), "strive: the session journal failed verification: entry 1 was modified, removed or moved");
}

#[test]
fn auth_stores_a_key_from_stdin_and_reports_where_keys_come_from() {
    use std::io::Write as _;
    let r = Repo::new();
    let (code, out, _) = r.run(&["auth"]);
    assert_eq!((code, out.as_str()), (0, "anthropic  not set\nopenai     not set\n"));

    let mut child = r
        .env
        .command(&r.env.exe, &["auth", "anthropic"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"sk-ant-from-stdin\n").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "saved the anthropic key; new model calls use it\n");

    let (_, out, _) = r.run(&["auth"]);
    assert_eq!(out, "anthropic  set with strive auth\nopenai     not set\n");
    let stored = fs::read_to_string(r.env.home.path().join("credentials.json")).unwrap();
    assert!(stored.contains("sk-ant-from-stdin"));

    let (code, _, err) = r.run(&["auth", "gemini"]);
    assert_eq!(code, 2, "{err}");
}

#[test]
fn doctor_reports_the_daemons_credentials() {
    let r = Repo::new();
    let (_, out, _) = r.run(&["doctor"]);
    let line = out.lines().find(|l| l.contains("credentials")).unwrap();
    assert_eq!(line, "warn  credentials    no provider keys; run `strive auth anthropic` or `strive auth openai`");
    r.env.rpc().ok("auth/set", &json!({"provider": "openai", "apiKey": "sk-x"}));
    let (_, out, _) = r.run(&["doctor"]);
    let line = out.lines().find(|l| l.contains("credentials")).unwrap();
    assert_eq!(line, "ok    credentials    openai (strive auth)");
}

#[test]
fn gateway_prints_the_sessions_base_urls_as_environment() {
    let r = Repo::new();
    let id = r.session(&[]);
    let (code, out, _) = r.run(&["gateway"]);
    assert_eq!(code, 0);
    let lines: Vec<&str> = out.lines().collect();
    assert_eq!(lines.len(), 2, "{out}");
    let anthropic = lines[0].strip_prefix("ANTHROPIC_BASE_URL=http://127.0.0.1:").unwrap();
    assert!(anthropic.ends_with("/anthropic") && anthropic.contains("/g/"), "{out}");
    let openai = lines[1].strip_prefix("OPENAI_BASE_URL=http://127.0.0.1:").unwrap();
    assert!(openai.ends_with("/openai/v1"), "{out}");
    let via_rpc = r.env.rpc().ok("session/gateway", &json!({"id": id}));
    assert_eq!(lines[0], format!("ANTHROPIC_BASE_URL={}", via_rpc["anthropic"].as_str().unwrap()));
}

/// A first entry that parses but fails its MAC names a directory no one can
/// vouch for, so log refuses it rather than show it.
#[test]
fn log_refuses_a_journal_whose_first_entry_fails_verification() {
    let r = Repo::new();
    let id = r.session(&["x"]);
    let path = r.path().display().to_string();
    r.tamper(&id, &format!(r#""cwd":"{path}""#), r#""cwd":"/somewhere/else""#);
    let (code, out, err) = r.run(&["log", &id]);
    assert_eq!((code, out.as_str()), (1, ""));
    assert_eq!(err.trim(), "strive: the session journal failed verification: entry 1 was modified, removed or moved");
}
