//! Project context: instruction files and skills the agent is given.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;
use std::path::Path;

use common::Env;
use serde_json::{Value, json};

fn write(p: &Path, text: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn register(env: &Env, cwd: &Path) -> (String, Value) {
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let config = c.ok("host/register", &json!({"id": id}));
    (id, config)
}

fn git_init(dir: &Path) {
    assert!(std::process::Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap().success());
}

#[test]
fn instruction_files_are_loaded_from_the_repository_root_down_to_the_workspace() {
    let env = Env::new();
    let repo = tempfile::tempdir().unwrap();
    let root = repo.path().canonicalize().unwrap();
    git_init(&root);
    write(&root.join("AGENTS.md"), "Use tabs.");
    write(&root.join("pkg/CLAUDE.md"), "Package rules.");
    write(&root.join("pkg/app/AGENTS.md"), "App rules.");
    write(&root.join("pkg/app/CLAUDE.md"), "Ignored: AGENTS.md wins in the same directory.");
    write(&env.home.path().join("AGENTS.md"), "Global rules.");
    let (_, config) = register(&env, &root.join("pkg/app"));
    let files: Vec<(String, String)> = config["instructions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap().to_string(), f["text"].as_str().unwrap().to_string()))
        .collect();
    let home = env.home.path().canonicalize().unwrap();
    assert_eq!(
        files,
        vec![
            (home.join("AGENTS.md").display().to_string(), "Global rules.".into()),
            (root.join("AGENTS.md").display().to_string(), "Use tabs.".into()),
            (root.join("pkg/CLAUDE.md").display().to_string(), "Package rules.".into()),
            (root.join("pkg/app/AGENTS.md").display().to_string(), "App rules.".into()),
        ]
    );
}

#[test]
fn imports_are_inlined_once_and_cycles_stop() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root.join("CLAUDE.md"), "Start.\n@AGENTS.md\nEnd.");
    write(&root.join("AGENTS.md"), "Shared rules.\n@CLAUDE.md");
    let (_, config) = register(&env, &root);
    let texts: Vec<&str> =
        config["instructions"].as_array().unwrap().iter().map(|f| f["text"].as_str().unwrap()).collect();
    assert_eq!(
        texts,
        vec!["Shared rules.\nStart.\n@AGENTS.md\nEnd."],
        "AGENTS.md wins; it imports CLAUDE.md, whose import back to AGENTS.md would cycle and stays as text"
    );
    fs::remove_file(root.join("AGENTS.md")).unwrap();
    write(&root.join("rules/style.md"), "Style.");
    write(&root.join("CLAUDE.md"), "Start.\n@rules/style.md\nEnd.");
    let (_, config) = register(&env, &root);
    assert_eq!(config["instructions"][0]["text"], "Start.\nStyle.\nEnd.");
}

#[test]
fn outside_a_repository_only_the_workspace_itself_is_read() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root.join("AGENTS.md"), "Parent rules.");
    write(&root.join("child/AGENTS.md"), "Child rules.");
    let (_, config) = register(&env, &root.join("child"));
    let texts: Vec<&str> =
        config["instructions"].as_array().unwrap().iter().map(|f| f["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["Child rules."]);
}

#[test]
fn skills_are_found_by_their_frontmatter() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(
        &root.join(".strive/skills/release/SKILL.md"),
        "---\nname: release\ndescription: Cut a release: bump, tag, publish.\n---\n\nSteps...",
    );
    write(&root.join(".claude/skills/review/SKILL.md"), "---\nname: review\ndescription: \"Review a diff\"\n---\nBody");
    write(&env.home.path().join("skills/notes/SKILL.md"), "---\nname: notes\ndescription: Keep notes.\n---\n");
    write(&root.join(".strive/skills/broken/SKILL.md"), "no frontmatter here");
    let (_, config) = register(&env, &root);
    let home = env.home.path().canonicalize().unwrap();
    assert_eq!(
        config["skills"],
        json!([
            {"name": "notes", "description": "Keep notes.", "path": home.join("skills/notes/SKILL.md")},
            {"name": "release", "description": "Cut a release: bump, tag, publish.", "path": root.join(".strive/skills/release/SKILL.md")},
            {"name": "review", "description": "Review a diff", "path": root.join(".claude/skills/review/SKILL.md")},
        ])
    );
}

#[test]
fn what_the_agent_was_given_is_journaled() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root.join("AGENTS.md"), "hello");
    write(&root.join(".strive/skills/s/SKILL.md"), "---\nname: s\ndescription: d\n---\n");
    let (id, _) = register(&env, &root);
    let r = env.rpc().ok("session/read", &json!({"id": id}));
    let loaded = r["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| &e["event"])
        .find(|e| e["type"] == "contextLoaded")
        .unwrap()
        .clone();
    assert_eq!(
        loaded,
        json!({
            "type": "contextLoaded",
            "instructions": [{"path": root.join("AGENTS.md"), "digest": "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", "bytes": 5}],
                        "skills": ["s"],
            "mcp": []
        })
    );
}

#[test]
fn an_import_cannot_reach_strives_own_state() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let key = env.home.path().join("keys/journal.key");
    env.status();
    write(&root.join("AGENTS.md"), &format!("Rules.\n@{}", key.display()));
    let (_, config) = register(&env, &root);
    assert_eq!(config["instructions"][0]["text"], format!("Rules.\n@{}", key.display()), "left as text, never inlined");
}

#[test]
fn the_agent_may_read_global_skills_but_nothing_else_of_strives_state() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&env.home.path().join("skills/notes/SKILL.md"), "skill body");
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
    let read = |c: &mut common::Rpc, path: &Path| {
        c.ok("effect/run", &json!({"id": id, "callId": "c", "request": {"kind": "read", "path": path}}))["text"].clone()
    };
    assert_eq!(read(&mut c, &env.home.path().join("skills/notes/SKILL.md")), "skill body");
    assert_eq!(read(&mut c, &env.home.path().join("keys/journal.key")), "the agent can't read strive's own state");
}

/// An instruction file is the repository's to write, and a symlink is a
/// file: one that leads into strive's own state is skipped, not read.
#[test]
fn an_instruction_file_that_links_into_strives_state_is_skipped() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    env.status();
    let secret = env.home.path().join("credentials.json");
    write(&secret, r#"{"anthropic":"sk-ant-secret"}"#);
    std::os::unix::fs::symlink(&secret, root.join("AGENTS.md")).unwrap();
    let (_, config) = register(&env, &root);
    assert_eq!(config["instructions"], json!([]), "{config}");
}

/// A FIFO where a skill file should be would never finish reading; the
/// session must start without it.
#[test]
fn a_skill_file_that_is_a_fifo_does_not_hold_up_the_session() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root.join(".strive/skills/ok/SKILL.md"), "---\nname: ok\ndescription: fine\n---\n");
    fs::create_dir_all(root.join(".strive/skills/hang")).unwrap();
    assert!(
        std::process::Command::new("mkfifo").arg(root.join(".strive/skills/hang/SKILL.md")).status().unwrap().success()
    );
    let (tx, rx) = std::sync::mpsc::channel();
    let mut c = env.rpc();
    std::thread::spawn(move || {
        let id = c.ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        tx.send(c.ok("host/register", &json!({"id": id}))).unwrap();
    });
    let config = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("registration finished");
    let names: Vec<&str> = config["skills"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["ok"]);
}

/// Learned memory and skills change only through review: the approval gate
/// and the sandbox guard their real paths. So only what is really there is
/// loaded; a symlink to a file elsewhere in the project would let a plain
/// edit of that file change what every session is told.
#[test]
fn learned_memory_and_skills_reached_through_a_symlink_are_not_loaded() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root.join("docs/notes.md"), "Anything an edit put here.");
    write(&root.join("docs/deploy/SKILL.md"), "---\nname: deploy\ndescription: Deploy it.\n---\n");
    write(&root.join("docs/shared.md"), "---\nname: shared\ndescription: Shared skill.\n---\n");
    fs::create_dir_all(root.join(".strive/skills/linked-file")).unwrap();
    std::os::unix::fs::symlink(root.join("docs/notes.md"), root.join(".strive/memory.md")).unwrap();
    std::os::unix::fs::symlink(root.join("docs/deploy"), root.join(".strive/skills/deploy")).unwrap();
    std::os::unix::fs::symlink(root.join("docs/shared.md"), root.join(".strive/skills/linked-file/SKILL.md")).unwrap();
    write(&root.join(".strive/skills/real/SKILL.md"), "---\nname: real\ndescription: Really here.\n---\n");
    let (_, config) = register(&env, &root);
    let names: Vec<&str> = config["skills"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["real"], "{config}");
    let text = config["instructions"].to_string();
    assert!(!text.contains("Anything an edit put here"), "{config}");
}

/// A skills directory that is itself a symlink is skipped whole.
#[test]
fn a_learned_skills_directory_that_is_a_symlink_is_not_loaded() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    write(&root.join("elsewhere/x/SKILL.md"), "---\nname: x\ndescription: X.\n---\n");
    fs::create_dir_all(root.join(".strive")).unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere"), root.join(".strive/skills")).unwrap();
    let (_, config) = register(&env, &root);
    assert_eq!(config["skills"], json!([]), "{config}");
}
