//! Slash commands (ADR-0024): `/name arguments` is the prompt a project's
//! command file stands for, and the files are guarded as learned ones are.
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

impl Ws {
    fn new() -> Self {
        // Tests start no host: prompts are journaled, and nothing answers them.
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-cmd").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        Self { env, _dir: dir, root, id }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    /// The user message a prompt journaled.
    fn prompt(&self, text: &str) -> Value {
        self.env.rpc().ok("session/prompt", &json!({"id": self.id, "text": text}));
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        r["entries"].as_array().unwrap().iter().rev().find(|e| e["event"]["type"] == "userMessage").unwrap()["event"]
            .clone()
    }
    fn commands(&self) -> Vec<Value> {
        self.env.rpc().ok("session/commands", &json!({"id": self.id}))["commands"].as_array().unwrap().clone()
    }
}

#[test]
fn a_command_is_the_prompt_its_file_stands_for_and_the_journal_keeps_both() {
    let w = Ws::new();
    w.write(".strive/commands/review.md", "---\ndescription: Review a PR\n---\nReview PR $1, then $ARGUMENTS.\n");
    let m = w.prompt("/review 42 be brief");
    assert_eq!(
        m,
        json!({
            "type": "userMessage",
            "text": "Review PR 42, then 42 be brief.",
            "command": {"name": "review", "arguments": "42 be brief"},
        })
    );
    // Anything else is the prompt as typed.
    assert_eq!(w.prompt("/unknown thing"), json!({"type": "userMessage", "text": "/unknown thing"}));
    assert_eq!(w.prompt("plain words"), json!({"type": "userMessage", "text": "plain words"}));
}

#[test]
fn a_session_lists_the_projects_commands_then_claudes_then_its_own_home() {
    let w = Ws::new();
    w.write(".strive/commands/review.md", "---\ndescription: strive's review\nargument-hint: <pr>\n---\nReview.\n");
    w.write(".claude/commands/review.md", "Claude's review, shadowed.\n");
    w.write(".claude/commands/ship.md", "---\nallowed-tools: Bash(git:*)\n---\nShip it.\n");
    // Strict for strive's own: an unknown field is a typo, so it isn't offered.
    w.write(".strive/commands/typo.md", "---\ndescripton: d\n---\nDo it.\n");
    fs::create_dir_all(w.env.home.path().join("commands")).unwrap();
    fs::write(w.env.home.path().join("commands/standup.md"), "Write my standup.\n").unwrap();
    let listed: Vec<(String, Option<String>)> = w
        .commands()
        .iter()
        .map(|c| (c["name"].as_str().unwrap().to_string(), c["description"].as_str().map(str::to_string)))
        .collect();
    assert_eq!(
        listed,
        [("review".into(), Some("strive's review".into())), ("ship".into(), None), ("standup".into(), None)]
    );
    assert_eq!(w.commands()[0]["argumentHint"], "<pr>");
    assert_eq!(w.prompt("/ship")["text"], "Ship it.");
}

#[test]
fn a_command_reached_through_a_symlink_isnt_offered() {
    let w = Ws::new();
    w.write("docs/review.md", "Review.\n");
    fs::create_dir_all(w.root.join(".strive/commands")).unwrap();
    std::os::unix::fs::symlink(w.root.join("docs/review.md"), w.root.join(".strive/commands/review.md")).unwrap();
    assert_eq!(w.commands(), [] as [Value; 0]);
    assert_eq!(w.prompt("/review")["text"], "/review");
}

#[test]
fn an_agents_change_to_a_command_asks_a_person_even_in_full_auto() {
    let w = Ws::new();
    w.env.rpc().ok("session/approvals", &json!({"id": w.id, "mode": "fullAuto"}));
    for path in [".strive/commands/x.md", ".claude/commands/x.md"] {
        let r = w.env.rpc().ok(
            "effect/run",
            &json!({"id": w.id, "callId": "c", "request": {"kind": "write", "path": path, "content": "Do it.\n"}}),
        );
        assert!(r["outcome"]["reason"].as_str().unwrap_or_default().contains("future session"), "{path}: {r}");
        assert!(!w.root.join(path).exists());
    }
}
