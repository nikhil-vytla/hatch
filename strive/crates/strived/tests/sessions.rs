//! Sessions end to end: the real daemon, real journals on disk.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;

use common::Env;
use serde_json::{Value, json};

fn create(env: &Env, cwd: &str) -> String {
    let s = env.rpc().ok("session/create", &json!({"cwd": cwd}));
    s["id"].as_str().unwrap().to_string()
}

fn events(entries: &Value) -> Vec<Value> {
    entries.as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
}

fn seqs(entries: &Value) -> Vec<u64> {
    entries.as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()).collect()
}

#[test]
fn a_prompt_is_journaled_and_read_back() {
    let env = Env::new();
    let mut c = env.rpc();
    let s = c.ok("session/create", &json!({"cwd": "/tmp/repo"}));
    assert_eq!(s["cwd"], "/tmp/repo");
    let id = s["id"].as_str().unwrap();
    assert_eq!(id.len(), 26, "ULID: {id}");

    let p = c.ok("session/prompt", &json!({"id": id, "text": "hello"}));
    assert_eq!(p, json!({"seq": 4}));

    let r = c.ok("session/read", &json!({"id": id}));
    for field in ["id", "cwd", "createdAtMs"] {
        assert_eq!(r["session"][field], s[field], "{field}");
    }
    assert_eq!(r["session"]["title"], "hello", "named by its first prompt");
    assert_eq!(r["committed"], 4);
    assert_eq!(r["tornBytes"], 0);
    assert_eq!(r.get("problem"), None);
    assert_eq!(seqs(&r["entries"]), vec![1, 2, 3, 4]);
    assert_eq!(
        events(&r["entries"]),
        vec![
            json!({"type": "sessionStarted", "format": 1, "cwd": "/tmp/repo", "striveVersion": env!("CARGO_PKG_VERSION")}),
            json!({"type": "budgetSet", "usdMicros": 5_000_000}),
            json!({"type": "approvalModeSet", "mode": "autoEdit"}),
            json!({"type": "userMessage", "text": "hello"}),
        ]
    );
    assert_eq!(
        r["entries"][0]["tsMs"].as_u64().unwrap(),
        s["createdAtMs"].as_u64().unwrap(),
        "createdAtMs is the first entry's time"
    );
}

#[test]
fn every_attached_client_receives_new_entries() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut a = env.rpc();
    let mut b = env.rpc();
    let attached = a.ok("session/attach", &json!({"id": id}));
    assert_eq!(seqs(&attached["entries"]), vec![1, 2, 3]);
    b.ok("session/attach", &json!({"id": id}));

    b.ok("session/prompt", &json!({"id": id, "text": "hi"}));
    let expected = json!({
        "sessionId": id,
        "entry": {"seq": 4, "event": {"type": "userMessage", "text": "hi"}},
    });
    for client in [&mut a, &mut b] {
        let mut n = client.notification();
        assert_eq!(n["method"], "session/entry");
        n["params"]["entry"].as_object_mut().unwrap().remove("tsMs");
        assert_eq!(n["params"], expected);
    }
}

#[test]
fn attach_after_seq_returns_only_later_entries() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut c = env.rpc();
    for t in ["one", "two", "three"] {
        c.ok("session/prompt", &json!({"id": id, "text": t}));
    }
    let r = c.ok("session/attach", &json!({"id": id, "afterSeq": 4}));
    assert_eq!(seqs(&r["entries"]), vec![5, 6]);
}

#[test]
fn listing_filters_by_directory_newest_first() {
    let env = Env::new();
    let a1 = create(&env, "/a");
    let b1 = create(&env, "/b");
    let a2 = create(&env, "/a");
    let ids = |v: Value| -> Vec<String> {
        v["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect()
    };
    let mut c = env.rpc();
    assert_eq!(ids(c.ok("session/list", &json!({"cwd": "/a"}))), vec![a2.clone(), a1.clone()]);
    assert_eq!(ids(c.ok("session/list", &json!({}))), vec![a2, b1, a1]);
    assert_eq!(ids(c.ok("session/list", &json!({"cwd": "/none"}))), Vec::<String>::new());
}

#[test]
fn sessions_survive_a_daemon_restart() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    env.rpc().ok("session/prompt", &json!({"id": id, "text": "keep me"}));
    env.stop();
    let r = env.rpc().ok("session/attach", &json!({"id": id}));
    assert_eq!(events(&r["entries"])[3], json!({"type": "userMessage", "text": "keep me"}));
}

#[test]
fn a_tampered_journal_is_refused_and_explained() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    env.rpc().ok("session/prompt", &json!({"id": id, "text": "original"}));
    env.stop();
    let path = env.session_dir(&id).join("journal.jsonl");
    let text = fs::read_to_string(&path).unwrap();
    fs::write(&path, text.replace("original", "edited!!")).unwrap();

    let mut c = env.rpc();
    let err = c.call("session/attach", &json!({"id": id}));
    assert_eq!(err["error"]["code"], -32011);
    assert_eq!(err["error"]["data"]["problem"], "entry 4 was modified, removed or moved");
    let r = c.ok("session/read", &json!({"id": id}));
    assert_eq!(r["problem"], "entry 4 was modified, removed or moved");
    assert_eq!(seqs(&r["entries"]), vec![1, 2, 3]);
    let p = c.call("session/prompt", &json!({"id": id, "text": "more"}));
    assert_eq!(p["error"]["code"], -32011, "no appends to an invalid journal");
    assert_eq!(fs::read_to_string(&path).unwrap(), text.replace("original", "edited!!"));
}

#[test]
fn a_crash_torn_line_is_recovered_on_attach() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    env.stop();
    let mut f = fs::OpenOptions::new().append(true).open(env.session_dir(&id).join("journal.jsonl")).unwrap();
    f.write_all(br#"{"seq":4,"ts"#).unwrap();

    let mut c = env.rpc();
    let before = c.ok("session/read", &json!({"id": id}));
    assert_eq!((before["tornBytes"].as_u64(), before.get("problem")), (Some(12), None));
    let r = c.ok("session/attach", &json!({"id": id}));
    assert_eq!(events(&r["entries"])[3], json!({"type": "recovered", "discardedBytes": 12}));
    let after = c.ok("session/read", &json!({"id": id}));
    assert_eq!((after["tornBytes"].as_u64(), after["committed"].as_u64()), (Some(0), Some(4)));
}

#[test]
fn concurrent_prompts_get_distinct_consecutive_seqs() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let threads: Vec<_> = (0..5)
        .map(|t| {
            let mut c = env.rpc();
            let id = id.clone();
            std::thread::spawn(move || {
                (0..10)
                    .map(|i| {
                        c.ok("session/prompt", &json!({"id": id, "text": format!("{t}-{i}")}))["seq"].as_u64().unwrap()
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    let got: BTreeSet<u64> = threads.into_iter().flat_map(|t| t.join().unwrap()).collect();
    assert_eq!(got, (4..=53).collect::<BTreeSet<u64>>());

    let r = env.rpc().ok("session/read", &json!({"id": id}));
    assert_eq!((r["committed"].as_u64(), r.get("problem")), (Some(53), None));
    let texts: BTreeSet<String> =
        events(&r["entries"])[3..].iter().map(|e| e["text"].as_str().unwrap().to_string()).collect();
    assert_eq!(texts.len(), 50, "every prompt was journaled once");
}

#[test]
fn unknown_and_malformed_session_ids_are_rejected() {
    let env = Env::new();
    let mut c = env.rpc();
    let missing = c.call("session/attach", &json!({"id": "01J8ZZZZZZZZZZZZZZZZZZZZZZ"}));
    assert_eq!(missing["error"]["code"], -32010);
    for bad in ["../../etc", "", "not-a-ulid"] {
        let r = c.call("session/read", &json!({"id": bad}));
        assert_eq!(r["error"]["code"], -32602, "{bad:?} must be rejected as invalid params");
    }
}

#[test]
fn the_journal_key_is_private_and_stable_across_restarts() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let key = env.home.path().join("keys/journal.key");
    let mode = fs::metadata(&key).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    let bytes = fs::read(&key).unwrap();
    assert_eq!(bytes.len(), 32);
    env.stop();
    let r = env.rpc().ok("session/read", &json!({"id": id}));
    assert_eq!(r.get("problem"), None, "a restarted daemon verifies with the same key");
    assert_eq!(fs::read(&key).unwrap(), bytes);
}

#[test]
fn a_corrupt_journal_key_stops_the_daemon_with_its_path() {
    let env = Env::new();
    create(&env, "/tmp/repo");
    env.stop();
    let key = env.home.path().join("keys/journal.key");
    fs::write(&key, b"short").unwrap();
    let started = std::time::Instant::now();
    let out = env.strive(&["status"]);
    assert!(!out.status.success());
    assert!(started.elapsed() < std::time::Duration::from_secs(2), "a failed start is reported at once");
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains(&format!(
            "the daemon failed to start: opening the session store: {} is not a 32-byte key",
            key.display()
        )),
        "{err}"
    );
    let log = fs::read_to_string(env.home.path().join("logs/strived.log")).unwrap();
    assert!(log.contains(&format!("opening the session store: {} is not a 32-byte key", key.display())), "{log}");
}

/// A client that attached to a session and then disconnected must stop
/// counting as connected (its subscription must not keep the connection open).
#[test]
fn disconnecting_after_attach_releases_the_connection() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut c = env.rpc();
    c.ok("session/attach", &json!({"id": id}));
    drop(c);
    let mut probe = env.rpc();
    common::wait_for("the attached client to be released", std::time::Duration::from_secs(2), || {
        probe.ok("daemon/status", &json!({}))["clients"] == 1
    });
}

/// Resuming verifies the journal on disk even when the daemon already has
/// the session open, and a refused session takes no more appends.
#[test]
fn attach_verifies_a_journal_tampered_while_the_daemon_ran() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut c = env.rpc();
    c.ok("session/prompt", &json!({"id": id, "text": "original"}));
    let path = env.session_dir(&id).join("journal.jsonl");
    let tampered = fs::read_to_string(&path).unwrap().replace("original", "edited!!");
    fs::write(&path, &tampered).unwrap();

    let err = c.call("session/attach", &json!({"id": id}));
    assert_eq!(err["error"]["code"], -32011, "{err}");
    assert_eq!(err["error"]["data"]["problem"], "entry 4 was modified, removed or moved");
    let p = c.call("session/prompt", &json!({"id": id, "text": "more"}));
    assert_eq!(p["error"]["code"], -32011, "{p}");
    assert_eq!(fs::read_to_string(&path).unwrap(), tampered);
}

/// A write failure stops the session's writer; the next request reopens the
/// journal, which repairs it, instead of every later prompt failing.
#[test]
fn a_session_recovers_after_a_failed_write() {
    use std::os::unix::fs::PermissionsExt;
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut c = env.rpc();
    let dir = env.session_dir(&id);
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
    let failed = c.call("session/prompt", &json!({"id": id, "text": "a"}));
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(failed["error"]["code"], -32603, "{failed}");

    let ok = c.ok("session/prompt", &json!({"id": id, "text": "b"}));
    let r = c.ok("session/read", &json!({"id": id}));
    assert_eq!(r.get("problem"), None);
    let texts: Vec<&str> =
        r["entries"].as_array().unwrap()[3..].iter().map(|e| e["event"]["text"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["a", "b"], "the unconfirmed prompt was synced before the failure, so it is adopted");
    assert_eq!(ok["seq"], 5);
}

/// Attaching to a session the instant it appears in a listing must not open
/// a second writer for a journal whose creator is still registering its own.
#[test]
fn racing_creates_and_attaches_keep_one_writer_per_journal() {
    let env = Env::new();
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let racer = {
        let (stop, mut c) = (stop.clone(), env.rpc());
        std::thread::spawn(move || {
            let mut seen = BTreeSet::new();
            while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                for s in c.ok("session/list", &json!({}))["sessions"].as_array().unwrap().clone() {
                    let id = s["id"].as_str().unwrap().to_string();
                    if seen.insert(id.clone()) {
                        c.ok("session/prompt", &json!({"id": id, "text": "from the racer"}));
                    }
                }
            }
        })
    };
    let mut c = env.rpc();
    let ids: Vec<String> = (0..60)
        .map(|_| {
            let id = c.ok("session/create", &json!({"cwd": "/tmp/race"}))["id"].as_str().unwrap().to_string();
            c.ok("session/prompt", &json!({"id": id, "text": "from the creator"}));
            id
        })
        .collect();
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    racer.join().unwrap();
    for id in ids {
        let r = c.ok("session/read", &json!({"id": id}));
        assert_eq!(r.get("problem"), None, "session {id}: {r}");
    }
}

/// Live text from the agent reaches attached clients, and isn't journaled.
#[test]
fn host_stream_reaches_attached_clients_without_being_journaled() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut host = env.rpc();
    host.ok("host/register", &json!({"id": id}));
    let mut ui = env.rpc();
    ui.ok("session/attach", &json!({"id": id}));
    let before = env.rpc().ok("session/read", &json!({"id": id}))["entries"].as_array().unwrap().len();
    host.ok("host/stream", &json!({"id": id, "turn": 1, "text": "Working on it"}));
    let n = ui.notification();
    assert_eq!(n["method"], "session/delta");
    assert_eq!(n["params"], json!({"sessionId": id, "turn": 1, "text": "Working on it"}));
    let after = env.rpc().ok("session/read", &json!({"id": id}))["entries"].as_array().unwrap().len();
    assert_eq!(after, before);
}

#[test]
fn hosts_may_record_only_turns_and_replies() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut c = env.rpc();
    c.ok("host/register", &json!({"id": id}));
    let r = c.call("host/record", &json!({"id": id, "event": {"type": "budgetSet", "usdMicros": 999_999_999}}));
    assert_eq!(r["error"]["code"], -32602);
    assert_eq!(
        r["error"]["message"],
        "a host records only turns, assistant messages, summaries, check reports and layout proposals"
    );
    c.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
}

/// A list names each session by its first prompt, on one line and short.
#[test]
fn a_session_is_listed_by_its_first_prompt() {
    let env = Env::new();
    let dir = tempfile::Builder::new().prefix("strv-ws").tempdir_in("/tmp").unwrap();
    let cwd = dir.path().canonicalize().unwrap();
    // Each prompt takes a checkpoint first: git, which a loaded machine slows past `rpc`'s 5s.
    let mut c = common::slow_rpc(&env);
    let id = c.ok("session/create", &json!({"cwd": cwd}))["id"].as_str().unwrap().to_string();
    let untitled = c.ok("session/list", &json!({"cwd": cwd}));
    assert_eq!(untitled["sessions"][0].get("title"), None, "{untitled}");
    let long = format!("Fix the flaky\ntest in {}", "the parser module ".repeat(10));
    c.ok("session/prompt", &json!({"id": id, "text": long}));
    c.ok("session/prompt", &json!({"id": id, "text": "and then this"}));
    let listed = c.ok("session/list", &json!({"cwd": cwd}));
    let title = listed["sessions"][0]["title"].as_str().unwrap();
    assert!(title.starts_with("Fix the flaky test in the parser module"), "{title}");
    assert!(title.ends_with('…') && title.chars().count() <= 81, "{title}");
    assert!(
        listed["sessions"][0]["lastActiveMs"].as_u64().unwrap()
            >= listed["sessions"][0]["createdAtMs"].as_u64().unwrap()
    );
}

/// The priced models are listed, with settings' own as the default.
#[test]
fn the_priced_models_are_listed() {
    let env = Env::new();
    let r = env.rpc().ok("model/list", &json!({}));
    assert_eq!(r["default"], "claude-sonnet-4-5");
    let haiku = r["models"].as_array().unwrap().iter().find(|m| m["id"] == "claude-haiku-4-5").unwrap();
    assert_eq!(
        haiku,
        &json!({"id": "claude-haiku-4-5", "provider": "anthropic", "contextWindow": 200_000,
                "inputUsdMicros": 1_000_000, "outputUsdMicros": 5_000_000})
    );
    let gpt = r["models"].as_array().unwrap().iter().find(|m| m["id"] == "gpt-5").unwrap();
    assert_eq!(gpt["provider"], "openai");
}

/// A model chosen before the first prompt is the one the agent starts
/// with, after a restart too. Once there's a prompt it can't change.
#[test]
fn a_model_chosen_before_the_first_prompt_is_the_agents() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut c = env.rpc();
    let unpriced = c.call("session/model", &json!({"id": id, "model": "claude-imaginary-9"}));
    assert_eq!(unpriced["error"]["code"], -32602, "{unpriced}");
    c.ok("session/model", &json!({"id": id, "model": "claude-haiku-4-5"}));
    c.ok("session/prompt", &json!({"id": id, "text": "go"}));
    let late = c.call("session/model", &json!({"id": id, "model": "claude-opus-4-5"}));
    assert_eq!(late["error"]["code"], -32600, "{late}");
    assert!(late["error"]["message"].as_str().unwrap().contains("start a new session"), "{late}");
    env.stop();
    let config = env.rpc().ok("host/register", &json!({"id": id}));
    assert_eq!(config["model"], "claude-haiku-4-5");
    let r = env.rpc().ok("session/read", &json!({"id": id}));
    let chosen: Vec<Value> = events(&r["entries"]).into_iter().filter(|e| e["type"] == "modelSet").collect();
    assert_eq!(chosen, vec![json!({"type": "modelSet", "model": "claude-haiku-4-5"})]);
}

/// Without a choice, the agent uses the model in settings.
#[test]
fn a_session_without_a_chosen_model_uses_the_settings_one() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let config = env.rpc().ok("host/register", &json!({"id": id}));
    assert_eq!(config["model"], "claude-sonnet-4-5");
}

/// The agent's host can't pick its own model.
#[test]
fn a_host_cannot_choose_the_model() {
    let env = Env::new();
    let id = create(&env, "/tmp/repo");
    let mut host = env.rpc();
    host.ok("host/register", &json!({"id": id}));
    let r = host.call("session/model", &json!({"id": id, "model": "claude-haiku-4-5"}));
    assert_eq!(r["error"]["message"], "only a person can do this, not the agent's host");
}
