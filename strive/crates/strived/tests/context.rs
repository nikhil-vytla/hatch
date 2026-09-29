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
    write(&root.join("rules/AGENTS.md"), "Style.");
    write(&root.join("CLAUDE.md"), "Start.\n@rules/AGENTS.md\nEnd.");
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

/// Everything the loader gives a session is on one list that the approval
/// gate and the sandbox guard, or imported by a file on it (guarded too).
/// What a listed path links to elsewhere isn't loaded: an edit there would
/// change what every session is told with no one asked. A link to another
/// listed file is loaded.
#[test]
fn the_loader_reads_nothing_outside_the_list() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git_init(&root);
    std::os::unix::fs::symlink("CLAUDE.md", root.join("AGENTS.md")).unwrap();
    write(&root.join("CLAUDE.md"), "Root.\n@docs/y.md\n@pkg/rules/AGENTS.md");
    write(&root.join("docs/y.md"), "Imported instructions.");
    write(&root.join("pkg/rules/AGENTS.md"), "Imported rules.");
    write(&root.join("pkg/docs/x.md"), "Linked instructions.");
    std::os::unix::fs::symlink("docs/x.md", root.join("pkg/AGENTS.md")).unwrap();
    write(&root.join("elsewhere/ext/SKILL.md"), "---\nname: ext\ndescription: Linked skill.\n---\n");
    fs::create_dir_all(root.join("pkg/.claude/skills")).unwrap();
    std::os::unix::fs::symlink(root.join("elsewhere/ext"), root.join("pkg/.claude/skills/ext")).unwrap();
    write(&root.join("pkg/.claude/skills/own/SKILL.md"), "---\nname: own\ndescription: Here.\n---\n");
    let (id, config) = register(&env, &root.join("pkg"));
    let texts: Vec<&str> =
        config["instructions"].as_array().unwrap().iter().map(|f| f["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["Root.\nImported instructions.\nImported rules."], "{config}");
    let names: Vec<&str> = config["skills"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["own"], "{config}");

    // What it did load, the gate guards: full-auto, unattended, can't write
    // any of it, nor the files an instruction file imported.
    let mut c = env.rpc();
    c.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
    let write_to = |c: &mut common::Rpc, path: &str| {
        c.ok(
            "effect/run",
            &json!({"id": id, "callId": "c", "request": {"kind": "write", "path": path, "content": "x"}}),
        )
    };
    let instructions = config["instructions"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap());
    let skills = config["skills"].as_array().unwrap().iter().map(|s| s["path"].as_str().unwrap());
    let imported = [root.join("pkg/rules/AGENTS.md"), root.join("docs/y.md")].map(|p| p.display().to_string());
    for path in instructions.chain(skills).chain(imported.iter().map(String::as_str)) {
        let r = write_to(&mut c, path);
        assert_eq!(r["outcome"]["kind"], "refused", "{path}: {r}");
        assert!(r["text"].as_str().unwrap().contains("every future session"), "{path}: {r}");
    }
    // The file a skipped link leads to is an ordinary one: writing it is
    // free, and it stays out of every session.
    let r = write_to(&mut c, "docs/x.md");
    assert_eq!(r["outcome"]["kind"], "done", "{r}");
}

/// An instruction file's imports are inlined where they are inside the
/// project, and guarded as it is: a write to one, or to one not yet
/// written, asks a person even in full-auto.
#[test]
fn an_import_inside_the_project_is_inlined_and_guarded() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    git_init(&root);
    let fence = "```\n@docs/style.md\n```";
    write(&root.join("AGENTS.md"), &format!("Root.\n@docs/style.md\n@docs/later.md\n{fence}"));
    write(&root.join("docs/style.md"), "Style.\n@../rules/deep.md");
    write(&root.join("rules/deep.md"), "Deep.");
    fs::create_dir_all(root.join("pkg")).unwrap();
    let (id, config) = register(&env, &root.join("pkg"));
    let expected = format!("Root.\nStyle.\nDeep.\n@docs/later.md\n{fence}");
    assert_eq!(config["instructions"][0]["text"], expected.as_str(), "a code block stays as text: {config}");

    let mut c = env.rpc();
    c.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
    let write_to = |c: &mut common::Rpc, path: &str| {
        let request = json!({"kind": "write", "path": root.join(path), "content": "x"});
        c.ok("effect/run", &json!({"id": id, "callId": "c", "request": request}))
    };
    for (path, by) in
        [("docs/style.md", "AGENTS.md"), ("rules/deep.md", "docs/style.md"), ("docs/later.md", "AGENTS.md")]
    {
        let r = write_to(&mut c, path);
        let text = r["text"].as_str().unwrap();
        assert_eq!(r["outcome"]["kind"], "refused", "{path}: {text}");
        assert!(text.contains(&format!("it's imported by {by}")), "{path}: {text}");
        assert!(text.contains("needs a person's approval even in full-auto"), "{path}: {text}");
    }
    assert_eq!(fs::read_to_string(root.join("docs/style.md")).unwrap(), "Style.\n@../rules/deep.md");
    assert!(!root.join("docs/later.md").exists());
    let r = write_to(&mut c, "pkg/other.md");
    assert_eq!(r["outcome"]["kind"], "done", "a file nothing imports is ordinary: {r}");
}

/// An import outside the project, or through a symlink that leads out of
/// it, stays as text: the gate and the sandbox guard only the project.
#[test]
fn an_import_outside_the_project_is_refused() {
    let env = Env::new();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap().join("repo");
    fs::create_dir_all(&root).unwrap();
    git_init(&root);
    let outside = root.parent().unwrap().join("outside.md");
    write(&outside, "Outside.");
    std::os::unix::fs::symlink(&outside, root.join("link.md")).unwrap();
    let text = format!("Root.\n@{}\n@../outside.md\n@link.md", outside.display());
    write(&root.join("AGENTS.md"), &text);
    let (_, config) = register(&env, &root);
    assert_eq!(config["instructions"][0]["text"], text, "{config}");
}
