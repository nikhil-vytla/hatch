//! Forking a session (ADR-0030): a new session goes on from another's
//! conversation at an entry. The files stay as they are; the fork's first
//! checkpoint is them as they were at that entry.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::fs;

use common::Env;
use serde_json::{Value, json};

fn events(env: &Env, id: &str) -> Vec<(u64, Value)> {
    let r = env.rpc().ok("session/read", &json!({"id": id}));
    r["entries"].as_array().unwrap().iter().map(|e| (e["seq"].as_u64().unwrap(), e["event"].clone())).collect()
}

/// The seq of the session's prompt with this text.
fn prompt_seq(env: &Env, id: &str, text: &str) -> u64 {
    events(env, id).into_iter().find(|(_, e)| e["type"] == "userMessage" && e["text"] == text).unwrap().0
}

fn git() -> bool {
    std::process::Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

#[test]
fn a_fork_goes_on_from_an_entry_and_its_first_checkpoint_is_the_files_then() {
    let env = Env::new();
    let dir = tempfile::Builder::new().prefix("strv-fork").tempdir_in("/tmp").unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
    c.ok("session/approvals", &json!({"id": id, "mode": "fullAuto"}));
    fs::write(root.join("a.txt"), "one").unwrap();
    c.ok("session/prompt", &json!({"id": id, "text": "first"}));
    fs::write(root.join("a.txt"), "two").unwrap();
    c.ok("session/prompt", &json!({"id": id, "text": "second"}));
    let parent_before = events(&env, &id);

    // Just before the second prompt: the conversation as it was, to send another instead.
    let at = prompt_seq(&env, &id, "second") - 1;
    let fork = c.ok("session/fork", &json!({"id": id, "at": at}));
    let fid = fork["id"].as_str().unwrap().to_string();
    assert_ne!(fid, id);
    assert_eq!(fork["cwd"], root.display().to_string());

    let mine: Vec<Value> = events(&env, &fid).into_iter().map(|(_, e)| e).collect();
    assert_eq!(
        mine.iter().find(|e| e["type"] == "forkedFrom").unwrap(),
        &json!({"type": "forkedFrom", "session": id, "seq": at})
    );
    assert_eq!(
        mine.iter().find(|e| e["type"] == "approvalModeSet").unwrap()["mode"],
        "fullAuto",
        "the parent's mode then"
    );
    assert_eq!(events(&env, &id), parent_before, "the parent is left as it is");

    if !git() {
        eprintln!("no git: checkpoints are off");
        return;
    }
    assert_eq!(mine.iter().filter(|e| e["type"] == "checkpointed").count(), 1, "{mine:?}");
    // Files stay as they are; rewinding the fork to its first checkpoint
    // puts them back as they were then.
    fs::write(root.join("a.txt"), "three").unwrap();
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "three");
    c.ok("session/rewind", &json!({"id": fid, "checkpoint": 1}));
    assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "two");
}

#[test]
fn a_fork_defaults_to_the_last_entry_and_stays_within_the_journal() {
    let env = Env::new();
    let dir = tempfile::Builder::new().prefix("strv-fork").tempdir_in("/tmp").unwrap();
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": dir.path()}))["id"].as_str().unwrap().to_string();
    c.ok("session/prompt", &json!({"id": id, "text": "hi"}));
    let last = events(&env, &id).last().unwrap().0;
    let fid = c.ok("session/fork", &json!({"id": id}))["id"].as_str().unwrap().to_string();
    let forked = events(&env, &fid);
    assert_eq!(forked.iter().find(|(_, e)| e["type"] == "forkedFrom").unwrap().1["seq"], last);
    for bad in [0, last + 1] {
        let r = c.call("session/fork", &json!({"id": id, "at": bad}));
        assert!(r["error"]["message"].as_str().unwrap().contains(&format!("entries 1 to {last}")), "{r}");
    }
    // A learning session isn't one to go on from.
    let learning = c.ok("learning/open", &json!({"cwd": dir.path()}))["id"].as_str().unwrap().to_string();
    let r = c.call("session/fork", &json!({"id": learning}));
    assert!(r["error"]["message"].as_str().unwrap().contains("only a work session"), "{r}");
}

#[test]
fn strive_fork_prints_the_new_session() {
    let env = Env::new();
    let dir = tempfile::Builder::new().prefix("strv-fork").tempdir_in("/tmp").unwrap();
    let root = dir.path().canonicalize().unwrap();
    let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
    env.rpc().ok("session/prompt", &json!({"id": id, "text": "hi"}));
    let out = env.strive_in(&root, &["fork"]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let fid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(fid.len(), 26, "{fid}");
    assert!(String::from_utf8_lossy(&out.stderr).contains(&format!("strive -r {fid}")));
    assert!(events(&env, &fid).iter().any(|(_, e)| e["type"] == "forkedFrom" && e["session"] == id.as_str()));
}
