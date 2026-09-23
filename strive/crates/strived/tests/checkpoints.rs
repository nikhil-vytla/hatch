//! Checkpoints: the workspace is saved before each prompt, and /rewind puts
//! it back. The user's own git repository is never touched.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::{Env, Rpc};
use serde_json::{Value, json};

struct Ws {
    /// Keeps the daemon and its home alive for the test.
    env: Env,
    dir: tempfile::TempDir,
    id: String,
    c: Rpc,
}

impl Ws {
    fn with_vars(vars: &[(&str, &str)]) -> Self {
        let env = Env::with_vars(vars);
        let dir = tempfile::Builder::new().prefix("strv-cp").tempdir_in("/tmp").unwrap();
        let mut c = env.rpc();
        let id = c.ok("session/create", &json!({"cwd": dir.path().canonicalize().unwrap()}))["id"]
            .as_str()
            .unwrap()
            .to_string();
        Self { env, dir, id, c }
    }
    fn new() -> Self {
        Self::with_vars(&[])
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.dir.path().join(rel)
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.p(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        fs::read_to_string(self.p(rel)).ok()
    }
    fn prompt(&mut self, text: &str) {
        self.c.ok("session/prompt", &json!({"id": self.id, "text": text}));
    }
    fn rewind(&mut self, checkpoint: u64) -> Value {
        self.c.call("session/rewind", &json!({"id": self.id, "checkpoint": checkpoint}))
    }
    fn events(&mut self) -> Vec<Value> {
        let r = self.c.ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap()
}

#[test]
fn each_prompt_is_preceded_by_a_checkpoint() {
    let mut w = Ws::new();
    w.write("a.txt", "v1");
    w.prompt("first");
    let e = w.events();
    let n = e.len();
    assert_eq!(e[n - 2]["type"], "checkpointed");
    assert_eq!(e[n - 2]["checkpoint"], 1);
    assert_eq!(e[n - 2]["commit"].as_str().unwrap().len(), 40);
    assert_eq!(e[n - 1], json!({"type": "userMessage", "text": "first"}));
    w.prompt("second");
    assert_eq!(w.events().iter().filter(|e| e["type"] == "checkpointed").count(), 2);
    assert!(!w.p(".git").exists(), "the shadow repository lives outside the workspace");
}

#[test]
fn rewind_restores_changed_created_and_deleted_files() {
    let mut w = Ws::new();
    w.write("a.txt", "v1");
    w.write("c.txt", "keep me");
    w.prompt("change things");
    w.write("a.txt", "v2");
    w.write("new/b.txt", "new file");
    fs::remove_file(w.p("c.txt")).unwrap();

    let r = w.rewind(1);
    assert_eq!(r["result"], json!({"savedAs": 2, "notSaved": []}), "{r}");
    assert_eq!(w.read("a.txt").as_deref(), Some("v1"));
    assert_eq!(w.read("c.txt").as_deref(), Some("keep me"));
    assert_eq!(w.read("new/b.txt"), None);
    assert_eq!(w.events().last().unwrap(), &json!({"type": "rewound", "to": 1, "savedAs": 2}));
}

#[test]
fn a_rewind_can_itself_be_undone() {
    let mut w = Ws::new();
    w.write("a.txt", "v1");
    w.prompt("p");
    w.write("a.txt", "v2");
    w.write("b.txt", "b");
    let saved = w.rewind(1)["result"]["savedAs"].as_u64().unwrap();
    assert_eq!(w.read("a.txt").as_deref(), Some("v1"));
    w.rewind(saved);
    assert_eq!(w.read("a.txt").as_deref(), Some("v2"));
    assert_eq!(w.read("b.txt").as_deref(), Some("b"));
}

#[test]
fn ignored_files_are_neither_saved_nor_touched() {
    let mut w = Ws::new();
    w.write(".gitignore", "build/\n");
    w.write("build/out.bin", "first build");
    w.prompt("p");
    w.write("build/out.bin", "second build");
    w.write("build/extra.bin", "extra");
    w.rewind(1);
    assert_eq!(w.read("build/out.bin").as_deref(), Some("second build"));
    assert_eq!(w.read("build/extra.bin").as_deref(), Some("extra"));
}

#[test]
fn the_users_own_repository_is_untouched() {
    let mut w = Ws::new();
    let d = w.dir.path().to_path_buf();
    git(&d, &["init", "-q", "-b", "main"]);
    w.write("a.txt", "committed");
    git(&d, &["add", "a.txt"]);
    git(&d, &["-c", "user.name=u", "-c", "user.email=u@x", "commit", "-q", "-m", "user commit"]);
    let head = git(&d, &["rev-parse", "HEAD"]);
    let refs = git(&d, &["for-each-ref"]);
    w.write("a.txt", "agent edit");
    w.prompt("p");
    w.write("a.txt", "later edit");
    w.rewind(1);
    assert_eq!(w.read("a.txt").as_deref(), Some("agent edit"));
    assert_eq!(git(&d, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&d, &["for-each-ref"]), refs);
    assert_eq!(git(&d, &["status", "--porcelain"]), " M a.txt\n");
    assert_eq!(git(&d, &["stash", "list"]), "");
}

#[test]
fn rewinding_to_an_unknown_checkpoint_is_an_error() {
    let mut w = Ws::new();
    w.prompt("p");
    let r = w.rewind(9);
    assert_eq!(r["error"]["code"], -32602);
    assert_eq!(r["error"]["message"], "no checkpoint 9 in this session");
}

#[test]
fn without_git_prompts_still_work_and_rewind_explains() {
    let mut w = Ws::with_vars(&[("STRIVE_GIT", "/nonexistent/git")]);
    w.prompt("p");
    assert!(!w.events().iter().any(|e| e["type"] == "checkpointed"));
    assert_eq!(w.events().last().unwrap(), &json!({"type": "userMessage", "text": "p"}));
    let r = w.rewind(1);
    assert_eq!(r["error"]["message"], "no checkpoint 1 in this session");
}

/// Checkpoints don't save ignored files, so a rewind that would replace a
/// directory of them would destroy them for good. It is refused.
#[test]
fn a_rewind_that_would_overwrite_ignored_files_is_refused() {
    let mut w = Ws::new();
    w.write("cache", "a file, once");
    w.prompt("first");
    fs::remove_file(w.p("cache")).unwrap();
    w.write("cache/valuable.txt", "only copy");
    w.write(".gitignore", "cache/\n");
    let r = w.rewind(1);
    let message = r["error"]["message"].as_str().unwrap_or_default().to_string();
    assert_eq!(
        message,
        "rewinding would overwrite files git ignores, which checkpoints don't save: cache/; move them aside first"
    );
    assert_eq!(w.read("cache/valuable.txt").as_deref(), Some("only copy"));
    assert!(!w.events().iter().any(|e| e["type"] == "rewound"));
}

/// A file ignored only after a checkpoint saved it is still saved by the
/// next one, so rewinding over it loses nothing.
#[test]
fn a_file_ignored_after_it_was_saved_survives_a_rewind() {
    let mut w = Ws::new();
    w.write(".env", "OLD=1");
    w.prompt("first");
    w.write(".env", "NEW=2");
    w.write(".gitignore", ".env\n");
    let saved = w.rewind(1)["result"]["savedAs"].as_u64().unwrap();
    assert_eq!(w.read(".env").as_deref(), Some("OLD=1"));
    assert!(w.rewind(saved).get("error").is_none());
    assert_eq!(w.read(".env").as_deref(), Some("NEW=2"));
}

/// A restore that fails partway leaves the workspace mixed; the state before
/// it is kept as a checkpoint, so it can be put back.
#[test]
fn a_failed_rewind_can_be_undone() {
    use std::os::unix::fs::PermissionsExt;
    let mut w = Ws::new();
    w.write("a.txt", "a1");
    w.write("locked/b.txt", "b1");
    w.prompt("first");
    w.write("a.txt", "a2");
    w.write("locked/b.txt", "b2");
    fs::set_permissions(w.p("locked"), fs::Permissions::from_mode(0o500)).unwrap();
    let r = w.rewind(1);
    fs::set_permissions(w.p("locked"), fs::Permissions::from_mode(0o700)).unwrap();
    let message = r["error"]["message"].as_str().unwrap_or_default().to_string();
    assert!(message.contains("/rewind 2"), "{r}");
    let saved = w.events().into_iter().rfind(|e| e["type"] == "checkpointed").unwrap();
    assert_eq!(saved["checkpoint"], 2);
    assert!(w.rewind(2).get("error").is_none());
    assert_eq!(w.read("a.txt").as_deref(), Some("a2"));
    assert_eq!(w.read("locked/b.txt").as_deref(), Some("b2"));
}

/// A rewind while a command runs would race it: the command's writes could
/// land after the restore, or be lost from the undo checkpoint.
#[test]
fn rewinding_while_an_effect_runs_is_refused() {
    let mut w = Ws::new();
    w.write("a.txt", "a1");
    w.prompt("first");
    w.c.ok("session/approvals", &json!({"id": w.id, "mode": "fullAuto"}));
    let mut agent = w.env.rpc();
    let params =
        json!({"id": w.id, "callId": "call_1", "request": {"kind": "bash", "command": "sleep 2; echo a3 > a.txt"}});
    let running = std::thread::spawn(move || agent.ok("effect/run", &params));
    common::wait_for("the command to start", std::time::Duration::from_secs(5), || {
        w.events().iter().any(|e| e["type"] == "effectStarted")
    });
    std::thread::sleep(std::time::Duration::from_millis(200));
    let r = w.rewind(1);
    assert_eq!(
        r["error"]["message"], "the agent is changing files right now; interrupt it (Esc) before rewinding",
        "{r}"
    );
    running.join().unwrap();
    assert!(w.rewind(1).get("error").is_none());
    assert_eq!(w.read("a.txt").as_deref(), Some("a1"));
}

/// Checkpoints store a nested repository as a pointer, not its files, so a
/// rewind leaves it alone and says so.
#[test]
fn nested_repositories_are_left_alone_and_reported() {
    let mut w = Ws::new();
    w.write("sub/work.txt", "v1");
    git(&w.p("sub"), &["init", "-q"]);
    w.write("a.txt", "a1");
    w.prompt("first");
    w.write("sub/work.txt", "v2");
    w.write("a.txt", "a2");
    let r = w.rewind(1);
    assert_eq!(r["result"]["notSaved"], json!(["sub"]), "{r}");
    assert_eq!(w.read("a.txt").as_deref(), Some("a1"));
    assert_eq!(w.read("sub/work.txt").as_deref(), Some("v2"));
}
