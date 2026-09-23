//! Agent hosts: one per session, and only it speaks for the agent.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::io::Write;
use std::os::unix::net::UnixStream;
use std::time::Duration;

use common::Env;
use serde_json::json;
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
