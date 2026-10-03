//! Effects a crash cut off while they ran (ADR-0030): those the journal
//! shows were cleared to run, of a kind safe to repeat, run again when the
//! session's host next registers. Every other one stays interrupted.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::PathBuf;

use common::Env;
use serde_json::{Value, json};

struct Crashed {
    env: Env,
    _dir: tempfile::TempDir,
    root: PathBuf,
    id: String,
}

impl Crashed {
    /// A work session, with the daemon stopped as a crash would leave it.
    fn new() -> Self {
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-rerun").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        env.stop();
        Self { env, _dir: dir, root, id }
    }
    /// `text` in the content store, as the effect that wrote it left it.
    fn stored(&self, text: &str) -> String {
        let cas = strive_journal::cas::Cas::open(&self.env.home.path().join("cas")).unwrap();
        cas.put(text.as_bytes()).unwrap().to_string()
    }
    /// The daemon crashed while effect `n` ran: it started, and was
    /// cleared to run if `cleared`.
    fn cut_off(&self, n: u64, record: &Value, cleared: bool) {
        let mut events =
            vec![json!({"type": "effectStarted", "effect": n, "callId": format!("c{n}"), "record": record})];
        if cleared {
            events.push(json!({"type": "effectCleared", "effect": n}));
        }
        common::append_offline(&self.env, &self.id, &Value::Array(events));
    }
    fn write(&self, rel: &str, text: &str) {
        fs::write(self.root.join(rel), text).unwrap();
    }
    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.root.join(rel)).unwrap_or_default()
    }
    /// A host registers, as one does when the session resumes.
    fn resume(&self) {
        let mut host = self.env.rpc();
        host.ok("host/register", &json!({"id": self.id}));
    }
    fn events(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
    /// How effect `n` ended after the crash: `rerun`'s outcome, if it ran again.
    fn ended(&self, n: u64) -> (Value, Option<Value>) {
        let events = self.events();
        let of = |kind: &str| events.iter().find(|e| e["type"] == kind && e["effect"] == n).cloned();
        (of("effectFinished").unwrap()["outcome"].clone(), of("effectRerun").map(|e| e["outcome"].clone()))
    }
    fn output(&self, outcome: &Value) -> String {
        let r = self.env.rpc().ok("blob/get", &json!({"digest": outcome["output"]}));
        r["text"].as_str().unwrap().to_string()
    }
}

#[test]
fn a_cleared_read_and_write_run_again_and_a_command_does_not() {
    let c = Crashed::new();
    c.write("notes.txt", "kept\n");
    c.cut_off(1, &json!({"kind": "read", "path": "notes.txt"}), true);
    let content = c.stored("written\n");
    c.cut_off(2, &json!({"kind": "write", "path": "out.txt", "content": content, "bytes": 8}), true);
    c.cut_off(3, &json!({"kind": "bash", "command": "touch ran.txt", "timeoutMs": 5000}), true);
    c.resume();

    let (first, read) = c.ended(1);
    assert_eq!(first["kind"], "interrupted", "the crash's own record stays");
    let read = read.expect("the read ran again");
    assert!(c.output(&read).contains("kept"), "{read}");
    assert_eq!(c.ended(2).1.unwrap()["kind"], "done");
    assert_eq!(c.read("out.txt"), "written\n");
    // A command may have done its work, or half of it: it is never repeated.
    assert_eq!(c.ended(3), (json!({"kind": "interrupted"}), None));
    assert!(!c.root.join("ran.txt").exists());

    // Once: a later host's registration runs nothing again.
    c.resume();
    let reruns = c.events().iter().filter(|e| e["type"] == "effectRerun").count();
    assert_eq!(reruns, 2);
}

#[test]
fn an_effect_a_crash_caught_before_it_was_cleared_stays_interrupted() {
    let c = Crashed::new();
    // Waiting for a person's approval, say: no one had decided.
    let content = c.stored("never approved\n");
    c.cut_off(1, &json!({"kind": "write", "path": "out.txt", "content": content, "bytes": 15}), false);
    c.resume();
    assert_eq!(c.ended(1), (json!({"kind": "interrupted"}), None));
    assert!(!c.root.join("out.txt").exists());
}

#[test]
fn an_edit_runs_again_only_where_its_file_shows_whether_it_landed() {
    let c = Crashed::new();
    let (old, new) = (c.stored("red"), c.stored("blue"));
    let edit = |path: &str| json!({"kind": "edit", "path": path, "oldText": old, "newText": new});
    c.write("pending.txt", "the sky is red\n");
    c.write("landed.txt", "the sky is blue\n");
    c.write("unclear.txt", "the sky is green\n");
    c.cut_off(1, &edit("pending.txt"), true);
    c.cut_off(2, &edit("landed.txt"), true);
    c.cut_off(3, &edit("unclear.txt"), true);
    // An edit whose new text holds its old one: landed, its old text still shows.
    let (short, long) = (c.stored("a"), c.stored("a, b"));
    c.write("appended.txt", "list: a, b\n");
    c.cut_off(4, &json!({"kind": "edit", "path": "appended.txt", "oldText": short, "newText": long}), true);
    c.resume();

    assert_eq!(c.ended(1).1.unwrap()["kind"], "done");
    assert_eq!(c.read("pending.txt"), "the sky is blue\n");
    assert_eq!(c.ended(2).1.unwrap()["kind"], "done");
    assert_eq!(c.read("landed.txt"), "the sky is blue\n", "a landed edit isn't made twice");
    assert_eq!(c.ended(3).1, None, "a file that shows neither stays interrupted");
    assert_eq!(c.read("unclear.txt"), "the sky is green\n");
    assert_eq!(c.ended(4).1.unwrap()["kind"], "done");
    assert_eq!(c.read("appended.txt"), "list: a, b\n", "not appended twice");
}

#[test]
fn a_rerun_is_refused_where_the_path_is_now_out_of_bounds() {
    let c = Crashed::new();
    // strive's own state, which no effect may read, whatever was decided.
    let secret = c.env.home.path().join("secret.txt");
    fs::write(&secret, "s3cret").unwrap();
    c.cut_off(1, &json!({"kind": "read", "path": secret.display().to_string()}), true);
    c.resume();
    assert_eq!(c.ended(1), (json!({"kind": "interrupted"}), None));
}
