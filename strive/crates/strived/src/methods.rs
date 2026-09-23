//! Request handlers. Params are parsed into typed values here, at the
//! boundary; everything below works on validated types.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use strive_proto::rpc::{Message, RequestId, RpcError};
use strive_proto::{
    Appended, AuthSet, AuthSetParams, AuthStatus, AuthStatusResult, BlobGet, BlobGetParams, BlobGetResult,
    DaemonShutdown, DaemonStatus, DaemonStatusResult, EffectOutcome, EffectRun, EffectRunParams, EffectRunResult,
    Empty, Initialize, InitializeParams, InitializeResult, Method, Notification, PROTOCOL_VERSION, ProviderAuth,
    SessionAttach, SessionAttachParams, SessionAttachResult, SessionBudget, SessionBudgetParams, SessionCreate,
    SessionCreateParams, SessionEntry, SessionEntryNotification, SessionGateway, SessionList, SessionListParams,
    SessionListResult, SessionPrompt, SessionPromptParams, SessionRead, SessionReadResult, SessionRef,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::server::State;
use crate::sessions::Push;
use crate::sessions::{SessionError, SessionId};
use strive_proto::{
    AgentConfig, Event, HostRecord, HostRecordParams, HostRegister, HostStream, HostStreamParams, SessionDelta,
    SessionDeltaNotification, SessionInterrupt, SessionInterruptNotification, SessionInterruptRequested,
};
use strive_proto::{ApprovalRespond, ApprovalRespondParams, Decision, SessionApprovals, SessionApprovalsParams};
use strive_proto::{SessionRewind, SessionRewindParams, SessionRewindResult};

/// Per-connection state.
pub struct Conn {
    initialized: std::sync::atomic::AtomicBool,
    /// The session this connection hosts the agent for, if any.
    host_of: std::sync::Mutex<Option<SessionId>>,
    /// The client's name from `initialize`, recorded with its decisions.
    client: std::sync::Mutex<String>,
    /// Weak, so neither requests in flight nor subscriptions keep a closed
    /// connection's outbound queue alive.
    out: mpsc::WeakUnboundedSender<Message>,
    /// Tasks forwarding session entries to this connection.
    subscriptions: std::sync::Mutex<Vec<JoinHandle<()>>>,
}

impl Conn {
    pub fn new(out: &mpsc::UnboundedSender<Message>) -> Self {
        Self {
            initialized: std::sync::atomic::AtomicBool::new(false),
            host_of: std::sync::Mutex::new(None),
            client: std::sync::Mutex::new(String::new()),
            out: out.downgrade(),
            subscriptions: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn initialized(&self) -> bool {
        self.initialized.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Sends a message if the connection is still open.
    pub fn send(&self, msg: Message) -> bool {
        self.out.upgrade().is_some_and(|out| out.send(msg).is_ok())
    }

    /// Stops forwarding session entries and gives up any host registration;
    /// called when the connection closes.
    pub fn close(&self, state: &State) {
        if let Some(sid) = self.host_of.lock().expect("host registration").take() {
            state.hosts.unregister(&sid);
        }
        for t in self.subscriptions.lock().expect("subscriptions").drain(..) {
            t.abort();
        }
    }
}

type Reply = Result<Value, RpcError>;

pub async fn dispatch(
    state: &Arc<State>,
    conn: &Arc<Conn>,
    id: RequestId,
    method: &str,
    params: Option<Value>,
) -> Message {
    let params = params.unwrap_or_else(|| json!({}));
    let result = if method != Initialize::NAME && !conn.initialized() {
        Err(RpcError::new(RpcError::NOT_INITIALIZED, "send initialize first"))
    } else {
        route(state, conn, method, params).await
    };
    match result {
        Ok(v) => Message::ok(id, v),
        Err(e) => Message::err(Some(id), e),
    }
}

async fn route(state: &Arc<State>, conn: &Arc<Conn>, method: &str, params: Value) -> Reply {
    match method {
        Initialize::NAME => initialize(state, conn, &parse::<Initialize>(params)?),
        DaemonStatus::NAME => {
            parse::<DaemonStatus>(params)?;
            reply::<DaemonStatus>(DaemonStatusResult {
                server: state.info.clone(),
                uptime_ms: u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX),
                clients: state.clients.load(Ordering::SeqCst),
                idle_exit_secs: state.idle_exit.as_secs(),
            })
        }
        DaemonShutdown::NAME => {
            parse::<DaemonShutdown>(params)?;
            state.shutdown.notify_one();
            reply::<DaemonShutdown>(Empty {})
        }
        m if m.starts_with("session/") => route_session(state, conn, m, params).await,
        AuthSet::NAME => {
            let AuthSetParams { provider, api_key } = parse::<AuthSet>(params)?;
            if !crate::credentials::PROVIDERS.iter().any(|(p, _)| *p == provider) {
                return Err(RpcError::new(
                    RpcError::INVALID_PARAMS,
                    format!("unknown provider {provider:?}; use anthropic or openai"),
                ));
            }
            let api_key = api_key.trim().to_string();
            if api_key.is_empty() {
                return Err(RpcError::new(RpcError::INVALID_PARAMS, "the API key is empty"));
            }
            state.credentials.set(&provider, api_key).map_err(|e| internal(&e))?;
            reply::<AuthSet>(Empty {})
        }
        AuthStatus::NAME => {
            parse::<AuthStatus>(params)?;
            let providers = crate::credentials::PROVIDERS
                .iter()
                .map(|(p, _)| ProviderAuth {
                    provider: (*p).to_string(),
                    source: state.credentials.source(p).to_string(),
                })
                .collect();
            reply::<AuthStatus>(AuthStatusResult { providers })
        }
        m if m.starts_with("effect/") => route_effect(state, m, params).await,
        m if m.starts_with("host/") => route_host(state, conn, m, params).await,
        ApprovalRespond::NAME => {
            let ApprovalRespondParams { id, effect, decision } = parse::<ApprovalRespond>(params)?;
            let by = conn.client.lock().expect("client name").clone();
            match state.sessions.decide(&session_id(&id)?, effect, decision, by).await {
                Ok(()) => reply::<ApprovalRespond>(Empty {}),
                Err(crate::sessions::DecideError::NotPending) => Err(RpcError::new(
                    RpcError::APPROVAL_NOT_PENDING,
                    format!("effect {effect} is not waiting for approval"),
                )),
                Err(crate::sessions::DecideError::Session(e)) => Err(session_error(e)),
            }
        }
        BlobGet::NAME => {
            let BlobGetParams { digest } = parse::<BlobGet>(params)?;
            let bytes = state.cas.get(&digest).map_err(|e| internal(&e))?;
            reply::<BlobGet>(BlobGetResult {
                text: String::from_utf8_lossy(&bytes).into_owned(),
                bytes: bytes.len() as u64,
            })
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

async fn route_host(state: &Arc<State>, conn: &Arc<Conn>, method: &str, params: Value) -> Reply {
    match method {
        HostRegister::NAME => {
            let SessionRef { id } = parse::<HostRegister>(params)?;
            let sid = session_id(&id)?;
            let info = state.sessions.info(&sid).await.map_err(session_error)?;
            let model_id = state.settings.model.clone();
            let model = state.models.get(&model_id).copied().ok_or_else(|| {
                RpcError::new(
                    RpcError::INVALID_PARAMS,
                    format!("no price is known for {model_id}; add it under \"models\" in ~/.strive/settings.json"),
                )
            })?;
            let provider = if model_id.starts_with("claude") { "anthropic" } else { "openai" };
            let urls = state.gateway.info(&sid).map_err(|e| internal(&e))?;
            let home = state.home.root.canonicalize().map_err(|e| internal(&e))?;
            let workspace = std::path::PathBuf::from(&info.cwd);
            let ctx = tokio::task::spawn_blocking(move || crate::context::load(&workspace, &home))
                .await
                .map_err(|e| internal(&e))?;
            let files = ctx
                .instructions
                .iter()
                .map(|f| {
                    Ok(strive_proto::ContextFile {
                        path: f.path.clone(),
                        digest: state.cas.put(f.text.as_bytes())?,
                        bytes: f.text.len() as u64,
                    })
                })
                .collect::<std::io::Result<Vec<_>>>()
                .map_err(|e| internal(&e))?;
            let loaded = Event::ContextLoaded {
                instructions: files,
                skills: ctx.skills.iter().map(|s| s.name.clone()).collect(),
            };
            state.sessions.append(&sid, vec![loaded]).await.map_err(session_error)?;
            {
                let mut host = conn.host_of.lock().expect("host registration");
                if host.is_none() {
                    state.hosts.register(&sid);
                    *host = Some(sid.clone());
                }
            }
            reply::<HostRegister>(AgentConfig {
                cwd: info.cwd,
                base_url: if provider == "anthropic" { urls.anthropic } else { urls.openai },
                provider: provider.into(),
                model: model_id,
                context_window: model.context_window,
                max_output: model.max_output.min(state.settings.agent_max_output),
                turn_seconds: state.settings.turn_seconds,
                compact_at_tokens: match state.settings.compact_at_tokens {
                    0 => model.context_window / 5 * 4,
                    n => n,
                },
                instructions: ctx.instructions,
                skills: ctx.skills,
            })
        }
        HostRecord::NAME => {
            let HostRecordParams { id, event } = parse::<HostRecord>(params)?;
            if !matches!(
                event,
                Event::TurnStarted { .. }
                    | Event::AssistantMessage { .. }
                    | Event::TurnEnded { .. }
                    | Event::Compacted { .. }
            ) {
                return Err(RpcError::new(
                    RpcError::INVALID_PARAMS,
                    "a host records only turns and assistant messages",
                ));
            }
            let entries = state.sessions.append(&session_id(&id)?, vec![event]).await.map_err(session_error)?;
            reply::<HostRecord>(Appended { seq: entries[0].seq })
        }
        HostStream::NAME => {
            let HostStreamParams { id, turn, text } = parse::<HostStream>(params)?;
            state.sessions.push(&session_id(&id)?, Push::Delta { turn, text }).await.map_err(session_error)?;
            reply::<HostStream>(Empty {})
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

async fn prompt(state: &Arc<State>, params: Value) -> Reply {
    let SessionPromptParams { id, text } = parse::<SessionPrompt>(params)?;
    let sid = session_id(&id)?;
    let info = state.sessions.info(&sid).await.map_err(session_error)?;
    let commit = checkpoint(state, &sid, &info.cwd, &format!("before: {text}")).await;
    let entries = state.sessions.prompt(&sid, text, commit).await.map_err(session_error)?;
    state.hosts.ensure(&sid, &state.home.socket(), &state.sessions.session_dir(&sid).join("host.log"));
    reply::<SessionPrompt>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}

async fn rewind(state: &Arc<State>, params: Value) -> Reply {
    let SessionRewindParams { id, checkpoint: to } = parse::<SessionRewind>(params)?;
    let sid = session_id(&id)?;
    let info = state.sessions.info(&sid).await.map_err(session_error)?;
    let target = state
        .sessions
        .checkpoint_commit(&sid, to)
        .await
        .map_err(session_error)?
        .ok_or_else(|| RpcError::new(RpcError::INVALID_PARAMS, format!("no checkpoint {to} in this session")))?;
    let lock = state.sessions.checkpoint_lock(&sid);
    let _held = lock.lock().await;
    let shadow = crate::checkpoints::Shadow::new(&state.sessions.checkpoint_dir(&sid), std::path::Path::new(&info.cwd))
        .ok_or_else(|| RpcError::new(RpcError::INTERNAL_ERROR, "checkpoints need git, which isn't available"))?;
    let saved = tokio::task::spawn_blocking(move || {
        let saved = shadow.snapshot(&format!("before rewinding to checkpoint {to}"))?;
        shadow.restore(&target)?;
        std::io::Result::Ok(saved)
    })
    .await
    .map_err(|e| internal(&e))?
    .map_err(|e| internal(&e))?;
    let saved_as = state.sessions.record_rewind(&sid, to, saved).await.map_err(session_error)?;
    reply::<SessionRewind>(SessionRewindResult { saved_as })
}

async fn route_effect(state: &Arc<State>, method: &str, params: Value) -> Reply {
    match method {
        EffectRun::NAME => {
            let EffectRunParams { id, call_id, request } = parse::<EffectRun>(params)?;
            let sid = session_id(&id)?;
            let info = state.sessions.info(&sid).await.map_err(session_error)?;
            let scope = crate::effects::Scope {
                workspace: std::path::Path::new(&info.cwd).canonicalize().map_err(|e| {
                    RpcError::new(
                        RpcError::INTERNAL_ERROR,
                        format!("the session's directory {} is missing: {e}", info.cwd),
                    )
                })?,
                strive_home: state.home.root.canonicalize().map_err(|e| internal(&e))?,
            };
            let record = crate::effects::record(&state.cas, &request).map_err(|e| internal(&e))?;
            let effect = state.sessions.start_effect(&sid, call_id, record).await.map_err(session_error)?;
            let started = std::time::Instant::now();
            let mode = state.sessions.mode(&sid).await.map_err(session_error)?;
            let refusal = match crate::effects::gate(&scope, &request, mode) {
                crate::effects::Gate::Allow => None,
                crate::effects::Gate::Deny(why) => Some(why),
                crate::effects::Gate::Ask(what) => {
                    match state.sessions.ask(&sid, effect, what.clone()).await.map_err(session_error)? {
                        None => Some(format!(
                            "{what} needs approval, but no client is attached to give it; use full-auto approvals for unattended runs"
                        )),
                        Some(Decision::Deny) => Some(format!("declined: {what}")),
                        Some(Decision::Allow | Decision::AllowSession) => None,
                    }
                }
            };
            let result = match refusal {
                Some(why) => crate::effects::Result::Refused(why),
                None => tokio::task::spawn_blocking(move || crate::effects::perform(&scope, &request))
                    .await
                    .map_err(|e| internal(&e))?,
            };
            let (outcome, text) = match result {
                crate::effects::Result::Done { text, exit_code, truncated } => {
                    let output = state.cas.put(text.as_bytes()).map_err(|e| internal(&e))?;
                    (EffectOutcome::Done { output, exit_code, truncated }, text)
                }
                crate::effects::Result::Refused(reason) => (EffectOutcome::Refused { reason: reason.clone() }, reason),
            };
            let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
            state.sessions.finish_effect(&sid, effect, outcome.clone(), ms).await.map_err(session_error)?;
            reply::<EffectRun>(EffectRunResult { effect, outcome, text })
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

async fn route_session(state: &Arc<State>, conn: &Arc<Conn>, method: &str, params: Value) -> Reply {
    match method {
        SessionCreate::NAME => {
            let SessionCreateParams { cwd } = parse::<SessionCreate>(params)?;
            reply::<SessionCreate>(
                state
                    .sessions
                    .create(cwd, state.settings.budget.limits(), state.settings.approvals)
                    .await
                    .map_err(session_error)?,
            )
        }
        SessionList::NAME => {
            let SessionListParams { cwd } = parse::<SessionList>(params)?;
            let (sessions, unreadable) = state.sessions.list(cwd.as_deref()).map_err(|e| internal(&e))?;
            reply::<SessionList>(SessionListResult { sessions, unreadable })
        }
        SessionAttach::NAME => {
            let SessionAttachParams { id, after_seq } = parse::<SessionAttach>(params)?;
            let sid = session_id(&id)?;
            let person = conn.host_of.lock().expect("host registration").is_none();
            let (session, entries, mut stream) =
                state.sessions.attach(&sid, after_seq.unwrap_or(0), person).await.map_err(session_error)?;
            let weak = conn.out.clone();
            let forward = tokio::spawn(async move {
                while let Some(push) = stream.recv().await {
                    let msg = notification(&id, push);
                    if weak.upgrade().is_none_or(|out| out.send(msg).is_err()) {
                        break;
                    }
                }
            });
            conn.subscriptions.lock().expect("subscriptions").push(forward);
            reply::<SessionAttach>(SessionAttachResult { session, entries })
        }
        SessionPrompt::NAME => prompt(state, params).await,
        SessionRewind::NAME => rewind(state, params).await,
        SessionRead::NAME => {
            let SessionRef { id } = parse::<SessionRead>(params)?;
            let (session, report) = state.sessions.read(&session_id(&id)?).map_err(session_error)?;
            reply::<SessionRead>(SessionReadResult {
                session,
                entries: report.entries,
                committed: report.committed,
                torn_bytes: report.torn_bytes,
                problem: report.problem.map(|p| p.to_string()),
            })
        }
        SessionGateway::NAME => {
            let SessionRef { id } = parse::<SessionGateway>(params)?;
            let sid = session_id(&id)?;
            state.sessions.check(&sid).await.map_err(session_error)?;
            reply::<SessionGateway>(state.gateway.info(&sid).map_err(|e| internal(&e))?)
        }
        SessionInterrupt::NAME => {
            let SessionRef { id } = parse::<SessionInterrupt>(params)?;
            state.sessions.push(&session_id(&id)?, Push::Interrupt).await.map_err(session_error)?;
            reply::<SessionInterrupt>(Empty {})
        }
        SessionApprovals::NAME => {
            let SessionApprovalsParams { id, mode } = parse::<SessionApprovals>(params)?;
            let entries = state.sessions.set_mode(&session_id(&id)?, mode).await.map_err(session_error)?;
            reply::<SessionApprovals>(Appended { seq: entries[0].seq })
        }
        SessionBudget::NAME => {
            let SessionBudgetParams { id, usd_micros, tokens } = parse::<SessionBudget>(params)?;
            let limits = strive_budget::Limits { usd_micros, tokens };
            let entries = state.sessions.set_budget(&session_id(&id)?, limits).await.map_err(session_error)?;
            reply::<SessionBudget>(Appended { seq: entries[0].seq })
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

fn initialize(state: &Arc<State>, conn: &Arc<Conn>, p: &InitializeParams) -> Reply {
    if p.protocol_version != PROTOCOL_VERSION {
        let mut e = RpcError::new(
            RpcError::PROTOCOL_MISMATCH,
            format!("client speaks protocol {}, daemon speaks {PROTOCOL_VERSION}", p.protocol_version),
        );
        e.data = Some(json!({ "protocolVersion": PROTOCOL_VERSION }));
        return Err(e);
    }
    conn.client.lock().expect("client name").clone_from(&p.client.name);
    conn.initialized.store(true, std::sync::atomic::Ordering::SeqCst);
    reply::<Initialize>(InitializeResult {
        protocol_version: PROTOCOL_VERSION,
        server: state.info.clone(),
        home: state.home.root.display().to_string(),
    })
}

fn parse<M: Method>(params: Value) -> Result<M::Params, RpcError> {
    serde_json::from_value(params).map_err(|e| RpcError::new(RpcError::INVALID_PARAMS, e.to_string()))
}

fn reply<M: Method>(result: M::Result) -> Reply {
    serde_json::to_value(result).map_err(|e| internal(&e))
}

fn session_id(s: &str) -> Result<SessionId, RpcError> {
    SessionId::parse(s).ok_or_else(|| RpcError::new(RpcError::INVALID_PARAMS, format!("not a session id: {s:?}")))
}

fn session_error(e: SessionError) -> RpcError {
    match e {
        SessionError::NotFound => RpcError::new(RpcError::SESSION_NOT_FOUND, "no such session"),
        SessionError::Invalid(p) => {
            let mut e =
                RpcError::new(RpcError::JOURNAL_INVALID, format!("the session journal failed verification: {p}"));
            e.data = Some(json!({ "problem": p.to_string() }));
            e
        }
        SessionError::Io(e) => internal(&e),
    }
}

fn internal(e: &dyn std::fmt::Display) -> RpcError {
    RpcError::new(RpcError::INTERNAL_ERROR, e.to_string())
}

/// Saves the workspace before a prompt. Checkpoints are best effort: without
/// git, or if saving fails, the prompt still goes ahead, unrecorded.
async fn checkpoint(state: &Arc<State>, sid: &SessionId, cwd: &str, message: &str) -> Option<String> {
    let shadow = crate::checkpoints::Shadow::new(&state.sessions.checkpoint_dir(sid), std::path::Path::new(cwd))?;
    let lock = state.sessions.checkpoint_lock(sid);
    let _held = lock.lock().await;
    let message = message.to_string();
    match tokio::task::spawn_blocking(move || shadow.snapshot(&message)).await {
        Ok(Ok(commit)) => Some(commit),
        Ok(Err(e)) => {
            crate::log!("checkpoint skipped: {e}");
            None
        }
        Err(e) => {
            crate::log!("checkpoint skipped: {e}");
            None
        }
    }
}

/// The notification a subscriber gets for a push.
fn notification(session_id: &str, push: Push) -> Message {
    let session_id = session_id.to_string();
    match push {
        Push::Entry(entry) => Message::notification(
            SessionEntry::NAME,
            serde_json::to_value(SessionEntryNotification { session_id, entry }).expect("serializes"),
        ),
        Push::Delta { turn, text } => Message::notification(
            SessionDelta::NAME,
            serde_json::to_value(SessionDeltaNotification { session_id, turn, text }).expect("serializes"),
        ),
        Push::Interrupt => Message::notification(
            SessionInterruptRequested::NAME,
            serde_json::to_value(SessionInterruptNotification { session_id }).expect("serializes"),
        ),
    }
}
