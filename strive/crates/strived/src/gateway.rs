//! The model gateway: a loopback HTTP proxy every model call goes through.
//!
//! A session's agent gets base URLs containing a secret token for that
//! session. For each request the gateway reads what it asks for and refuses
//! it if its worst-case cost can't be bounded or doesn't fit the budget.
//! Otherwise it stores the exact request bytes, journals the call as
//! started, and forwards it with the provider key only the daemon holds
//! (never following redirects, which would carry the key elsewhere). It
//! streams the response back while metering it, stores the response bytes
//! and journals how the call ended before the client's response ends.
//!
//! Forwarding runs in its own task, so a client that goes away (before or
//! during the response) can't leave a call open, and every started call is
//! finished exactly once: complete, rejected by the provider, or broken
//! (stream cut, provider silent, response too large, client gone).

use std::collections::HashMap;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
use strive_proto::{CallOutcome, Digest, GatewayInfo};
use tokio::sync::{mpsc, oneshot};

use crate::server::State;
use crate::sessions::{CallError, CallStart, SessionId};

const MAX_BODY: usize = 64 * 1024 * 1024;
/// The largest response the gateway relays and stores.
const MAX_RESPONSE: usize = 64 * 1024 * 1024;
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
        let builder = || {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
        };
        // The system's roots where it has them. A bare container (a benchmark
        // task on ubuntu with no ca-certificates) has none, and then Mozilla's,
        // built in, are used instead.
        let http = match builder().build() {
            Ok(c) => c,
            Err(system) => {
                let roots = webpki_root_certs::TLS_SERVER_ROOT_CERTS
                    .iter()
                    .filter_map(|der| reqwest::Certificate::from_der(der).ok());
                crate::log!("no usable system CA certificates ({system}); using the built-in roots");
                builder().tls_certs_only(roots).build()?
            }
        };
        Ok((Self { addr: listener.local_addr()?, tokens: Mutex::new(HashMap::new()), http }, listener))
    }

    /// Base URLs for a session's agent, minting its token on first use.
    pub fn info(&self, id: &SessionId) -> std::io::Result<GatewayInfo> {
        let mut tokens = crate::sync::lock(&self.tokens);
        let existing = tokens.iter().find(|(_, s)| *s == id).map(|(t, _)| t.clone());
        let token = if let Some(t) = existing {
            t
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
        crate::sync::lock(&self.tokens).get(token).cloned()
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
    let betas = headers.get("anthropic-beta").and_then(|v| v.to_str().ok()).unwrap_or_default();
    match admit(&state, &token, &provider, &format!("/{rest}"), betas, &body).await {
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

/// Everything that can refuse a call happens here, before anything is sent
/// or stored; the last step journals the call as started.
#[expect(clippy::result_large_err, reason = "the refusal is the HTTP response, built at most once per call")]
async fn admit(
    state: &Arc<State>,
    token: &str,
    provider: &str,
    path: &str,
    betas: &str,
    body: &[u8],
) -> Result<Admitted, Response> {
    let session = state
        .gateway
        .session(token)
        .ok_or_else(|| refuse(None, StatusCode::UNAUTHORIZED, "authentication_error", "unknown gateway token"))?;
    let api = Api::for_path(provider, path).ok_or_else(|| {
        refuse(None, StatusCode::NOT_FOUND, "not_found_error", &format!("the gateway doesn't handle {provider} {path}"))
    })?;
    let bad = |status, kind, why: &str| refuse(Some(api), status, kind, why);
    let session_failed = |e| bad(StatusCode::INTERNAL_SERVER_ERROR, "api_error", &format!("{e:?}"));
    // A replay run's cost is read once it's over; a late call from its host
    // would reopen its journal and spend past the replay's cap.
    let replay_run = state.sessions.peek(&session).is_some_and(|i| i.kind == Some(strive_proto::SessionKind::Replay));
    if replay_run && !state.learning.replaying.is_run(&session) {
        return Err(bad(
            StatusCode::FORBIDDEN,
            "permission_error",
            "this replay run is over, so it can't call the model",
        ));
    }
    strive_gateway::check_betas(betas).map_err(|why| bad(StatusCode::BAD_REQUEST, "invalid_request_error", why))?;
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
    let reservation = Reservation::for_call(&model, sent.len() as u64, info.max_output, info.choices, info.input_rate);
    let refused_session = session.clone();
    let refused = |e| match e {
        CallError::Refused(r) => {
            state.learning.replaying.note_refused(&refused_session);
            bad(StatusCode::PAYMENT_REQUIRED, "budget_exceeded", &r.to_string())
        }
        CallError::Session(e) => session_failed(e),
    };
    // Checked before storing, so refused requests can't fill the store.
    state.sessions.check_budget(&session, reservation).await.map_err(refused)?;
    let request =
        state.cas.put(&sent).map_err(|e| bad(StatusCode::INTERNAL_SERVER_ERROR, "api_error", &e.to_string()))?;
    let start = CallStart { provider: provider.to_string(), model: info.model.clone(), request, reservation };
    // Journaling the start reserves money, so whatever journals it must also
    // own closing it. A client that leaves drops this handler, and could do so
    // after the writer journaled the start but before its reply arrived; in
    // a task of its own, the start always ends up in a `Finish`, whose drop
    // closes the call.
    let owner = state.clone();
    let finish = tokio::spawn(async move {
        let call = owner.sessions.start_call(&session, start).await?;
        Ok(Finish::new(owner, session, call, reservation))
    })
    .await
    .map_err(|e| bad(StatusCode::INTERNAL_SERVER_ERROR, "api_error", &e.to_string()))?
    .map_err(refused)?;
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

type Head = Result<(StatusCode, HeaderMap), String>;

/// Hands the call to a forwarding task and answers with its response. The
/// task owns the call: if this handler is dropped because the client left,
/// the task notices and finishes the call anyway.
async fn forward(state: Arc<State>, a: Admitted, headers: &HeaderMap) -> Response {
    let api = a.api;
    let mut req = state.gateway.http.post(format!("{}{}", state.settings.upstream(&a.provider), a.path)).body(a.sent);
    for name in FORWARDED_REQUEST_HEADERS {
        if let Some(v) = headers.get(*name) {
            req = req.header(*name, v);
        }
    }
    req = match api {
        Api::AnthropicMessages => req.header("x-api-key", &a.key),
        Api::OpenAiChat | Api::OpenAiResponses => req.bearer_auth(&a.key),
    };
    let (head_tx, head_rx) = oneshot::channel::<Head>();
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    let idle = Duration::from_secs(state.settings.gateway.stream_idle_secs);
    let mut finish = a.finish;
    finish.if_dropped = "the gateway dropped the call unexpectedly";
    let pump = Pump { api, stream: a.stream, provider: a.provider, price: a.price, finish, idle };
    tokio::spawn(pump.run(req, head_tx, tx));
    match head_rx.await {
        Ok(Ok((status, upstream_headers))) => {
            let mut response = Response::builder().status(status.as_u16());
            for (name, value) in &upstream_headers {
                if forward_response_header(name) {
                    response = response.header(name.clone(), value.clone());
                }
            }
            response
                .body(Body::from_stream(tokio_stream::wrappers::ReceiverStream::new(rx)))
                .unwrap_or_else(|e| refuse(Some(api), StatusCode::INTERNAL_SERVER_ERROR, "api_error", &e.to_string()))
        }
        Ok(Err(why)) => refuse(Some(api), StatusCode::BAD_GATEWAY, "api_error", &why),
        Err(_) => refuse(Some(api), StatusCode::BAD_GATEWAY, "api_error", "the call ended before it began"),
    }
}

struct Pump {
    api: Api,
    stream: bool,
    provider: String,
    price: strive_budget::Price,
    finish: Finish,
    idle: Duration,
}

impl Pump {
    async fn run(
        self,
        req: reqwest::RequestBuilder,
        head_tx: oneshot::Sender<Head>,
        tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    ) {
        let Pump { api, stream, provider, price, finish, idle } = self;
        let reservation = finish.reservation;
        let mut head_tx = head_tx;
        let upstream = tokio::select! {
            r = req.send() => r,
            () = head_tx.closed() => {
                finish.done(broken(&reservation, "the client disconnected before the response began".into()), None).await;
                return;
            }
        };
        let upstream = match upstream {
            Ok(r) => r,
            Err(e) => {
                let outcome = if e.is_connect() {
                    CallOutcome::Rejected { status: 502 }
                } else {
                    broken(&reservation, format!("the request to {provider} failed: {e}"))
                };
                finish.done(outcome, None).await;
                let _ = head_tx.send(Err(format!("could not reach {provider}: {e}")));
                return;
            }
        };
        let status = upstream.status();
        if head_tx.send(Ok((status, upstream.headers().clone()))).is_err() {
            finish.done(broken(&reservation, "the client disconnected before the response began".into()), None).await;
            return;
        }
        let mut meter = UsageMeter::new(api, stream);
        let mut holdback = strive_gateway::Holdback::default();
        let mut all = Vec::new();
        let mut interrupted = None;
        let mut body = upstream.bytes_stream();
        loop {
            let next = tokio::select! {
                n = tokio::time::timeout(idle, body.next()) => n,
                () = tx.closed() => {
                    interrupted = Some("the client disconnected mid-response".to_string());
                    break;
                }
            };
            match next {
                Err(_) => {
                    interrupted = Some(format!("the provider sent nothing for {}s", idle.as_secs()));
                    break;
                }
                Ok(None) => break,
                Ok(Some(Err(e))) => {
                    interrupted = Some(format!("the response from {provider} broke off: {e}"));
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break;
                }
                Ok(Some(Ok(bytes))) => {
                    if all.len() + bytes.len() > MAX_RESPONSE {
                        interrupted = Some("the response exceeded 64 MiB".to_string());
                        break;
                    }
                    meter.feed(&bytes);
                    all.extend_from_slice(&bytes);
                    let now = if stream { Bytes::from(holdback.feed(&bytes)) } else { bytes };
                    if !now.is_empty() && tx.send(Ok(now)).await.is_err() {
                        interrupted = Some("the client disconnected mid-response".to_string());
                        break;
                    }
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
        let response = match finish.state.cas.put(&all) {
            Ok(d) => Some(d),
            Err(e) => {
                crate::log!("could not store the response of call {}: {e}", finish.call);
                None
            }
        };
        if finish.done(outcome, response).await {
            // The stream's last event, held until now (see `Holdback`).
            let rest = holdback.rest();
            if !rest.is_empty() {
                let _ = tx.send(Ok(Bytes::from(rest))).await;
            }
        } else {
            // The client must not see a clean end for a call the journal
            // doesn't record as finished.
            let _ = tx.send(Err(std::io::Error::other("strive could not record the end of this call"))).await;
        }
        // Closing the client's stream only now means that once a client sees
        // a response end, the journal already records how the call ended.
        drop(tx);
    }
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

/// A started call's obligation to be finished. Counts as daemon activity
/// while it lives; if dropped unfinished (a panic, a cancelled task), it
/// finishes the call as broken on its own.
struct Finish {
    state: Arc<State>,
    session: SessionId,
    call: u64,
    reservation: Reservation,
    started: Instant,
    finished: bool,
    /// Why the call ended, if this is dropped before `done`.
    if_dropped: &'static str,
}

impl Finish {
    fn new(state: Arc<State>, session: SessionId, call: u64, reservation: Reservation) -> Self {
        state.gateway_calls.fetch_add(1, Ordering::SeqCst);
        Self {
            state,
            session,
            call,
            reservation,
            started: Instant::now(),
            finished: false,
            if_dropped: "the client disconnected before the response began",
        }
    }

    /// Journals how the call ended; false if that couldn't be recorded.
    async fn done(mut self, outcome: CallOutcome, response: Option<Digest>) -> bool {
        self.finished = true;
        crate::log!("call {} ending: {outcome:?}", self.call);
        let ms = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let recorded = self.state.sessions.finish_call(&self.session, self.call, outcome, response, ms).await;
        crate::log!("call {} end recorded: {}", self.call, recorded.is_ok());
        if let Err(e) = &recorded {
            crate::log!(
                "could not journal the end of call {} (reserved {}): {e:?}",
                self.call,
                strive_budget::format_usd(self.reservation.usd_micros)
            );
        }
        recorded.is_ok()
    }
}

impl Drop for Finish {
    fn drop(&mut self) {
        let state = self.state.clone();
        if !self.finished {
            let (session, call, r) = (self.session.clone(), self.call, self.reservation);
            let reason = self.if_dropped.to_string();
            tokio::spawn(async move {
                let _ = state.sessions.finish_call(&session, call, broken(&r, reason), None, 0).await;
            });
        }
        let state = self.state.clone();
        if state.gateway_calls.fetch_sub(1, Ordering::SeqCst) == 1 {
            tokio::spawn(async move { state.touch().await });
        }
    }
}
