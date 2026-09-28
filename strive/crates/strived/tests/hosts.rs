//! Agent hosts: one per session, and only it speaks for the agent.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use common::Env;
use serde_json::{Value, json};
use strive_proto::rpc::RpcError;

fn session(env: &Env) -> String {
    let dir = tempfile::Builder::new().prefix("strv-ws").tempdir_in("/tmp").unwrap().keep();
    env.rpc().ok("session/create", &json!({"cwd": dir.canonicalize().unwrap()}))["id"].as_str().unwrap().to_string()
}

/// Two hosts on one session would both answer every prompt: twice the model
/// calls, and every file change made twice.
#[test]
fn a_second_host_for_a_session_is_refused_until_the_first_leaves() {
    let env = Env::new();
    let id = session(&env);
    let mut first = env.rpc();
    first.ok("host/register", &json!({"id": id}));
    let mut second = env.rpc();
    let refused = second.call("host/register", &json!({"id": id}));
    assert_eq!(refused["error"]["code"], RpcError::HOST_EXISTS, "{refused}");
    drop(first);
    common::wait_for("the first host's registration to lapse", Duration::from_secs(5), || {
        second.call("host/register", &json!({"id": id})).get("error").is_none()
    });
}

#[test]
fn only_the_sessions_host_may_record_or_stream_for_the_agent() {
    let env = Env::new();
    let id = session(&env);
    let mut stranger = env.rpc();
    let r = stranger.call("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
    assert_eq!(r["error"]["code"], RpcError::NOT_THE_HOST, "{r}");
    let r = stranger.call("host/stream", &json!({"id": id, "turn": 1, "text": "hi"}));
    assert_eq!(r["error"]["code"], RpcError::NOT_THE_HOST, "{r}");
    let other = session(&env);
    stranger.ok("host/register", &json!({"id": other}));
    let r = stranger.call("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
    assert_eq!(r["error"]["code"], RpcError::NOT_THE_HOST, "the host of another session: {r}");
}

/// A registration still in flight when its connection closes must not leave
/// the session looking hosted by nobody who can answer.
#[test]
fn a_host_that_disconnects_mid_registration_leaves_no_registration_behind() {
    let env = Env::new();
    let id = session(&env);
    for _ in 0..20 {
        let mut s = UnixStream::connect(env.socket()).unwrap();
        let init = json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": strive_proto::PROTOCOL_VERSION, "client": {"name": "h", "version": "0"}}});
        let register = json!({"jsonrpc": "2.0", "id": 1, "method": "host/register", "params": {"id": id}});
        s.write_all(format!("{init}\n{register}\n").as_bytes()).unwrap();
        drop(s);
    }
    let mut host = env.rpc();
    common::wait_for("the session to be free to host", Duration::from_secs(5), || {
        host.call("host/register", &json!({"id": id})).get("error").is_none()
    });
}

/// Attaching and registering at the same moment must not leave a host
/// counted as a person: approvals would wait on someone who can't answer.
#[test]
fn a_host_that_attaches_while_registering_is_never_counted_as_a_person() {
    let env = Env::new();
    for _ in 0..20 {
        let id = session(&env);
        let mut c = env.rpc();
        let attach = json!({"jsonrpc": "2.0", "id": 1, "method": "session/attach", "params": {"id": id}});
        let register = json!({"jsonrpc": "2.0", "id": 2, "method": "host/register", "params": {"id": id}});
        c.send_line(&format!("{attach}\n{register}"));
        let (first, second) = (c.next_response(), c.next_response());
        let registered = [first, second].iter().any(|r| r["id"] == 2 && r.get("result").is_some());
        if !registered {
            continue;
        }
        // Only this connection is attached. If it counted as a person, the
        // request would wait for it instead of being refused at once.
        let mut agent = env.rpc();
        agent.ok("session/approvals", &json!({"id": id, "mode": "ask"}));
        let started = std::time::Instant::now();
        let r = agent.ok(
            "effect/run",
            &json!({"id": id, "callId": "c", "request": {"kind": "write", "path": "x.txt", "content": "x"}}),
        );
        assert!(started.elapsed() < Duration::from_secs(2), "the request waited on a host");
        assert!(r["outcome"]["reason"].as_str().unwrap().contains("no client is attached"), "{r}");
    }
}

/// A host that goes away mid-turn can't end the turn, so the daemon does:
/// anyone waiting on it (strive run, say) learns it failed.
#[test]
fn a_turn_whose_host_disconnects_is_ended_as_failed() {
    let env = Env::new();
    let id = session(&env);
    let mut host = env.rpc();
    host.ok("host/register", &json!({"id": id}));
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
    drop(host);
    let mut reader = env.rpc();
    common::wait_for("the turn to be ended", Duration::from_secs(5), || {
        let r = reader.ok("session/read", &json!({"id": id}));
        r["entries"].as_array().unwrap().iter().any(|e| e["event"]["type"] == "turnEnded")
    });
    let r = reader.ok("session/read", &json!({"id": id}));
    let ended =
        r["entries"].as_array().unwrap().iter().find(|e| e["event"]["type"] == "turnEnded").unwrap()["event"].clone();
    assert_eq!(
        ended,
        json!({"type": "turnEnded", "turn": 1, "reason": {"kind": "failed", "error": "the agent host stopped during this turn"}})
    );
}

/// A host that leaves between turns leaves nothing to end.
#[test]
fn a_host_that_disconnects_between_turns_ends_nothing() {
    let env = Env::new();
    let id = session(&env);
    let mut host = env.rpc();
    host.ok("host/register", &json!({"id": id}));
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnStarted", "turn": 1}}));
    host.ok("host/record", &json!({"id": id, "event": {"type": "turnEnded", "turn": 1, "reason": {"kind": "done"}}}));
    drop(host);
    std::thread::sleep(Duration::from_millis(500));
    let r = env.rpc().ok("session/read", &json!({"id": id}));
    let ends = r["entries"].as_array().unwrap().iter().filter(|e| e["event"]["type"] == "turnEnded").count();
    assert_eq!(ends, 1);
}

/// A turn the host starts in its very last message, closing at once, is
/// still ended: the cleanup waits for the host's writes to land.
#[test]
fn a_turn_started_just_before_the_host_disconnects_is_still_ended() {
    let env = Env::new();
    let started_seen = std::cell::Cell::new(false);
    // The host hangs up at once, or a little later: from nothing waited, where
    // the daemon may see the hang-up before the record, to a few ms, where the
    // record is journaled first. Both orderings must leave no turn open, and
    // sweeping the wait makes sure each run meets the second one too.
    for attempt in 0..20u64 {
        let id = session(&env);
        let mut s = UnixStream::connect(env.socket()).unwrap();
        let init = json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
            "params": {"protocolVersion": strive_proto::PROTOCOL_VERSION, "client": {"name": "h", "version": "0"}}});
        let register = json!({"jsonrpc": "2.0", "id": 1, "method": "host/register", "params": {"id": id}});
        let start = json!({"jsonrpc": "2.0", "id": 2, "method": "host/record",
            "params": {"id": id, "event": {"type": "turnStarted", "turn": 1}}});
        s.write_all(format!("{init}\n{register}\n").as_bytes()).unwrap();
        // Registered (both replies read), so the record below is accepted.
        let mut r = std::io::BufReader::new(s.try_clone().unwrap());
        for _ in 0..2 {
            let mut line = String::new();
            std::io::BufRead::read_line(&mut r, &mut line).unwrap();
        }
        s.write_all(format!("{start}\n").as_bytes()).unwrap();
        std::thread::sleep(Duration::from_micros(attempt * 250));
        drop((r, s)); // the record may still be on its way to the journal
        std::thread::sleep(Duration::from_millis(300));
        let mut reader = env.rpc();
        let started_any = &started_seen;
        common::wait_for("an open turn to be ended", Duration::from_secs(5), || {
            let r = reader.ok("session/read", &json!({"id": id}));
            let events: Vec<&Value> = r["entries"].as_array().unwrap().iter().map(|e| &e["event"]).collect();
            let started = events.iter().any(|e| e["type"] == "turnStarted");
            started_any.set(started_any.get() || started);
            !started || events.iter().any(|e| e["type"] == "turnEnded")
        });
    }
    assert!(started_seen.get(), "some turn started, so the test tested something");
}

/// The host has no keys: model calls go through the gateway. Keys in the
/// daemon's environment stay out of the host's.
#[test]
fn a_started_host_gets_no_provider_keys() {
    let scratch = tempfile::Builder::new().prefix("strv-host-env").tempdir_in("/tmp").unwrap();
    let script = scratch.path().join("host.sh");
    let seen = scratch.path().join("env.txt");
    std::fs::write(&script, format!("env > {}.tmp && mv {0}.tmp {0}\n", seen.display())).unwrap();
    let host = format!("/bin/sh {}", script.display());
    let env = Env::with_vars(&[
        ("STRIVE_HOST", &host),
        ("ANTHROPIC_API_KEY", "sk-ant-from-the-daemon"),
        ("OPENAI_API_KEY", "sk-from-the-daemon"),
    ]);
    let id = session(&env);
    env.rpc().ok("session/prompt", &json!({"id": id, "text": "hi"}));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !seen.exists() {
        assert!(std::time::Instant::now() < deadline, "the host never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    let vars = std::fs::read_to_string(&seen).unwrap();
    assert!(vars.contains("STRIVE_SOCKET="), "it is the started host's environment: {vars}");
    assert!(!vars.contains("from-the-daemon"), "no provider key reached the host: {vars}");
}

/// Turn records say which prompts a turn took; a later host resumes from
/// them. Ones that don't fit the journal (a turn out of order, one that
/// ends a turn never started, a cutoff past the journal's end) are refused.
#[test]
fn turn_records_that_dont_fit_the_journal_are_refused() {
    let env = Env::new();
    let id = session(&env);
    let mut host = env.rpc();
    host.ok("host/register", &json!({"id": id}));
    let record = |host: &mut common::Rpc, event: Value| host.call("host/record", &json!({"id": id, "event": event}));
    let refused = [
        json!({"type": "turnEnded", "turn": 1, "reason": {"kind": "done"}}),
        json!({"type": "turnStarted", "turn": 2}),
        json!({"type": "turnStarted", "turn": 1, "throughSeq": 1_000_000}),
    ];
    for event in refused {
        let r = record(&mut host, event.clone());
        assert_eq!(r["error"]["code"], RpcError::INVALID_PARAMS, "{event} -> {r}");
    }
    assert!(record(&mut host, json!({"type": "turnStarted", "turn": 1}))["error"].is_null());
    let r = record(&mut host, json!({"type": "turnStarted", "turn": 2}));
    assert_eq!(r["error"]["code"], RpcError::INVALID_PARAMS, "a turn is open: {r}");
    let r = record(&mut host, json!({"type": "turnEnded", "turn": 7, "reason": {"kind": "done"}}));
    assert_eq!(r["error"]["code"], RpcError::INVALID_PARAMS, "not the open turn: {r}");
    assert!(record(&mut host, json!({"type": "turnEnded", "turn": 1, "reason": {"kind": "done"}}))["error"].is_null());
}

/// A host whose connection ends with bytes that aren't UTF-8 is gone like
/// any other: its turn is ended and another host may take the session.
#[test]
fn a_host_that_sends_invalid_utf8_is_cleaned_up() {
    let env = Env::new();
    let id = session(&env);
    let mut s = UnixStream::connect(env.socket()).unwrap();
    let init = json!({"jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {"protocolVersion": strive_proto::PROTOCOL_VERSION, "client": {"name": "h", "version": "0"}}});
    let register = json!({"jsonrpc": "2.0", "id": 1, "method": "host/register", "params": {"id": id}});
    let start = json!({"jsonrpc": "2.0", "id": 2, "method": "host/record",
        "params": {"id": id, "event": {"type": "turnStarted", "turn": 1}}});
    // One at a time: after the handshake, requests run concurrently, and a
    // record that overtook the registration would be refused.
    let mut r = std::io::BufReader::new(s.try_clone().unwrap());
    for message in [init, register, start] {
        s.write_all(format!("{message}\n").as_bytes()).unwrap();
        let mut line = String::new();
        std::io::BufRead::read_line(&mut r, &mut line).unwrap();
        assert!(!line.contains("\"error\""), "{line}");
    }
    s.write_all(&[0xFF, 0xFE, b'\n']).unwrap();
    let mut reader = env.rpc();
    common::wait_for("the turn to be ended", Duration::from_secs(5), || {
        let r = reader.ok("session/read", &json!({"id": id}));
        r["entries"].as_array().unwrap().iter().any(|e| e["event"]["type"] == "turnEnded")
    });
    common::wait_for("the session to take a new host", Duration::from_secs(5), || {
        env.rpc().call("host/register", &json!({"id": id}))["error"].is_null()
    });
    drop((r, s));
}
