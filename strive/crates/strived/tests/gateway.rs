//! The model gateway end to end: the real daemon in front of a fake provider
//! (the one boundary where a stand-in is the point), with real HTTP.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]

mod common;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use common::Env;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

const BODY: &str = r#"{"model":"claude-haiku-4-5","max_tokens":100,"messages":[{"role":"user","content":"hi"}]}"#;

const ANTHROPIC_JSON: &str = r#"{"id":"msg_01","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[{"type":"text","text":"Hi"}],"usage":{"input_tokens":12,"cache_creation_input_tokens":100,"cache_read_input_tokens":2000,"output_tokens":7}}"#;

const SSE: &[&str] = &[
    "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":25,\"cache_read_input_tokens\":1000,\"output_tokens\":1}}}\n\n",
    "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
    "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":15}}\n\n",
    "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
];

#[derive(Clone)]
enum Reply {
    Json(u16, String),
    /// Events, a delay before each, and whether the stream ends before the last one.
    Sse(Vec<String>, u64, bool),
    Hang,
    /// Events at once, then the stream stays open this long before it ends.
    SseThenStall(Vec<String>, u64),
    /// A 307 to this URL.
    Redirect(String),
}

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct Upstream {
    addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Upstream {
    fn start(reply: Reply) -> Self {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let reply = Arc::new(Mutex::new(reply));
        let (tx, rx) = std::sync::mpsc::channel();
        let (s, r) = (seen.clone(), reply.clone());
        std::thread::spawn(move || {
            tokio::runtime::Runtime::new().unwrap().block_on(async move {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                tx.send(listener.local_addr().unwrap()).unwrap();
                let app = axum::Router::new().fallback(move |uri: axum::http::Uri, headers: HeaderMap, body: Bytes| {
                    let (s, r) = (s.clone(), r.clone());
                    async move {
                        s.lock().unwrap().push(Seen {
                            path: uri.path().to_string(),
                            headers: headers
                                .iter()
                                .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                                .collect(),
                            body: body.to_vec(),
                        });
                        let reply = r.lock().unwrap().clone();
                        respond(reply).await
                    }
                });
                let app = app.layer(axum::extract::DefaultBodyLimit::disable());
                axum::serve(listener, app).await.unwrap();
            });
        });
        Self { addr: rx.recv().unwrap(), seen }
    }
    fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

async fn respond(reply: Reply) -> Response {
    match reply {
        Reply::Json(status, body) => Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .header("request-id", "req_fake")
            .header("anthropic-ratelimit-requests-remaining", "49")
            .header("openai-processing-ms", "12")
            .header("x-ratelimit-limit-requests", "50")
            .header("set-cookie", "session=upstream-secret")
            .header("x-internal-trace", "upstream-detail")
            .body(Body::from(body))
            .unwrap(),
        Reply::Sse(events, delay_ms, cut) => {
            let n = if cut { events.len() - 1 } else { events.len() };
            let stream = futures_util::stream::iter(events.into_iter().take(n)).then(move |e| async move {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                Ok::<_, std::io::Error>(Bytes::from(e))
            });
            Response::builder()
                .status(200)
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream))
                .unwrap()
        }
        Reply::SseThenStall(events, stall_ms) => {
            let stall = futures_util::stream::once(async move {
                tokio::time::sleep(Duration::from_millis(stall_ms)).await;
                Ok::<_, std::io::Error>(Bytes::new())
            });
            let stream = futures_util::stream::iter(events.into_iter().map(|e| Ok(Bytes::from(e)))).chain(stall);
            Response::builder()
                .status(200)
                .header("content-type", "text/event-stream")
                .body(Body::from_stream(stream))
                .unwrap()
        }
        Reply::Hang => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            Response::builder().status(StatusCode::OK).body(Body::empty()).unwrap()
        }
        Reply::Redirect(to) => Response::builder().status(307).header("location", to).body(Body::empty()).unwrap(),
    }
}

use futures_util::StreamExt as _;

struct Setup {
    env: Env,
    upstream: Upstream,
    id: String,
    base: String,
    rt: tokio::runtime::Runtime,
}

fn setup(reply: Reply, extra: &[(&str, &str)]) -> Setup {
    let upstream = Upstream::start(reply);
    let url = upstream.url();
    let mut vars = vec![("STRIVE_UPSTREAM_ANTHROPIC", url.as_str()), ("STRIVE_UPSTREAM_OPENAI", url.as_str())];
    vars.extend_from_slice(extra);
    let env = Env::with_vars(&vars);
    let mut c = env.rpc();
    let id = c.ok("session/create", &json!({"cwd": "/tmp/repo"}))["id"].as_str().unwrap().to_string();
    let base = c.ok("session/gateway", &json!({"id": id}))["anthropic"].as_str().unwrap().to_string();
    Setup { env, upstream, id, base, rt: tokio::runtime::Runtime::new().unwrap() }
}

impl Setup {
    fn post(&self, url: &str, body: &str) -> (u16, Vec<u8>) {
        self.rt.block_on(async {
            let r = reqwest::Client::new()
                .post(url)
                .header("x-api-key", "dummy-from-the-agent")
                .header("authorization", "Bearer dummy-from-the-agent")
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .unwrap();
            (r.status().as_u16(), r.bytes().await.unwrap().to_vec())
        })
    }
    /// Sends a request and gives up on it (dropping the connection) once the
    /// gateway has journaled the call's start. A fixed wait can end, under
    /// load, before the request reaches the gateway: then there's no call
    /// to close.
    fn leave_once_started<F: std::future::Future>(&self, send: F) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        self.rt.block_on(async {
            tokio::pin!(send);
            loop {
                tokio::select! {
                    _ = &mut send => return,
                    () = tokio::time::sleep(Duration::from_millis(50)) => {
                        if self.count("modelCallStarted") == 1 {
                            return;
                        }
                        assert!(std::time::Instant::now() < deadline, "the call never started");
                    }
                }
            }
        });
    }
    fn messages(&self, body: &str) -> (u16, Vec<u8>) {
        self.post(&format!("{}/v1/messages", self.base), body)
    }
    fn entries(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        assert_eq!(r.get("problem"), None, "{r}");
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
    }
    /// The most recent entry of a type (`modelCallStarted`, ...).
    fn last(&self, kind: &str) -> Value {
        self.entries().into_iter().rev().find(|e| e["type"] == kind).unwrap_or_else(|| panic!("no {kind} entry"))
    }
    fn count(&self, kind: &str) -> usize {
        self.entries().iter().filter(|e| e["type"] == kind).count()
    }
    fn blob(&self, digest: &Value) -> Vec<u8> {
        let hex = digest.as_str().unwrap().strip_prefix("sha256:").unwrap();
        std::fs::read(self.env.home.path().join("cas/sha256").join(&hex[..2]).join(&hex[2..])).unwrap()
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

fn error_message(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body).unwrap()["error"]["message"].as_str().unwrap().to_string()
}

#[test]
fn a_call_is_forwarded_with_the_real_key_metered_and_journaled() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "sk-real-test")]);
    let (status, body) = s.messages(BODY);
    assert_eq!((status, body.as_slice()), (200, ANTHROPIC_JSON.as_bytes()));

    let seen = s.upstream.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].path, "/v1/messages");
    assert_eq!(seen[0].headers["x-api-key"], "sk-real-test", "the agent's key is replaced");
    assert_eq!(seen[0].headers.get("authorization"), None, "no other credentials are forwarded");
    assert_eq!(seen[0].headers["anthropic-version"], "2023-06-01");
    assert_eq!(seen[0].body, BODY.as_bytes());

    assert_eq!((s.count("modelCallStarted"), s.count("modelCallFinished")), (1, 1));
    let started = s.last("modelCallStarted");
    assert_eq!(
        started,
        json!({"type": "modelCallStarted", "call": 1, "provider": "anthropic", "model": "claude-haiku-4-5",
               "request": sha(BODY.as_bytes()), "reservedUsdMicros": 589, "reservedTokens": 189})
    );
    let mut finished = s.last("modelCallFinished");
    assert!(finished["durationMs"].as_u64().is_some());
    finished.as_object_mut().unwrap().remove("durationMs");
    assert_eq!(
        finished,
        json!({"type": "modelCallFinished", "call": 1, "response": sha(ANTHROPIC_JSON.as_bytes()),
               "outcome": {"kind": "complete", "status": 200,
                           "usage": {"input": 12, "output": 7, "cacheWrite": 100, "cacheWriteLong": 0, "cacheRead": 2000},
                           "costUsdMicros": 12 + 35 + 125 + 200}})
    );
    assert_eq!(s.blob(&started["request"]), BODY.as_bytes(), "the exact request bytes are stored");
    assert_eq!(
        s.blob(&s.last("modelCallFinished")["response"]),
        ANTHROPIC_JSON.as_bytes(),
        "the exact response bytes are stored"
    );
}

#[test]
fn a_stream_passes_through_unchanged_and_is_metered() {
    let s = setup(Reply::Sse(SSE.iter().map(|e| (*e).to_string()).collect(), 5, false), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(&BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"));
    assert_eq!((status, String::from_utf8(body).unwrap()), (200, SSE.concat()));
    let finished = s.last("modelCallFinished");
    assert_eq!(
        finished["outcome"],
        json!({"kind": "complete", "status": 200, "usage": {"input": 25, "output": 15, "cacheWrite": 0, "cacheWriteLong": 0, "cacheRead": 1000},
               "costUsdMicros": 25 + 75 + 100})
    );
    assert_eq!(s.blob(&finished["response"]), SSE.concat().as_bytes());
}

#[test]
fn a_call_that_would_exceed_the_budget_is_refused_before_it_is_sent() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    s.env.rpc().ok("session/budget", &json!({"id": s.id, "usdMicros": 100}));
    let (status, body) = s.messages(BODY);
    assert_eq!(status, 402);
    assert_eq!(
        error_message(&body),
        "strive: this call could cost up to $0.0006, but only $0.0001 of the $0.0001 session budget is left"
    );
    assert_eq!(s.upstream.seen().len(), 0);
    let e = s.entries();
    assert_eq!(e.last().unwrap(), &json!({"type": "budgetSet", "usdMicros": 100}));
}

#[test]
fn settled_calls_free_their_hold_for_later_calls() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    // Each call holds 589 and costs 372. With 961, the second call fits
    // (372 spent + 589 held = 961) only because the first call's hold was
    // replaced by its actual cost; a third doesn't (744 + 589 > 961).
    s.env.rpc().ok("session/budget", &json!({"id": s.id, "usdMicros": 961}));
    assert_eq!(s.messages(BODY).0, 200);
    assert_eq!(s.messages(BODY).0, 200);
    assert_eq!(s.messages(BODY).0, 402);
}

#[test]
fn a_model_without_a_price_is_refused_and_settings_can_price_it() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(&BODY.replace("claude-haiku-4-5", "claude-mystery-1"));
    assert_eq!(status, 400);
    assert_eq!(
        error_message(&body),
        "strive: no price is known for claude-mystery-1, so its cost can't be bounded; add it under \"models\" in ~/.strive/settings.json"
    );
    assert_eq!(s.upstream.seen().len(), 0);

    std::fs::write(
        s.env.home.path().join("settings.json"),
        r#"{"models": {"claude-mystery-1": {"input": 2, "output": 4, "contextWindow": 1000, "maxOutput": 100}}}"#,
    )
    .unwrap();
    s.env.stop();
    let base = s.env.rpc().ok("session/gateway", &json!({"id": s.id}))["anthropic"].as_str().unwrap().to_string();
    let (status, _) = s.post(&format!("{base}/v1/messages"), &BODY.replace("claude-haiku-4-5", "claude-mystery-1"));
    assert_eq!(status, 200);
    // No cache rates were configured, so the response's cache tokens cost the
    // conservative defaults: writes at 1.25x input, reads at full input.
    assert_eq!(s.last("modelCallFinished")["outcome"]["costUsdMicros"], 12 * 2 + 7 * 4 + 100 * 5 / 2 + 2000 * 2);
}

#[test]
fn an_unknown_token_is_refused() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let forged = s.base.replace(&s.base[s.base.len() - 74..s.base.len() - 10], &"0".repeat(64));
    let (status, body) = s.post(&format!("{forged}/v1/messages"), BODY);
    assert_eq!((status, error_message(&body)), (401, "strive: unknown gateway token".to_string()));
    assert_eq!(s.upstream.seen().len(), 0);
}

#[test]
fn a_provider_error_is_passed_through_and_costs_nothing() {
    let err = r#"{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}"#;
    let s = setup(Reply::Json(429, err.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(BODY);
    assert_eq!((status, body.as_slice()), (429, err.as_bytes()));
    assert_eq!(s.last("modelCallFinished")["outcome"], json!({"kind": "rejected", "status": 429}));
}

#[test]
fn a_stream_that_ends_before_its_usage_is_charged_its_hold() {
    let s =
        setup(Reply::Sse(SSE[..3].iter().map(|e| (*e).to_string()).collect(), 5, true), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(&BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"));
    assert_eq!((status, String::from_utf8(body).unwrap()), (200, SSE[..2].concat()));
    assert_eq!(
        s.last("modelCallFinished")["outcome"],
        json!({"kind": "broken", "reason": "the response ended without reporting usage", "costUsdMicros": 603, "tokens": 203})
    );
}

#[test]
fn a_client_that_leaves_mid_stream_is_charged_its_hold() {
    let events: Vec<String> = std::iter::repeat_n(SSE[1].to_string(), 50).collect();
    let s = setup(Reply::Sse(events, 50, false), &[("ANTHROPIC_API_KEY", "k")]);
    let url = format!("{}/v1/messages", s.base);
    s.rt.block_on(async {
        let mut r = reqwest::Client::new()
            .post(url)
            .body(BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"))
            .send()
            .await
            .unwrap();
        let first = r.chunk().await.unwrap().unwrap();
        assert!(first.starts_with(b"event: content_block_delta"));
    });
    common::wait_for("the call to be closed", Duration::from_secs(10), || s.count("modelCallFinished") == 1);
    let outcome = &s.last("modelCallFinished")["outcome"];
    assert_eq!(outcome["kind"], "broken");
    assert_eq!(outcome["reason"], "the client disconnected mid-response");
}

#[test]
fn a_call_cut_off_by_a_daemon_crash_is_closed_and_charged_on_restart() {
    let s = setup(Reply::Hang, &[("ANTHROPIC_API_KEY", "k")]);
    let url = format!("{}/v1/messages", s.base);
    let body = BODY.to_string();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _ = rt.block_on(reqwest::Client::new().post(url).body(body).send());
    });
    common::wait_for("the call to start", Duration::from_secs(5), || s.count("modelCallStarted") == 1);
    let pid = common::pid(&s.env.status());
    assert!(std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap().success());
    common::wait_for("the daemon to die", Duration::from_secs(5), || {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().is_ok_and(|s| !s.success())
    });

    s.env.rpc().ok("session/attach", &json!({"id": s.id}));
    assert_eq!(s.count("modelCallFinished"), 1);
    assert_eq!(
        s.last("modelCallFinished")["outcome"],
        json!({"kind": "broken", "reason": "the daemon stopped during this call", "costUsdMicros": 589, "tokens": 189})
    );
}

#[test]
fn keys_set_with_auth_are_used_and_stored_privately() {
    use std::os::unix::fs::PermissionsExt;
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[]);
    let (status, body) = s.messages(BODY);
    assert_eq!(
        (status, error_message(&body)),
        (401, "strive: no anthropic API key; run `strive auth anthropic`".into())
    );

    let mut c = s.env.rpc();
    assert_eq!(c.ok("auth/status", &json!({}))["providers"][0], json!({"provider": "anthropic", "source": "none"}));
    c.ok("auth/set", &json!({"provider": "anthropic", "apiKey": " sk-from-auth \n"}));
    assert_eq!(c.ok("auth/status", &json!({}))["providers"][0], json!({"provider": "anthropic", "source": "file"}));
    assert_eq!(s.messages(BODY).0, 200);
    assert_eq!(s.upstream.seen()[0].headers["x-api-key"], "sk-from-auth");
    let file = s.env.home.path().join("credentials.json");
    assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);

    s.env.stop();
    s.env.status();
    let base = s.env.rpc().ok("session/gateway", &json!({"id": s.id}))["anthropic"].as_str().unwrap().to_string();
    assert_eq!(s.post(&format!("{base}/v1/messages"), BODY).0, 200, "the stored key survives a restart");
    let mut c = s.env.rpc();
    assert_eq!(c.call("auth/set", &json!({"provider": "nope", "apiKey": "x"}))["error"]["code"], -32602);
    assert_eq!(c.call("auth/set", &json!({"provider": "openai", "apiKey": "  "}))["error"]["code"], -32602);
}

#[test]
fn streaming_openai_chat_is_made_to_report_usage() {
    let chunks = vec![
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n".to_string(),
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":9,\"prompt_tokens_details\":{\"cached_tokens\":0}}}\n\n".to_string(),
        "data: [DONE]\n\n".to_string(),
    ];
    let s = setup(Reply::Sse(chunks, 1, false), &[("OPENAI_API_KEY", "sk-openai-test")]);
    let base = s.env.rpc().ok("session/gateway", &json!({"id": s.id}))["openai"].as_str().unwrap().to_string();
    let body = r#"{"model":"gpt-4.1-mini","stream":true,"max_tokens":50,"messages":[{"role":"user","content":"hi"}]}"#;
    let (status, _) = s.post(&format!("{base}/chat/completions"), body);
    assert_eq!(status, 200);
    let seen = &s.upstream.seen()[0];
    assert_eq!(seen.path, "/v1/chat/completions");
    assert_eq!(seen.headers["authorization"], "Bearer sk-openai-test");
    assert_eq!(seen.headers.get("x-api-key"), None);
    let sent: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(sent["stream_options"], json!({"include_usage": true}));
    assert_eq!(
        s.last("modelCallFinished")["outcome"]["usage"],
        json!({"input": 50, "output": 9, "cacheWrite": 0, "cacheWriteLong": 0, "cacheRead": 0})
    );
}

#[test]
fn invalid_settings_stop_the_daemon_with_the_reason() {
    let env = Env::new();
    std::fs::create_dir_all(env.home.path()).unwrap();
    std::fs::write(env.home.path().join("settings.json"), r#"{"budget": {"usd": 5, "dollars": 3}}"#).unwrap();
    let out = env.strive(&["status"]);
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(err.contains("the daemon failed to start: reading"), "{err}");
    assert!(err.contains("unknown field `dollars`"), "{err}");
}

/// Guards the harness itself: a test daemon never inherits the developer's
/// provider keys, so no test can spend real money. (This caught a real leak.)
#[test]
fn test_daemons_hold_no_keys_from_the_developers_shell() {
    let env = Env::new();
    let status = env.rpc().ok("auth/status", &json!({}));
    assert_eq!(
        status["providers"],
        json!([{"provider": "anthropic", "source": "none"}, {"provider": "openai", "source": "none"}])
    );
}

/// A full large-context request is several megabytes (a million-token
/// context is roughly 4 MB); the gateway must forward it, not refuse it.
#[test]
fn a_multi_megabyte_request_is_forwarded() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let big = "x".repeat(5 * 1024 * 1024);
    let body = BODY.replace("\"content\":\"hi\"", &format!("\"content\":\"{big}\""));
    let (status, _) = s.messages(&body);
    assert_eq!(status, 200);
    assert_eq!(s.upstream.seen()[0].body.len(), body.len());
}

/// Each session's calls are billed and journaled in that session only.
#[test]
fn each_session_gets_its_own_gateway_token() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let mut c = s.env.rpc();
    let other = c.ok("session/create", &json!({"cwd": "/tmp/other"}))["id"].as_str().unwrap().to_string();
    let other_base = c.ok("session/gateway", &json!({"id": other}))["anthropic"].as_str().unwrap().to_string();
    assert_ne!(other_base, s.base);
    assert_eq!(
        c.ok("session/gateway", &json!({"id": s.id}))["anthropic"].as_str().unwrap(),
        s.base,
        "stable per session"
    );

    assert_eq!(s.post(&format!("{other_base}/v1/messages"), BODY).0, 200);
    assert_eq!(s.count("modelCallStarted"), 0, "nothing was journaled in the first session");
    let r = c.ok("session/read", &json!({"id": other}));
    let calls = r["entries"].as_array().unwrap().iter().filter(|e| e["event"]["type"] == "modelCallFinished").count();
    assert_eq!(calls, 1);
}

/// Provider metadata an SDK uses (request ids, rate limits) reaches the
/// client; anything else from upstream (cookies, internal headers) doesn't.
#[test]
fn only_provider_metadata_headers_are_passed_back() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let url = format!("{}/v1/messages", s.base);
    let headers = s.rt.block_on(async {
        let r = reqwest::Client::new().post(url).body(BODY).send().await.unwrap();
        r.headers().clone()
    });
    let get = |k: &str| headers.get(k).map(|v| v.to_str().unwrap().to_string());
    assert_eq!(get("content-type").as_deref(), Some("application/json"));
    assert_eq!(get("request-id").as_deref(), Some("req_fake"));
    assert_eq!(get("anthropic-ratelimit-requests-remaining").as_deref(), Some("49"));
    assert_eq!(get("openai-processing-ms").as_deref(), Some("12"));
    assert_eq!(get("x-ratelimit-limit-requests").as_deref(), Some("50"));
    assert_eq!(get("set-cookie"), None);
    assert_eq!(get("x-internal-trace"), None);
}

/// Call numbers pair starts with finishes, so they must never repeat in a
/// session, within one daemon run or across restarts.
#[test]
fn call_numbers_continue_across_calls_and_restarts() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    assert_eq!(s.messages(BODY).0, 200);
    assert_eq!(s.messages(BODY).0, 200);
    s.env.stop();
    let base = s.env.rpc().ok("session/gateway", &json!({"id": s.id}))["anthropic"].as_str().unwrap().to_string();
    assert_eq!(s.post(&format!("{base}/v1/messages"), BODY).0, 200);
    let calls: Vec<(String, u64)> = s
        .entries()
        .iter()
        .filter_map(|e| e.get("call").map(|c| (e["type"].as_str().unwrap().to_string(), c.as_u64().unwrap())))
        .collect();
    let expected: Vec<(String, u64)> = [1, 2, 3]
        .iter()
        .flat_map(|&n| [("modelCallStarted".to_string(), n), ("modelCallFinished".to_string(), n)])
        .collect();
    assert_eq!(calls, expected);
}

#[test]
fn gateway_urls_are_only_issued_for_real_sessions() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    let r = s.env.rpc().call("session/gateway", &json!({"id": "01J8ZZZZZZZZZZZZZZZZZZZZZZ"}));
    assert_eq!(r["error"]["code"], -32010);
}

fn blob_count(env: &Env) -> usize {
    let root = env.home.path().join("cas/sha256");
    std::fs::read_dir(&root)
        .map_or(0, |d| d.map(|e| std::fs::read_dir(e.unwrap().path()).map_or(0, std::iter::Iterator::count)).sum())
}

#[test]
fn a_call_refused_for_budget_stores_nothing() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.into()), &[("ANTHROPIC_API_KEY", "k")]);
    s.env.rpc().ok("session/budget", &json!({"id": s.id, "usdMicros": 1}));
    let before = blob_count(&s.env);
    assert_eq!(s.messages(&BODY.replace("hi", "a distinct body")).0, 402);
    assert_eq!(blob_count(&s.env), before);
}

/// A redirect would resend the request, with the daemon's key, to wherever
/// the provider points; the gateway never follows one.
#[test]
fn redirects_are_not_followed() {
    let elsewhere = Upstream::start(Reply::Json(200, ANTHROPIC_JSON.into()));
    let target = format!("{}/v1/messages", elsewhere.url());
    let s = setup(Reply::Redirect(target), &[("ANTHROPIC_API_KEY", "sk-must-stay-home")]);
    let (status, _) = s.messages(BODY);
    assert_eq!(status, 307);
    assert_eq!(elsewhere.seen().len(), 0, "the redirect target never saw the request or the key");
    assert_eq!(s.last("modelCallFinished")["outcome"], json!({"kind": "rejected", "status": 307}));
}

#[test]
fn a_response_past_the_size_limit_is_cut_off_and_charged_its_hold() {
    let chunk = format!(": {}\n\n", "p".repeat(1024 * 1024));
    let events: Vec<String> = std::iter::repeat_n(chunk, 66).collect();
    let s = setup(Reply::Sse(events, 0, false), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(&BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"));
    assert_eq!(status, 200);
    assert!(body.len() <= 65 * 1024 * 1024, "{}", body.len());
    let outcome = s.last("modelCallFinished")["outcome"].clone();
    assert_eq!(
        outcome,
        json!({"kind": "broken", "reason": "the response exceeded 64 MiB", "costUsdMicros": 603, "tokens": 203})
    );
}

#[test]
fn a_client_that_leaves_before_the_response_starts_closes_the_call() {
    let s = setup(Reply::Hang, &[("ANTHROPIC_API_KEY", "k")]);
    let url = format!("{}/v1/messages", s.base);
    s.leave_once_started(reqwest::Client::new().post(url).body(BODY).send());
    common::wait_for("the call to be closed", Duration::from_secs(5), || s.count("modelCallFinished") == 1);
    assert_eq!(s.last("modelCallFinished")["outcome"]["reason"], "the client disconnected before the response began");
}

#[test]
fn a_client_that_leaves_while_the_provider_stalls_closes_the_call() {
    let events = vec![SSE[0].to_string(), SSE[1].to_string()];
    let s = setup(Reply::Sse(events, 20_000, false), &[("ANTHROPIC_API_KEY", "k")]);
    s.leave_once_started(
        reqwest::Client::new()
            .post(format!("{}/v1/messages", s.base))
            .body(BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"))
            .send(),
    );
    common::wait_for("the call to be closed", Duration::from_secs(5), || s.count("modelCallFinished") == 1);
    let reason = s.last("modelCallFinished")["outcome"]["reason"].clone();
    assert!(
        reason == "the client disconnected before the response began"
            || reason == "the client disconnected mid-response",
        "{reason}"
    );
}

#[test]
fn a_provider_that_goes_quiet_is_cut_off() {
    let events = vec![SSE[0].to_string(), SSE[1].to_string()];
    let s = setup(Reply::Sse(events, 5_000, false), &[("ANTHROPIC_API_KEY", "k")]);
    std::fs::write(s.env.home.path().join("settings.json"), r#"{"gateway": {"streamIdleSecs": 1}}"#).unwrap();
    s.env.stop();
    let base = s.env.rpc().ok("session/gateway", &json!({"id": s.id}))["anthropic"].as_str().unwrap().to_string();
    let started = std::time::Instant::now();
    let (status, _) = s.post(
        &format!("{base}/v1/messages"),
        &BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"),
    );
    assert_eq!(status, 200);
    assert!(started.elapsed() < Duration::from_secs(4), "cut off after 1 s of silence, not after the 5 s wait");
    assert_eq!(s.last("modelCallFinished")["outcome"]["reason"], "the provider sent nothing for 1s");
}

/// A finish that arrives after the call was already closed (say, by a
/// writer restart) must not journal or charge it a second time.
#[test]
fn a_call_is_finished_and_charged_once_even_across_a_writer_restart() {
    use std::os::unix::fs::PermissionsExt;
    let s =
        setup(Reply::Sse(SSE.iter().map(|e| (*e).to_string()).collect(), 600, false), &[("ANTHROPIC_API_KEY", "k")]);
    let url = format!("{}/v1/messages", s.base);
    let body = BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true");
    let (in_flight, streaming) = std::sync::mpsc::channel();
    let call = std::thread::spawn(move || {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let r = reqwest::Client::new().post(url).body(body).send().await.unwrap();
            in_flight.send(r.status()).unwrap();
            r.bytes().await.unwrap().len()
        })
    });
    // Response headers mean the start's commit finished and was reported.
    // Seeing it on disk isn't enough: the head is renamed into place before
    // the directory is synced, and a sync that fails reports the commit
    // failed, which (correctly) refuses the call.
    let status = streaming.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(status, 200);
    let dir = s.env.session_dir(&s.id);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = s.env.rpc().call("session/prompt", &json!({"id": s.id, "text": "breaks the writer"}));
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(failed.get("error").is_some(), "{failed}");
    let got = call.join().unwrap();
    assert!(got > 0);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while s.count("modelCallFinished") == 0 {
        if std::time::Instant::now() > deadline {
            let kinds: Vec<Value> = s.entries().iter().map(|e| e["type"].clone()).collect();
            let log = std::fs::read_to_string(s.env.home.path().join("logs/strived.log")).unwrap_or_default();
            panic!("the call was never closed.\nentries: {kinds:?}\ndaemon log:\n{log}");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(s.count("modelCallFinished"), 1, "{:?}", s.entries());
}

/// Model calls are activity: the daemon doesn't idle out under an agent
/// that only talks to the gateway.
#[test]
fn gateway_traffic_keeps_the_daemon_alive() {
    let events: Vec<String> = SSE.iter().map(|e| (*e).to_string()).collect();
    let s = setup(Reply::Sse(events, 700, false), &[("ANTHROPIC_API_KEY", "k"), ("STRIVE_IDLE_SECS", "1")]);
    let (status, _) = s.messages(&BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"));
    assert_eq!(status, 200, "a 2.8 s call through a daemon that idles out after 1 s");
    assert_eq!(s.count("modelCallFinished"), 1);
}

/// SDKs stop at a stream's last event (`[DONE]`, `message_stop`) without
/// waiting for the connection to close. So that event reaches the client
/// only once the journal records how the call ended.
#[test]
fn a_streams_last_event_arrives_only_after_the_call_is_journaled() {
    let openai = vec![
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\n".to_string(),
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":9}}\n\n".to_string(),
        "data: [DONE]\n\n".to_string(),
    ];
    let cases = [
        (
            "openai",
            "/chat/completions",
            r#"{"model":"gpt-4.1-mini","stream":true,"max_tokens":50,"messages":[]}"#,
            openai,
            "data: [DONE]",
        ),
        ("anthropic", "/v1/messages", "", SSE.iter().map(|e| (*e).to_string()).collect(), "event: message_stop"),
    ];
    for (provider, path, body, events, last) in cases {
        let s = setup(Reply::SseThenStall(events, 1500), &[("OPENAI_API_KEY", "k"), ("ANTHROPIC_API_KEY", "k")]);
        let base = s.env.rpc().ok("session/gateway", &json!({"id": s.id}))[provider].as_str().unwrap().to_string();
        let body = if body.is_empty() {
            BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true")
        } else {
            body.to_string()
        };
        s.rt.block_on(async {
            let mut r = reqwest::Client::new().post(format!("{base}{path}")).body(body).send().await.unwrap();
            let mut got = Vec::new();
            while !String::from_utf8_lossy(&got).contains(last) {
                got.extend_from_slice(&r.chunk().await.unwrap().expect("the stream ended before its last event"));
            }
        });
        assert_eq!(s.count("modelCallFinished"), 1, "{provider}: journaled before the client saw {last}");
        assert_eq!(s.last("modelCallFinished")["outcome"]["kind"], "complete", "{provider}");
    }
}

#[test]
fn a_call_asking_for_long_context_pricing_is_refused_before_it_is_sent() {
    let s = setup(Reply::Json(200, ANTHROPIC_JSON.to_string()), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.rt.block_on(async {
        let r = reqwest::Client::new()
            .post(format!("{}/v1/messages", s.base))
            .header("anthropic-beta", "context-1m-2025-08-07")
            .body(BODY)
            .send()
            .await
            .unwrap();
        (r.status().as_u16(), r.bytes().await.unwrap().to_vec())
    });
    assert_eq!(status, 400);
    assert!(error_message(&body).contains("long context"), "{}", String::from_utf8_lossy(&body));
    assert!(s.upstream.seen().is_empty(), "nothing reached the provider");
    assert_eq!(s.count("modelCallStarted"), 0);
}
