//! Checkpoints: the workspace is saved before each prompt, and /rewind puts
//! it back. The user's own git repository is never touched.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::{Env, Rpc};
use serde_json::{Value, json};

struct Ws {
    /// Keeps the daemon and its home alive for the test.
    _env: Env,
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
        Self { _env: env, dir, id, c }
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
    assert_eq!(r["result"], json!({"savedAs": 2}), "{r}");
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
