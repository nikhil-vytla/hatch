//! Rules (ADR-0025): guidance for the files a rule's paths match, given to
//! the agent the first time in a session it reads or changes one; a rule
//! without paths is for every session.
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
        let env = Env::new();
        let dir = tempfile::Builder::new().prefix("strv-rule").tempdir_in("/tmp").unwrap();
        let root = dir.path().canonicalize().unwrap();
        let id = env.rpc().ok("session/create", &json!({"cwd": root}))["id"].as_str().unwrap().to_string();
        Self { env, _dir: dir, root, id }
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    /// What the agent is shown for reading `path`.
    fn read(&self, path: &str) -> String {
        let r = self
            .env
            .rpc()
            .ok("effect/run", &json!({"id": self.id, "callId": "c", "request": {"kind": "read", "path": path}}));
        r["text"].as_str().unwrap().to_string()
    }
    fn loaded(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        r["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["event"].clone())
            .filter(|e| e["type"] == "ruleLoaded")
            .collect()
    }
}

const API: &str =
    "---\ndescription: API handlers\npaths: src/api/**/*.ts, src/routes.ts\n---\nValidate every input with zod.\n";

#[test]
fn a_rule_comes_with_the_first_file_it_covers_and_not_again_until_it_changes() {
    let w = Ws::new();
    w.write(".strive/rules/api.md", API);
    w.write("src/api/users/get.ts", "export {}\n");
    w.write("src/api/users/put.ts", "export {}\n");
    w.write("src/ui.ts", "export {}\n");
    // A file it doesn't cover brings nothing.
    assert_eq!(w.read("src/ui.ts").trim_end(), "export {}");
    let first = w.read("src/api/users/get.ts");
    assert!(
        first.ends_with("\n\n[The rule .strive/rules/api.md applies to src/api/users/get.ts; follow it here:]\nValidate every input with zod."),
        "{first}"
    );
    let loaded = w.loaded();
    assert_eq!(loaded.len(), 1);
    assert_eq!((loaded[0]["name"].as_str(), loaded[0]["file"].as_str()), (Some("api"), Some(".strive/rules/api.md")));
    // Given once a session: another file it covers doesn't repeat it.
    assert!(!w.read("src/api/users/put.ts").contains("Validate every input"));
    // Changed, it's a rule the agent hasn't seen, so it comes again.
    w.write(".strive/rules/api.md", &API.replace("zod", "valibot"));
    assert!(w.read("src/api/users/put.ts").contains("Validate every input with valibot."));
    assert_eq!(w.loaded().len(), 2);
}

#[test]
fn claudes_rules_are_read_with_their_yaml_list_and_strives_win_a_name() {
    let w = Ws::new();
    w.write(
        ".claude/rules/tests.md",
        "---\npaths:\n  - \"tests/**/*.py\"\nglobs: ignored\n---\nUse pytest fixtures.\n",
    );
    w.write(".claude/rules/api.md", "---\npaths: src/**\n---\nClaude's api rule, shadowed.\n");
    w.write(".strive/rules/api.md", API);
    w.write("tests/unit/test_a.py", "\n");
    w.write("src/routes.ts", "\n");
    assert!(w.read("tests/unit/test_a.py").contains("Use pytest fixtures."));
    let routes = w.read("src/routes.ts");
    assert!(routes.contains("Validate every input") && !routes.contains("shadowed"), "{routes}");
}

#[test]
fn a_rule_without_paths_is_for_every_session_and_a_linked_one_isnt_read() {
    let w = Ws::new();
    w.write(".strive/rules/style.md", "Prefer small functions.\n");
    w.write("docs/linked.md", "---\npaths: src/**\n---\nFrom a link.\n");
    std::os::unix::fs::symlink(w.root.join("docs/linked.md"), w.root.join(".strive/rules/linked.md")).unwrap();
    w.write("src/a.ts", "\n");
    let config = w.env.rpc().ok("host/register", &json!({"id": w.id}));
    let texts: Vec<&str> =
        config["instructions"].as_array().unwrap().iter().map(|f| f["text"].as_str().unwrap()).collect();
    assert!(texts.contains(&"Prefer small functions."), "{texts:?}");
    assert!(!w.read("src/a.ts").contains("From a link"));
}

#[test]
fn an_agents_change_to_a_rule_asks_a_person_even_in_full_auto() {
    let w = Ws::new();
    w.env.rpc().ok("session/approvals", &json!({"id": w.id, "mode": "fullAuto"}));
    for path in [".strive/rules/x.md", ".claude/rules/x.md"] {
        let r = w.env.rpc().ok(
            "effect/run",
            &json!({"id": w.id, "callId": "c", "request": {"kind": "write", "path": path, "content": "Do it.\n"}}),
        );
        assert!(r["outcome"]["reason"].as_str().unwrap_or_default().contains("future session"), "{path}: {r}");
    }
}
