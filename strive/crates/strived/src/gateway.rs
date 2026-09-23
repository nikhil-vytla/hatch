//! The model gateway: a loopback HTTP proxy every model call goes through.
//!
//! A session's agent gets base URLs containing a secret token for that
//! session. For each request the gateway reads what it asks for, refuses it
//! if its worst-case cost doesn't fit the budget (or the model has no known
//! price), stores the exact request bytes, journals the call as started,
//! forwards it with the provider key only the daemon holds, streams the
//! response back while metering it, stores the response bytes and journals
//! how the call ended. Every started call is finished exactly once, whatever
//! happens: a completed response, a provider refusal, a broken stream or a
//! client that went away.

use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Path, State as AxumState};
use axum::http::{HeaderMap, HeaderName, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::StreamExt;
use serde_json::json;
use strive_budget::{Reservation, cost};
use strive_gateway::{Api, UsageMeter, prepare_request};
use strive_proto::{CallOutcome, GatewayInfo};
use tokio::sync::mpsc;

use crate::server::State;
use crate::sessions::{CallError, CallStart, SessionId};

const MAX_BODY: usize = 64 * 1024 * 1024;
const FORWARDED_REQUEST_HEADERS: &[&str] =
    &["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"];

pub struct Gateway {
    addr: SocketAddr,
    tokens: Mutex<HashMap<String, SessionId>>,
    http: reqwest::Client,
}

impl Gateway {
    pub async fn bind() -> anyhow::Result<(Self, tokio::net::TcpListener)> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let http = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(10)).build()?;
        Ok((Self { addr: listener.local_addr()?, tokens: Mutex::new(HashMap::new()), http }, listener))
    }

    /// Base URLs for a session's agent, minting its token on first use.
    pub fn info(&self, id: &SessionId) -> std::io::Result<GatewayInfo> {
        let mut tokens = self.tokens.lock().expect("token map");
        let token = if let Some((t, _)) = tokens.iter().find(|(_, s)| *s == id) {
            t.clone()
        } else {
            let mut bytes = [0u8; 32];
            std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
            let t = hex::encode(bytes);
            tokens.insert(t.clone(), id.clone());
            t
        };
        let base = format!("http://{}/g/{token}", self.addr);
        Ok(GatewayInfo { anthropic: format!("{base}/anthropic"), openai: format!("{base}/openai/v1") })
    }

    fn session(&self, token: &str) -> Option<SessionId> {
        self.tokens.lock().expect("token map").get(token).cloned()
    }
}

pub fn router(state: Arc<State>) -> Router {
    Router::new()
        .route("/g/{token}/{provider}/{*rest}", post(handle))
        .layer(DefaultBodyLimit::max(MAX_BODY))
        .with_state(state)
}

/// An error in the calling SDK's own format, so it shows the message.
fn refuse(api: Option<Api>, status: StatusCode, kind: &str, message: &str) -> Response {
    let message = format!("strive: {message}");
    let body = match api {
        Some(Api::AnthropicMessages) | None => json!({"type": "error", "error": {"type": kind, "message": message}}),
        Some(_) => json!({"error": {"type": kind, "message": message}}),
    };
    (status, [("content-type", "application/json")], body.to_string()).into_response()
}

async fn handle(
    AxumState(state): AxumState<Arc<State>>,
    Path((token, provider, rest)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match admit(&state, &token, &provider, &format!("/{rest}"), &body).await {
        Ok(call) => forward(state, call, &headers).await,
        Err(refusal) => refusal,
    }
}

/// A call that passed every check and is journaled as started.
struct Admitted {
    api: Api,
    provider: String,
    path: String,
    stream: bool,
    sent: Vec<u8>,
    key: String,
    price: strive_budget::Price,
    finish: Finish,
}

/// Everything that can refuse a call happens here, before anything is sent;
/// the last step journals the call as started.
#[allow(clippy::result_large_err, reason = "the refusal is the HTTP response, built at most once per call")]
async fn admit(state: &Arc<State>, token: &str, provider: &str, path: &str, body: &[u8]) -> Result<Admitted, Response> {
    let session = state
        .gateway
        .session(token)
        .ok_or_else(|| refuse(None, StatusCode::UNAUTHORIZED, "authentication_error", "unknown gateway token"))?;
    let api = Api::for_path(provider, path).ok_or_else(|| {
        refuse(None, StatusCode::NOT_FOUND, "not_found_error", &format!("the gateway doesn't handle {provider} {path}"))
    })?;
    let bad = |status, kind, why: &str| refuse(Some(api), status, kind, why);
    let (info, sent) =
        prepare_request(api, body).map_err(|why| bad(StatusCode::BAD_REQUEST, "invalid_request_error", why))?;
    let model = state.models.get(&info.model).copied().ok_or_else(|| {
        let why = format!(
            "no price is known for {}, so its cost can't be bounded; add it under \"models\" in ~/.strive/settings.json",
            info.model
        );
        bad(StatusCode::BAD_REQUEST, "invalid_request_error", &why)
    })?;
    let key = state.credentials.get(provider).ok_or_else(|| {
        let why = format!("no {provider} API key; run `strive auth {provider}`");
        bad(StatusCode::UNAUTHORIZED, "authentication_error", &why)
    })?;
    let reservation = Reservation::for_request(&model, sent.len() as u64, info.max_output);
    let request =
        state.cas.put(&sent).map_err(|e| bad(StatusCode::INTERNAL_SERVER_ERROR, "api_error", &e.to_string()))?;
    let start = CallStart { provider: provider.to_string(), model: info.model.clone(), request, reservation };
    let call = state.sessions.start_call(&session, start).await.map_err(|e| match e {
        CallError::Refused(r) => bad(StatusCode::PAYMENT_REQUIRED, "budget_exceeded", &r.to_string()),
        CallError::Session(e) => bad(StatusCode::INTERNAL_SERVER_ERROR, "api_error", &format!("{e:?}")),
    })?;
    let finish = Finish { state: state.clone(), session, call, reservation, started: Instant::now() };
    Ok(Admitted {
        api,
        provider: provider.to_string(),
        path: path.to_string(),
        stream: info.stream,
        sent,
        key,
        price: model.price,
        finish,
    })
}

/// Sends an admitted call upstream and streams the response back, metering
/// it. A spawned pump finishes the call however the response ends, and ends
/// the client's response only after the call's end is journaled.
async fn forward(state: Arc<State>, a: Admitted, headers: &HeaderMap) -> Response {
    let Admitted { api, provider, path, stream, sent, key, price, finish } = a;
    let reservation = finish.reservation;
    let mut req = state.gateway.http.post(format!("{}{path}", state.settings.upstream(&provider))).body(sent);
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(v) = headers.get(*name) {
            req = req.header(*name, v);
        }
    }
    req = match api {
        Api::AnthropicMessages => req.header("x-api-key", key),
        Api::OpenAiChat | Api::OpenAiResponses => req.bearer_auth(key),
    };
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let outcome = if e.is_connect() {
                CallOutcome::Rejected { status: 502 }
            } else {
                broken(&reservation, format!("the request to {provider} failed: {e}"))
            };
            finish.done(outcome, None).await;
            return refuse(
                Some(api),
                StatusCode::BAD_GATEWAY,
                "api_error",
                &format!("could not reach {provider}: {e}"),
            );
        }
    };

    let status = upstream.status();
    let mut response = Response::builder().status(status.as_u16());
    for (name, value) in upstream.headers() {
        if forward_response_header(name) {
            response = response.header(name.clone(), value.clone());
        }
    }
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    tokio::spawn(async move {
        let mut meter = UsageMeter::new(api, stream);
        let mut all = Vec::new();
        let mut interrupted = None;
        let mut body = upstream.bytes_stream();
        while let Some(chunk) = body.next().await {
            match chunk {
                Ok(bytes) => {
                    meter.feed(&bytes);
                    all.extend_from_slice(&bytes);
                    if tx.send(Ok(bytes)).await.is_err() {
                        interrupted = Some("the client disconnected mid-response".to_string());
                        break;
                    }
                }
                Err(e) => {
                    interrupted = Some(format!("the response from {provider} broke off: {e}"));
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break;
                }
            }
        }
        let outcome = match (status.is_success(), interrupted, meter.finish()) {
            (false, _, _) => CallOutcome::Rejected { status: status.as_u16() },
            (true, None, Some(usage)) => {
                CallOutcome::Complete { status: status.as_u16(), usage, cost_usd_micros: cost(&price, &usage) }
            }
            (true, reason, _) => {
                broken(&reservation, reason.unwrap_or_else(|| "the response ended without reporting usage".into()))
            }
        };
        let response = finish.state.cas.put(&all).ok();
        finish.done(outcome, response).await;
        // Closing the client's stream only now means that once a client sees
        // a response end, the journal already records how the call ended.
        drop(tx);
    });
    response
        .body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
        .unwrap_or_else(|e| refuse(Some(api), StatusCode::INTERNAL_SERVER_ERROR, "api_error", &e.to_string()))
}

/// A call whose real cost is unknown is charged everything it reserved.
fn broken(r: &Reservation, reason: String) -> CallOutcome {
    CallOutcome::Broken { reason, cost_usd_micros: r.usd_micros, tokens: r.tokens }
}

fn forward_response_header(name: &HeaderName) -> bool {
    let n = name.as_str();
    n == "content-type"
        || n == "request-id"
        || n.starts_with("anthropic-")
        || n.starts_with("openai-")
        || n.starts_with("x-ratelimit")
}

struct Finish {
    state: Arc<State>,
    session: SessionId,
    call: u64,
    reservation: Reservation,
    started: Instant,
}

impl Finish {
    async fn done(self, outcome: CallOutcome, response: Option<strive_proto::Digest>) {
        let ms = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        if let Err(e) = self.state.sessions.finish_call(&self.session, self.call, outcome, response, ms).await {
            crate::log!(
                "could not journal the end of call {} (reserved {}): {e:?}",
                self.call,
                strive_budget::format_usd(self.reservation.usd_micros)
            );
        }
    }
}
