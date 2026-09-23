//! The model gateway end to end: the real daemon in front of a fake provider
//! (the one boundary where a stand-in is the point), with real HTTP.

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
        Reply::Hang => {
            tokio::time::sleep(Duration::from_secs(3600)).await;
            Response::builder().status(StatusCode::OK).body(Body::empty()).unwrap()
        }
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
    fn messages(&self, body: &str) -> (u16, Vec<u8>) {
        self.post(&format!("{}/v1/messages", self.base), body)
    }
    fn entries(&self) -> Vec<Value> {
        let r = self.env.rpc().ok("session/read", &json!({"id": self.id}));
        assert_eq!(r.get("problem"), None, "{r}");
        r["entries"].as_array().unwrap().iter().map(|e| e["event"].clone()).collect()
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

    let e = s.entries();
    assert_eq!(e.len(), 4);
    assert_eq!(
        e[2],
        json!({"type": "modelCallStarted", "call": 1, "provider": "anthropic", "model": "claude-haiku-4-5",
               "request": sha(BODY.as_bytes()), "reservedUsdMicros": 589, "reservedTokens": 189})
    );
    let mut finished = e[3].clone();
    assert!(finished["durationMs"].as_u64().is_some());
    finished.as_object_mut().unwrap().remove("durationMs");
    assert_eq!(
        finished,
        json!({"type": "modelCallFinished", "call": 1, "response": sha(ANTHROPIC_JSON.as_bytes()),
               "outcome": {"kind": "complete", "status": 200,
                           "usage": {"input": 12, "output": 7, "cacheWrite": 100, "cacheRead": 2000},
                           "costUsdMicros": 12 + 35 + 125 + 200}})
    );
    assert_eq!(s.blob(&e[2]["request"]), BODY.as_bytes(), "the exact request bytes are stored");
    assert_eq!(s.blob(&e[3]["response"]), ANTHROPIC_JSON.as_bytes(), "the exact response bytes are stored");
}

#[test]
fn a_stream_passes_through_unchanged_and_is_metered() {
    let s = setup(Reply::Sse(SSE.iter().map(|e| (*e).to_string()).collect(), 5, false), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(&BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"));
    assert_eq!((status, String::from_utf8(body).unwrap()), (200, SSE.concat()));
    let e = s.entries();
    assert_eq!(
        e[3]["outcome"],
        json!({"kind": "complete", "status": 200, "usage": {"input": 25, "output": 15, "cacheWrite": 0, "cacheRead": 1000},
               "costUsdMicros": 25 + 75 + 100})
    );
    assert_eq!(s.blob(&e[3]["response"]), SSE.concat().as_bytes());
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
    assert_eq!(s.entries().last().unwrap()["outcome"]["costUsdMicros"], 12 * 2 + 7 * 4);
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
    assert_eq!(s.entries()[3]["outcome"], json!({"kind": "rejected", "status": 429}));
}

#[test]
fn a_stream_that_ends_before_its_usage_is_charged_its_hold() {
    let s =
        setup(Reply::Sse(SSE[..3].iter().map(|e| (*e).to_string()).collect(), 5, true), &[("ANTHROPIC_API_KEY", "k")]);
    let (status, body) = s.messages(&BODY.replace("\"max_tokens\":100", "\"max_tokens\":100,\"stream\":true"));
    assert_eq!((status, String::from_utf8(body).unwrap()), (200, SSE[..2].concat()));
    assert_eq!(
        s.entries()[3]["outcome"],
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
    common::wait_for("the call to be closed", Duration::from_secs(10), || s.entries().len() == 4);
    let outcome = &s.entries()[3]["outcome"];
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
    common::wait_for("the call to start", Duration::from_secs(5), || s.entries().len() == 3);
    let pid = common::pid(&s.env.status());
    assert!(std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap().success());
    common::wait_for("the daemon to die", Duration::from_secs(5), || {
        std::process::Command::new("kill").args(["-0", &pid.to_string()]).status().is_ok_and(|s| !s.success())
    });

    s.env.rpc().ok("session/attach", &json!({"id": s.id}));
    let e = s.entries();
    assert_eq!(e.len(), 4);
    assert_eq!(
        e[3]["outcome"],
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
    assert_eq!(s.entries()[3]["outcome"]["usage"], json!({"input": 50, "output": 9, "cacheWrite": 0, "cacheRead": 0}));
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
