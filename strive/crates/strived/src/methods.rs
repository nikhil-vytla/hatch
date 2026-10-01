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
    SessionCreateParams, SessionEntry, SessionEntryNotification, SessionGateway, SessionKind, SessionList,
    SessionListParams, SessionListResult, SessionPrompt, SessionPromptParams, SessionRead, SessionReadResult,
    SessionRef,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::server::State;
use crate::sessions::Push;
use crate::sessions::{Answer, SessionError, SessionId};
use strive_proto::{
    AgentConfig, Event, HostContext, HostRecord, HostRecordParams, HostRegister, HostStream, HostStreamParams,
    LearnedFile, LearnerContext, SessionDelta, SessionDeltaNotification, SessionInterrupt,
    SessionInterruptNotification, SessionInterruptRequested,
};
use strive_proto::{ApprovalRespond, ApprovalRespondParams, Decision, SessionApprovals, SessionApprovalsParams};
use strive_proto::{EffectCancel, EffectCancelParams, EffectRequest};
use strive_proto::{ModelInfo, ModelList, ModelListResult, SessionModel, SessionModelParams};
use strive_proto::{
    SessionChanges, SessionChangesParams, SessionChangesResult, SessionCommands, SessionCommandsResult,
};
use strive_proto::{SessionRewind, SessionRewindParams, SessionRewindResult};

/// Journals a priced model for the session's agent, before its first prompt.
async fn choose_model(state: &Arc<State>, SessionModelParams { id, model }: SessionModelParams) -> Reply {
    if state.models.get(&model).is_none() {
        return Err(RpcError::new(
            RpcError::INVALID_PARAMS,
            format!("no price is known for {model}; add it under \"models\" in ~/.strive/settings.json"),
        ));
    }
    let entries = state
        .sessions
        .set_model(&session_id(&id)?, model)
        .await
        .map_err(session_error)?
        .map_err(|why| RpcError::new(RpcError::INVALID_REQUEST, why))?;
    reply::<SessionModel>(Appended { seq: entries[0].seq })
}

/// Whose API a model is called through, and so whose key it needs.
pub fn provider_of(model: &str) -> &'static str {
    if model.starts_with("claude") { "anthropic" } else { "openai" }
}

/// The session a connection hosts. `Closed` once it has gone, so a
/// registration still in flight can't claim a session for it.
enum HostOf {
    None,
    Session(SessionId),
    Closed,
}

impl HostOf {
    fn is_host(&self) -> bool {
        matches!(self, HostOf::Session(_))
    }
}

/// Per-connection state.
pub struct Conn {
    initialized: std::sync::atomic::AtomicBool,
    /// The session this connection hosts the agent for, if any.
    host_of: std::sync::Mutex<HostOf>,
    /// The client's name from `initialize`, recorded with its decisions.
    client: std::sync::Mutex<String>,
    /// Weak, so neither requests in flight nor subscriptions keep a closed
    /// connection's outbound queue alive.
    out: mpsc::WeakUnboundedSender<Message>,
    /// Tasks forwarding session entries to this connection.
    subscriptions: std::sync::Mutex<Vec<JoinHandle<()>>>,
    /// host/record requests still being journaled, and a signal when one ends.
    records: std::sync::atomic::AtomicUsize,
    records_done: tokio::sync::Notify,
    /// The turn this connection's host started and hasn't ended.
    open_turn: std::sync::Mutex<Option<u64>>,
    /// Attaches under way as a person. Counted under `host_of`'s lock, so
    /// one can't finish after a registration that didn't see it.
    attaching: std::sync::atomic::AtomicUsize,
}

/// Counts an attach as under way until dropped.
struct Attaching<'a>(&'a std::sync::atomic::AtomicUsize);

impl Drop for Attaching<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

impl Conn {
    pub fn new(out: &mpsc::UnboundedSender<Message>) -> Self {
        Self {
            initialized: std::sync::atomic::AtomicBool::new(false),
            host_of: std::sync::Mutex::new(HostOf::None),
            client: std::sync::Mutex::new(String::new()),
            out: out.downgrade(),
            subscriptions: std::sync::Mutex::new(Vec::new()),
            attaching: std::sync::atomic::AtomicUsize::new(0),
            records: std::sync::atomic::AtomicUsize::new(0),
            records_done: tokio::sync::Notify::new(),
            open_turn: std::sync::Mutex::new(None),
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
    pub fn close(self: &Arc<Self>, state: &Arc<State>) {
        let was = std::mem::replace(&mut *crate::sync::lock(&self.host_of), HostOf::Closed);
        if let HostOf::Session(sid) = was {
            state.hosts.release(&sid);
            // A turn its host was running can't end now unless it's ended
            // here, once the host's own writes (a turnStarted, say) have landed.
            let (state, conn) = (state.clone(), self.clone());
            tokio::spawn(async move {
                conn.records_settled().await;
                // Only a turn this host started: once it's gone, a new host
                // may already have started one of its own.
                let Some(turn) = *crate::sync::lock(&conn.open_turn) else { return };
                match state.sessions.end_open_turn(&sid, turn, "the agent host stopped during this turn").await {
                    Ok(true) => match state.sessions.peek(&sid).map(|i| (i.kind.unwrap_or_default(), i.cwd)) {
                        Some((SessionKind::Work, cwd)) => crate::triggers::turn_ended(&state, cwd, sid.clone()),
                        Some((SessionKind::Learning, _)) => crate::triggers::learning_quiet(&state, sid.clone()),
                        None => {}
                    },
                    Ok(false) => {}
                    Err(e) => crate::log!("could not end session {}'s open turn: {e:?}", sid.as_str()),
                }
            });
        }
        for t in crate::sync::lock(&self.subscriptions).drain(..) {
            t.abort();
        }
    }
}

pub type Reply = Result<Value, RpcError>;

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
        ModelList::NAME => {
            parse::<ModelList>(params)?;
            let models = state
                .models
                .iter()
                .map(|(id, m)| ModelInfo {
                    id: id.to_string(),
                    provider: provider_of(id).into(),
                    context_window: m.context_window,
                    input_usd_micros: m.price.input,
                    output_usd_micros: m.price.output,
                })
                .collect();
            reply::<ModelList>(ModelListResult { models, default: state.settings.model.clone() })
        }
        m if m.starts_with("effect/") => route_effect(state, m, params).await,
        m if m.starts_with("host/") => route_host(state, conn, m, params).await,
        m if m.starts_with("learning/") || m.starts_with("proposal/") || m.starts_with("memory/") => {
            crate::learning::route(state, conn, m, params).await
        }
        ApprovalRespond::NAME => {
            let ApprovalRespondParams { id, effect, decision } = parse::<ApprovalRespond>(params)?;
            require_person(conn)?;
            let by = crate::sync::lock(&conn.client).clone();
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

/// Makes this connection the session's one host; whether it newly became so.
/// Under the connection's host lock, so it can't race `Conn::close`.
fn claim_host(state: &State, conn: &Conn, sid: &SessionId) -> Result<bool, RpcError> {
    let mut host = crate::sync::lock(&conn.host_of);
    // Its subscriptions (made or under way) would go on counting it as a
    // person who can approve.
    let attached = !crate::sync::lock(&conn.subscriptions).is_empty()
        || conn.attaching.load(std::sync::atomic::Ordering::SeqCst) > 0;
    if !host.is_host() && attached {
        return Err(RpcError::new(RpcError::INVALID_REQUEST, "register as a host before attaching to the session"));
    }
    match &*host {
        HostOf::Closed => Err(RpcError::new(RpcError::INVALID_REQUEST, "the connection is closing")),
        HostOf::Session(s) if s == sid => Ok(false),
        HostOf::Session(_) => {
            Err(RpcError::new(RpcError::INVALID_PARAMS, "this connection already hosts another session"))
        }
        HostOf::None if state.hosts.claim(sid) => {
            *host = HostOf::Session(sid.clone());
            Ok(true)
        }
        HostOf::None => Err(RpcError::new(RpcError::HOST_EXISTS, "another agent host is running this session")),
    }
}

/// Counts a host/record as in flight until dropped.
struct Recording<'a>(&'a Conn);

impl Drop for Recording<'_> {
    fn drop(&mut self) {
        self.0.records.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.0.records_done.notify_waiters();
    }
}

impl Conn {
    /// Waits (up to 10s) until no host/record from this connection is still
    /// being journaled.
    async fn records_settled(&self) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let done = self.records_done.notified();
            if self.records.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                return;
            }
            if tokio::time::timeout_at(deadline, done).await.is_err() {
                return;
            }
        }
    }
}

/// Gives up a claim whose registration failed. A connection that closed
/// meanwhile stays closed, so nothing can claim a session for it.
fn release_host(state: &State, conn: &Conn) {
    let mut host = crate::sync::lock(&conn.host_of);
    if let HostOf::Session(sid) = &*host {
        state.hosts.release(sid);
        *host = HostOf::None;
    }
}

/// Decisions that belong to a person: an agent host can't loosen its own
/// limits. (The host runs as the user, so this guards against the agent's
/// mistakes, not a hostile host; see docs/ARCHITECTURE.md.)
pub fn require_person(conn: &Conn) -> Result<(), RpcError> {
    if crate::sync::lock(&conn.host_of).is_host() {
        return Err(RpcError::new(RpcError::NOT_A_PERSON, "only a person can do this, not the agent's host"));
    }
    Ok(())
}

/// The client's name from `initialize`, recorded with what it decides.
pub fn client_name(conn: &Conn) -> String {
    crate::sync::lock(&conn.client).clone()
}

/// What a session's host may record. Everything else in a journal is the
/// daemon's to write: effects, gates, decisions, what was applied.
fn host_may_record(event: &Event, kind: SessionKind) -> bool {
    match event {
        Event::TurnStarted { .. }
        | Event::AssistantMessage { .. }
        | Event::TurnEnded { .. }
        | Event::Compacted { .. } => true,
        Event::LayoutProposed { .. } | Event::ChecksReported { .. } => kind == SessionKind::Work,
        // Only the learner proposes; a work session's agent changing what
        // every later agent is given would skip review.
        Event::ProposalMade { .. } => kind == SessionKind::Learning,
        Event::SessionStarted { .. }
        | Event::RuleLoaded { .. }
        | Event::UserMessage { .. }
        | Event::Recovered { .. }
        | Event::BudgetSet { .. }
        | Event::ModelCallStarted { .. }
        | Event::ModelCallFinished { .. }
        | Event::EffectStarted { .. }
        | Event::EffectFinished { .. }
        | Event::ApprovalModeSet { .. }
        | Event::ApprovalRequested { .. }
        | Event::ApprovalDecided { .. }
        | Event::Checkpointed { .. }
        | Event::Rewound { .. }
        | Event::ContextLoaded { .. }
        | Event::LearnRequested { .. }
        | Event::LearnSkipped { .. }
        | Event::LearnDismissed { .. }
        | Event::GateFinished { .. }
        | Event::ProposalDecided { .. }
        | Event::ProposalApplied { .. }
        | Event::ProposalRolledBack { .. }
        | Event::ModelSet { .. } => false,
    }
}

/// Refuses agent requests from anything but the session's registered host.
fn require_host(conn: &Conn, sid: &SessionId) -> Result<(), RpcError> {
    match &*crate::sync::lock(&conn.host_of) {
        HostOf::Session(s) if s == sid => Ok(()),
        _ => Err(RpcError::new(RpcError::NOT_THE_HOST, "only the session's agent host may do this")),
    }
}

/// What the agent is given for a session it now hosts.
async fn host_config(state: &Arc<State>, sid: &SessionId) -> Reply {
    let sid = sid.clone();
    let info = state.sessions.info(&sid).await.map_err(session_error)?;
    let chosen = state.sessions.model(&sid).await.map_err(session_error)?;
    let model_id = chosen.unwrap_or_else(|| state.settings.model.clone());
    let model = state.models.get(&model_id).copied().ok_or_else(|| {
        RpcError::new(
            RpcError::INVALID_PARAMS,
            format!("no price is known for {model_id}; add it under \"models\" in ~/.strive/settings.json"),
        )
    })?;
    let provider = provider_of(&model_id);
    let urls = state.gateway.info(&sid).map_err(|e| internal(&e))?;
    let (ctx, learned, mcp) = load_context(state, &sid, &info).await?;
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
        // The learner runs nothing, so it has no checks to run.
        checks: if info.kind == Some(SessionKind::Learning) { Vec::new() } else { ctx.checks },
        mcp_tools: mcp.tools,
        kind: info.kind,
        learned_files: learned,
    })
}

/// A learning session's context as a run starts: the files as they are
/// now, which that run's proposals are checked against and written over.
async fn learner_context(state: &Arc<State>, sid: &SessionId) -> Reply {
    let info = state.sessions.info(sid).await.map_err(session_error)?;
    if info.kind != Some(SessionKind::Learning) {
        return Err(RpcError::new(
            RpcError::INVALID_PARAMS,
            "only a learning session's host asks for its context again",
        ));
    }
    let (ctx, learned, _) = load_context(state, sid, &info).await?;
    reply::<HostContext>(LearnerContext {
        instructions: ctx.instructions,
        skills: ctx.skills,
        learned_files: learned.unwrap_or_default(),
    })
}

/// Loads the context a session's agent is given and journals it as a
/// `contextLoaded`: its instructions and skills, a work session's MCP
/// servers, and a learning session's memory and skill files.
async fn load_context(
    state: &Arc<State>,
    sid: &SessionId,
    info: &strive_proto::SessionInfo,
) -> Result<(crate::context::Context, Option<Vec<LearnedFile>>, crate::mcp::Summary), RpcError> {
    let home = state.home.root.canonicalize().map_err(|e| internal(&e))?;
    let workspace = std::path::PathBuf::from(&info.cwd);
    let learning = info.kind == Some(SessionKind::Learning);
    let (ctx, learned) = tokio::task::spawn_blocking(move || {
        let learned = learning.then(|| crate::context::learned(&workspace, &home));
        (crate::context::load(&workspace, &home), learned)
    })
    .await
    .map_err(|e| internal(&e))?;
    // What the learner is shown is journaled: its proposals are checked
    // against, and written only over, these same files.
    let shown = learned
        .as_ref()
        .map(|files| {
            files
                .iter()
                .map(|(artifact, text)| {
                    Ok(strive_proto::ContextFile {
                        path: strive_learning::relative_path(artifact).map_err(std::io::Error::other)?,
                        digest: state.cas.put(text.as_bytes())?,
                        bytes: text.len() as u64,
                    })
                })
                .collect::<std::io::Result<Vec<_>>>()
        })
        .transpose()
        .map_err(|e| internal(&e))?;
    // The learner has no effect tools, and an MCP tool is one.
    let mcp = match info.kind.unwrap_or_default() {
        SessionKind::Learning => crate::mcp::Summary { status: Vec::new(), tools: Vec::new() },
        SessionKind::Work => {
            state
                .mcp
                .for_session(
                    sid,
                    std::path::Path::new(&info.cwd),
                    &state.settings.mcp_servers,
                    &state.sessions.session_dir(sid),
                )
                .await
        }
    };
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
        checks: ctx.checks.iter().map(|c| c.name.clone()).collect(),
        mcp: mcp.status.clone(),
        learned: shown,
        skipped: (!ctx.skipped.is_empty()).then(|| ctx.skipped.clone()),
    };
    state.sessions.append(sid, vec![loaded]).await.map_err(session_error)?;
    // The learner is shown memory as bullets, each with its source.
    let learned = learned.map(|files| {
        files
            .into_iter()
            .map(|(artifact, text)| {
                let items = matches!(artifact, strive_proto::Artifact::Memory)
                    .then(|| strive_learning::memory::parse(&text).items());
                LearnedFile { artifact, text, items }
            })
            .collect()
    });
    Ok((ctx, learned, mcp))
}

async fn route_host(state: &Arc<State>, conn: &Arc<Conn>, method: &str, params: Value) -> Reply {
    match method {
        HostRegister::NAME => {
            let SessionRef { id } = parse::<HostRegister>(params)?;
            let sid = session_id(&id)?;
            let claimed = claim_host(state, conn, &sid)?;
            let config = host_config(state, &sid).await;
            if config.is_err() && claimed {
                release_host(state, conn);
            }
            config
        }
        HostContext::NAME => {
            let SessionRef { id } = parse::<HostContext>(params)?;
            let sid = session_id(&id)?;
            require_host(conn, &sid)?;
            learner_context(state, &sid).await
        }
        HostRecord::NAME => {
            conn.records.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _recording = Recording(conn);
            let HostRecordParams { id, event } = parse::<HostRecord>(params)?;
            let sid = session_id(&id)?;
            require_host(conn, &sid)?;
            let info = state.sessions.info(&sid).await.map_err(session_error)?;
            let kind = info.kind.unwrap_or_default();
            if !host_may_record(&event, kind) {
                return Err(RpcError::new(
                    RpcError::INVALID_PARAMS,
                    match kind {
                        SessionKind::Work => {
                            "a host records only turns, assistant messages, summaries, check reports and layout proposals"
                        }
                        SessionKind::Learning => {
                            "a learning session's host records only turns, assistant messages, summaries and proposals"
                        }
                    },
                ));
            }
            if let Event::ProposalMade { call_id, proposal, before } = event {
                let entries = crate::learning::propose(state, &sid, &info.cwd, call_id, proposal, before).await?;
                return reply::<HostRecord>(Appended { seq: entries[0].seq });
            }
            let opened = match &event {
                Event::TurnStarted { turn, .. } => Some(Some(*turn)),
                Event::TurnEnded { .. } => Some(None),
                _ => None,
            };
            let entries = state
                .sessions
                .host_record(&sid, event)
                .await
                .map_err(session_error)?
                .map_err(|why| RpcError::new(RpcError::INVALID_PARAMS, why))?;
            if let Some(open) = opened {
                *crate::sync::lock(&conn.open_turn) = open;
            }
            if opened == Some(None) {
                turn_over(state, kind, info.cwd.clone(), &sid);
            }
            reply::<HostRecord>(Appended { seq: entries[0].seq })
        }
        HostStream::NAME => {
            let HostStreamParams { id, turn, text } = parse::<HostStream>(params)?;
            require_host(conn, &session_id(&id)?)?;
            state.sessions.push(&session_id(&id)?, Push::Delta { turn, text }).await.map_err(session_error)?;
            reply::<HostStream>(Empty {})
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

/// A session's host recorded a turn's end. A work turn's end starts its
/// idle wait; a learner's lets skipped scans run.
fn turn_over(state: &Arc<State>, kind: SessionKind, cwd: String, sid: &SessionId) {
    match kind {
        SessionKind::Work => crate::triggers::turn_ended(state, cwd, sid.clone()),
        SessionKind::Learning => crate::triggers::learning_quiet(state, sid.clone()),
    }
}

/// The slash commands a session in `cwd` can run, with their prompts (ADR-0024).
async fn project_commands(state: &State, cwd: &str) -> Result<Vec<(strive_proto::CommandInfo, String)>, RpcError> {
    let (ws, home) = (workspace_of(cwd)?, state.home.root.clone());
    tokio::task::spawn_blocking(move || crate::context::commands(&ws, &home)).await.map_err(|e| internal(&e))
}

async fn list_commands(state: &State, params: Value) -> Reply {
    let SessionRef { id } = parse::<SessionCommands>(params)?;
    let info = state.sessions.info(&session_id(&id)?).await.map_err(session_error)?;
    let commands = project_commands(state, &info.cwd).await?;
    reply::<SessionCommands>(SessionCommandsResult { commands: commands.into_iter().map(|(c, _)| c).collect() })
}

fn read(state: &State, params: Value) -> Reply {
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

async fn prompt(state: &Arc<State>, params: Value) -> Reply {
    let SessionPromptParams { id, text } = parse::<SessionPrompt>(params)?;
    let sid = session_id(&id)?;
    let info = state.sessions.info(&sid).await.map_err(session_error)?;
    match info.kind.unwrap_or_default() {
        SessionKind::Work => {}
        SessionKind::Learning => {
            return Err(RpcError::new(
                RpcError::INVALID_REQUEST,
                "this is a project's learning session; ask it to study sessions with `strive learn` (learning/run)",
            ));
        }
    }
    // `/name arguments`, where the project has a command `name`, is the
    // prompt it stands for (ADR-0024); the journal keeps both.
    let (text, command) = match strive_learning::command_file::invoked(&text) {
        Some((name, arguments)) => {
            match project_commands(state, &info.cwd).await?.into_iter().find(|(c, _)| c.name == name) {
                Some((c, body)) => (
                    strive_learning::command_file::expand(&body, arguments),
                    Some(strive_proto::CommandUse { name: c.name, arguments: arguments.trim().to_string() }),
                ),
                None => (text, None),
            }
        }
        None => (text, None),
    };
    let commit = checkpoint(state, &sid, &info.cwd, &format!("before: {text}")).await;
    let entries = state.sessions.prompt(&sid, text, command, commit).await.map_err(session_error)?;
    state.hosts.ensure(&sid, &state.home.socket(), &state.sessions.session_dir(&sid).join("host.log"));
    reply::<SessionPrompt>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}

/// Files the changes view shows at most, and the most of each file's text.
const CHANGES_FILES: usize = 200;
const CHANGES_BYTES: u64 = 256 * 1024;

async fn changes(state: &Arc<State>, id: &str, checkpoint: u64) -> Reply {
    let sid = session_id(id)?;
    let info = state.sessions.info(&sid).await.map_err(session_error)?;
    let commit = state.sessions.checkpoint_commit(&sid, checkpoint).await.map_err(session_error)?.ok_or_else(|| {
        RpcError::new(RpcError::INVALID_PARAMS, format!("no checkpoint {checkpoint} in this session"))
    })?;
    let workspace = workspace_of(&info.cwd)?;
    let shadow = crate::checkpoints::Shadow::new(&state.sessions.checkpoint_dir(&sid), &workspace)
        .ok_or_else(|| RpcError::new(RpcError::INTERNAL_ERROR, "checkpoints need git, which isn't available"))?;
    // Not while a checkpoint or rewind of this session is under way.
    let lock = state.sessions.checkpoint_lock(&sid);
    let _held = lock.lock().await;
    let (files, more) = tokio::task::spawn_blocking(move || shadow.changes(&commit, CHANGES_FILES, CHANGES_BYTES))
        .await
        .map_err(|e| internal(&e))?
        .map_err(|e| internal(&e))?;
    reply::<SessionChanges>(SessionChangesResult { files, more })
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
    let Some(_running) = state.sessions.begin_effect() else {
        return Err(RpcError::new(RpcError::INTERNAL_ERROR, "the daemon is stopping"));
    };
    // No effect in this directory (from any session) may run during the restore.
    let workspace = workspace_of(&info.cwd)?;
    let _files = state.sessions.workspaces.rewind(&workspace).ok_or_else(|| {
        RpcError::new(
            RpcError::INVALID_REQUEST,
            "the agent is changing files right now; interrupt it (Esc) before rewinding",
        )
    })?;
    let lock = state.sessions.checkpoint_lock(&sid);
    let _held = lock.lock().await;
    let shadow = Arc::new(
        crate::checkpoints::Shadow::new(&state.sessions.checkpoint_dir(&sid), &workspace)
            .ok_or_else(|| RpcError::new(RpcError::INTERNAL_ERROR, "checkpoints need git, which isn't available"))?,
    );
    let git = shadow.clone();
    let target_commit = target.clone();
    let (saved, nested) = tokio::task::spawn_blocking(move || {
        let saved = git.snapshot(&format!("before rewinding to checkpoint {to}"))?;
                let in_the_way = git.unsaved_in_the_way(&target)?;
        if !in_the_way.is_empty() {
            return Err(std::io::Error::other(format!(
                "rewinding would overwrite files checkpoints don't save (ignored files, nested repositories): {}; move them aside first",
                in_the_way.join(", ")
            )));
        }
        std::io::Result::Ok((saved, git.nested_repositories()?))
    })
    .await
    .map_err(|e| internal(&e))?
    .map_err(|e| RpcError::new(RpcError::INVALID_REQUEST, e.to_string()))?;
    // Journaled before restoring: a restore that fails partway can be undone.
    let saved_as = state.sessions.record_checkpoint(&sid, saved).await.map_err(session_error)?;

    let restored =
        tokio::task::spawn_blocking(move || shadow.restore(&target_commit)).await.map_err(|e| internal(&e))?;
    if let Err(e) = restored {
        return Err(RpcError::new(
            RpcError::INTERNAL_ERROR,
            format!(
                "the rewind stopped partway ({e}); your files from just before it are checkpoint {saved_as}, and /rewind {saved_as} puts them back once the cause is fixed"
            ),
        ));
    }
    state.sessions.record_rewind(&sid, to, saved_as).await.map_err(session_error)?;
    reply::<SessionRewind>(SessionRewindResult { saved_as, not_saved: nested })
}

async fn route_effect(state: &Arc<State>, method: &str, params: Value) -> Reply {
    match method {
        EffectRun::NAME => {
            let EffectRunParams { id, call_id, request } = parse::<EffectRun>(params)?;
            let sid = session_id(&id)?;
            let info = state.sessions.info(&sid).await.map_err(session_error)?;
            if info.kind == Some(SessionKind::Learning) {
                return Err(RpcError::new(
                    RpcError::INVALID_REQUEST,
                    "the learner can't change files or run commands; it can only propose changes for a person to review",
                ));
            }
            let workspace = workspace_of(&info.cwd)?;
            let strive_home = state.home.root.canonicalize().map_err(|e| internal(&e))?;
            // Read for each effect, so an import a person just allowed an
            // instruction file to add is guarded from the next one on.
            let (ws, home) = (workspace.clone(), strive_home.clone());
            let imports = tokio::task::spawn_blocking(move || crate::context::imports(&ws, &home))
                .await
                .map_err(|e| internal(&e))?;
            let scope = crate::effects::Scope {
                workspace,
                strive_home,
                unconfined: state.settings.sandbox == crate::settings::SandboxSetting::Off,
                imports,
            };
            // A check runs the command its file holds now (ADR-0023), not one the host names.
            let (request, record, check) = match request {
                EffectRequest::Check { name } => {
                    let (ws, home, n) = (scope.workspace.clone(), scope.strive_home.clone(), name.clone());
                    let (found, text) = tokio::task::spawn_blocking(move || crate::context::check(&ws, &home, &n))
                        .await
                        .map_err(|e| internal(&e))?
                        .map_err(|why| {
                            RpcError::new(RpcError::INVALID_PARAMS, format!("the check {name} can't run: {why}"))
                        })?;
                    let digest = strive_journal::cas::digest(text.as_bytes());
                    let proposed = crate::checks::proposed(state, &info.cwd, &name, &digest);
                    let timeout_ms = found.timeout_secs * 1000;
                    let record = strive_proto::EffectRecord::Check {
                        name: name.clone(),
                        command: found.run.clone(),
                        timeout_ms,
                        note: found.body,
                    };
                    let check = CheckRun { allowance: crate::checks::allowance(&name, &digest), name, proposed };
                    (EffectRequest::Bash { command: found.run, timeout_ms: Some(timeout_ms) }, record, Some(check))
                }
                request => {
                    let record = crate::effects::record(&state.cas, &request).map_err(|e| internal(&e))?;
                    (request, record, None)
                }
            };
            let Some(_running) = state.sessions.begin_effect() else {
                return Err(RpcError::new(RpcError::INTERNAL_ERROR, "the daemon is stopping"));
            };
            let cancelled = state.sessions.cancel_flag(&sid, &call_id);
            let effect =
                state.sessions.start_effect(&sid, call_id.clone(), record.clone()).await.map_err(session_error);
            let result = run_effect(state, &sid, scope, Prepared { request, record, check }, effect, &cancelled).await;
            state.sessions.forget_cancel(&sid, &call_id);
            result
        }
        EffectCancel::NAME => {
            let EffectCancelParams { id, call_id } = parse::<EffectCancel>(params)?;
            let flag = state.sessions.cancel_flag(&session_id(&id)?, &call_id);
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            reply::<EffectCancel>(Empty {})
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

/// How long an MCP tool call may run.
const MCP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Calls a tool on one of the session's MCP servers.
async fn call_mcp(
    state: &State,
    sid: &SessionId,
    server: &str,
    tool: &str,
    arguments: Value,
    cancelled: &std::sync::atomic::AtomicBool,
) -> crate::effects::Result {
    use crate::effects::Result as R;
    use crate::mcp::Called;
    // Cancelled while it waited (for approval, or for the server to restart).
    if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        return R::Refused(format!("interrupted: {server}'s {tool} was cancelled"));
    }
    let s = match state.mcp.server(sid, server).await {
        Ok(s) => s,
        Err(why) => return R::Refused(why),
    };
    match s.call(tool, arguments, cancelled, MCP_TIMEOUT).await {
        Called::Done { text, is_error: false, truncated } => R::Done { text, exit_code: None, truncated },
        Called::Done { text, is_error: true, .. } => R::Refused(text),
        Called::Failed(why) => R::Refused(format!("{server}'s {tool} failed: {why}")),
        Called::Cancelled => R::Refused(format!("interrupted: {server}'s {tool} was cancelled")),
        Called::TimedOut => R::Refused(format!("{server}'s {tool} didn't answer in {}s", MCP_TIMEOUT.as_secs())),
    }
}

/// A done effect's result, followed by the rules the file it touched brings,
/// the first time in the session (ADR-0025).
async fn with_rules(
    state: &State,
    sid: &SessionId,
    effect: u64,
    result: crate::effects::Result,
    ruled: Option<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf)>,
) -> Result<crate::effects::Result, RpcError> {
    Ok(match (result, ruled) {
        (crate::effects::Result::Done { text, exit_code, truncated }, Some((path, ws, home))) => {
            let given = rules_for(state, sid, effect, &path, &ws, &home).await?;
            crate::effects::Result::Done { text: format!("{text}{given}"), exit_code, truncated }
        }
        (result, _) => result,
    })
}

/// The rules (ADR-0025) whose paths match `path`, a file the effect read or
/// changed, that the session hasn't been given as they are now: journaled
/// as given, and their text to follow the effect's output. Empty for a file
/// outside the workspace.
async fn rules_for(
    state: &State,
    sid: &SessionId,
    effect: u64,
    path: &std::path::Path,
    workspace: &std::path::Path,
    strive_home: &std::path::Path,
) -> Result<String, RpcError> {
    use std::fmt::Write as _;
    let Some(relative) = path.strip_prefix(workspace).ok().and_then(|r| r.to_str()).map(str::to_string) else {
        return Ok(String::new());
    };
    let (ws, home) = (workspace.to_path_buf(), strive_home.to_path_buf());
    let rules =
        tokio::task::spawn_blocking(move || crate::context::rules(&ws, &home)).await.map_err(|e| internal(&e))?;
    let mut out = String::new();
    for rule in
        rules.into_iter().filter(|r| !r.paths.is_empty() && strive_learning::rule_file::matches(&r.paths, &relative))
    {
        let digest = state.cas.put(rule.body.as_bytes()).map_err(|e| internal(&e))?;
        let file = rule.file.strip_prefix(workspace).unwrap_or(&rule.file).display().to_string();
        let event = Event::RuleLoaded { effect, name: rule.name.clone(), file: file.clone(), digest };
        if state.sessions.load_rule(sid, event).await.map_err(session_error)? {
            let _ = write!(out, "\n\n[The rule {file} applies to {relative}; follow it here:]\n{}", rule.body);
        }
    }
    Ok(out)
}

/// An effect as `effect/run` has it ready: what to perform, as journaled,
/// and the check it is, if it is one (which has its own gate).
struct Prepared {
    request: EffectRequest,
    record: strive_proto::EffectRecord,
    check: Option<CheckRun>,
}

/// A check about to run (ADR-0023): whether an applied proposal holds its
/// content, and the session allowance that would cover it as it is.
struct CheckRun {
    name: String,
    proposed: bool,
    allowance: std::path::PathBuf,
}

/// Gates, performs and journals one effect the session has started.
async fn run_effect(
    state: &Arc<State>,
    sid: &SessionId,
    scope: crate::effects::Scope,
    prepared: Prepared,
    effect: std::result::Result<u64, RpcError>,
    cancelled: &Arc<std::sync::atomic::AtomicBool>,
) -> Reply {
    let Prepared { request, record, check } = prepared;
    let effect = effect?;
    let sid = sid.clone();
    {
        let started = std::time::Instant::now();
        let (mode, allowed) = state.sessions.approvals(&sid).await.map_err(session_error)?;
        let cancel = cancelled.clone();
        let (gate, target) = match (&check, &request) {
            (Some(c), EffectRequest::Bash { command, .. }) => {
                let accepted = c.proposed || allowed.contains(&c.allowance);
                crate::effects::check_gate(&scope, &c.name, command, accepted, &c.allowance)
            }
            _ => crate::effects::gate(&scope, &request, mode, &allowed),
        };
        let refusal = match gate {
            crate::effects::Gate::Allow => None,
            crate::effects::Gate::Deny(why) => Some(why),
            crate::effects::Gate::Ask(what, session_file) => {
                let session_file = session_file.map(|f| f.display().to_string());
                match state
                    .sessions
                    .ask(&sid, effect, what.clone(), session_file, cancelled)
                    .await
                    .map_err(session_error)?
                {
                    // Suggest full-auto only where it would have let this run.
                    Answer::NoOne
                        if check.is_none()
                            && matches!(
                                crate::effects::gate(&scope, &request, strive_proto::ApprovalMode::FullAuto, &allowed)
                                    .0,
                                crate::effects::Gate::Allow
                            ) =>
                    {
                        Some(format!(
                            "{what} needs approval, but no client is attached to give it; use full-auto approvals for unattended runs"
                        ))
                    }
                    Answer::NoOne => Some(format!(
                        "{what} needs a person's approval even in full-auto, and no client is attached to give it"
                    )),
                    Answer::Cancelled => Some(format!("interrupted: {what}")),
                    Answer::Decided(Decision::Deny) => Some(format!("declined: {what}")),
                    Answer::Decided(Decision::Allow | Decision::AllowSession) => None,
                }
            }
        };
        // A file a read or change touches, for the rules it brings (ADR-0025).
        let ruled = match (&request, target.path()) {
            (EffectRequest::Read { .. } | EffectRequest::Write { .. } | EffectRequest::Edit { .. }, Some(p)) => {
                Some((p.to_path_buf(), scope.workspace.clone(), scope.strive_home.clone()))
            }
            _ => None,
        };
        let result = if let Some(why) = refusal {
            crate::effects::Result::Refused(why)
        } else {
            // Held while the effect runs, so no rewind of its directory races
            // it; a destination outside the workspace is held too.
            let mut paths = vec![scope.workspace.clone()];
            if let Some(p) = target.path().filter(|p| !p.starts_with(&scope.workspace)) {
                paths.push(p.to_path_buf());
            }
            // An edit reads the file and writes it back: another one in
            // between would be lost. Taken before the workspace, so an edit
            // waiting its turn doesn't hold up rewinds.
            let file = match (&request, target.path()) {
                (EffectRequest::Edit { .. } | EffectRequest::Write { .. }, Some(p)) => {
                    Some(state.sessions.workspaces.file(p).await)
                }
                _ => None,
            };
            let files = state.sessions.workspaces.effect(paths).await;
            if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                // Cancelled while it waited (for approval, or for a rewind).
                drop((files, file));
                crate::effects::Result::Refused("interrupted before it ran".into())
            } else if let EffectRequest::Mcp { server, tool, arguments } = &request {
                let result = call_mcp(state, &sid, server, tool, arguments.clone(), cancelled).await;
                drop((files, file));
                result
            } else {
                tokio::task::spawn_blocking(move || {
                    let _held = (files, file);
                    crate::effects::perform(&scope, &request, &target, &cancel)
                })
                .await
                .map_err(|e| internal(&e))?
            }
        };
        let result = with_rules(state, &sid, effect, result, ruled).await?;
        let (outcome, text) = match result {
            crate::effects::Result::Done { text, exit_code, truncated } => {
                let output = state.cas.put(text.as_bytes()).map_err(|e| internal(&e))?;
                (EffectOutcome::Done { output, exit_code, truncated }, text)
            }
            crate::effects::Result::Refused(reason) => (EffectOutcome::Refused { reason: reason.clone() }, reason),
        };
        let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        state.sessions.finish_effect(&sid, effect, outcome.clone(), ms).await.map_err(session_error)?;
        reply::<EffectRun>(EffectRunResult { effect, record, outcome, text })
    }
}

async fn route_session(state: &Arc<State>, conn: &Arc<Conn>, method: &str, params: Value) -> Reply {
    match method {
        SessionCreate::NAME => {
            let SessionCreateParams { cwd } = parse::<SessionCreate>(params)?;
            // Kept as its real path, so a later swap of any part shows (see `workspace_of`).
            let cwd = std::path::Path::new(&cwd).canonicalize().map_or(cwd, |p| p.display().to_string());
            reply::<SessionCreate>(
                state
                    .sessions
                    .create(cwd, state.settings.budget.limits(), state.settings.approvals, None)
                    .await
                    .map_err(session_error)?,
            )
        }
        SessionList::NAME => {
            let SessionListParams { cwd, kind } = parse::<SessionList>(params)?;
            // Sessions keep their directory's real path; so does the filter.
            let cwd = cwd.map(|c| std::path::Path::new(&c).canonicalize().map_or(c, |p| p.display().to_string()));
            let (sessions, unreadable) =
                state.sessions.list(cwd.as_deref(), kind.unwrap_or_default()).map_err(|e| internal(&e))?;
            reply::<SessionList>(SessionListResult { sessions, unreadable })
        }
        SessionAttach::NAME => {
            let SessionAttachParams { id, after_seq, observer } = parse::<SessionAttach>(params)?;
            let sid = session_id(&id)?;
            let (person, _attaching) = {
                let host = crate::sync::lock(&conn.host_of);
                if host.is_host() || observer == Some(true) {
                    (false, None)
                } else {
                    conn.attaching.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    (true, Some(Attaching(&conn.attaching)))
                }
            };
            let (session, entries, mut stream) =
                state.sessions.attach(&sid, after_seq.unwrap_or(0), person).await.map_err(session_error)?;
            let weak = conn.out.clone();
            let forward = tokio::spawn(async move {
                while let Some(push) = stream.recv().await {
                    let Some(msg) = notification(&id, push) else {
                        crate::log!("a session {id} notification did not serialize; ending the subscription");
                        break;
                    };
                    if weak.upgrade().is_none_or(|out| out.send(msg).is_err()) {
                        break;
                    }
                }
            });
            crate::sync::lock(&conn.subscriptions).push(forward);
            reply::<SessionAttach>(SessionAttachResult { session, entries })
        }
        SessionPrompt::NAME => prompt(state, params).await,
        SessionRewind::NAME => {
            require_person(conn)?;
            rewind(state, params).await
        }
        SessionCommands::NAME => list_commands(state, params).await,
        SessionChanges::NAME => {
            let SessionChangesParams { id, checkpoint } = parse::<SessionChanges>(params)?;
            changes(state, &id, checkpoint).await
        }
        SessionRead::NAME => read(state, params),
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
            require_person(conn)?;
            let SessionApprovalsParams { id, mode } = parse::<SessionApprovals>(params)?;
            let entries = state.sessions.set_mode(&session_id(&id)?, mode).await.map_err(session_error)?;
            reply::<SessionApprovals>(Appended { seq: entries[0].seq })
        }
        SessionModel::NAME => {
            require_person(conn)?;
            choose_model(state, parse::<SessionModel>(params)?).await
        }
        SessionBudget::NAME => {
            require_person(conn)?;
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
    crate::sync::lock(&conn.client).clone_from(&p.client.name);
    conn.initialized.store(true, std::sync::atomic::Ordering::SeqCst);
    reply::<Initialize>(InitializeResult {
        protocol_version: PROTOCOL_VERSION,
        server: state.info.clone(),
        home: state.home.root.display().to_string(),
    })
}

pub fn parse<M: Method>(params: Value) -> Result<M::Params, RpcError> {
    serde_json::from_value(params).map_err(|e| RpcError::new(RpcError::INVALID_PARAMS, e.to_string()))
}

pub fn reply<M: Method>(result: M::Result) -> Reply {
    serde_json::to_value(result).map_err(|e| internal(&e))
}

pub fn session_id(s: &str) -> Result<SessionId, RpcError> {
    SessionId::parse(s).ok_or_else(|| RpcError::new(RpcError::INVALID_PARAMS, format!("not a session id: {s:?}")))
}

pub fn session_error(e: SessionError) -> RpcError {
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

pub fn internal(e: &dyn std::fmt::Display) -> RpcError {
    RpcError::new(RpcError::INTERNAL_ERROR, e.to_string())
}

/// Saves the workspace before a prompt. Checkpoints are best effort: without
/// git, or if saving fails, the prompt still goes ahead, unrecorded.
/// The session's directory, if it's still where the session began. Each
/// part of the path is followed again every time, so one swapped for a
/// symlink (a directory under /tmp, replaced) would lead effects, the
/// sandbox's writable area and checkpoints somewhere else entirely.
pub fn workspace_of(cwd: &str) -> Result<std::path::PathBuf, RpcError> {
    let real = std::path::Path::new(cwd).canonicalize().map_err(|e| {
        RpcError::new(RpcError::INTERNAL_ERROR, format!("the session's directory {cwd} is missing: {e}"))
    })?;
    if real != std::path::Path::new(cwd) {
        return Err(RpcError::new(
            RpcError::INVALID_REQUEST,
            format!(
                "the session's directory {cwd} now leads to {}; nothing runs there. Start a new session where you mean to work",
                real.display()
            ),
        ));
    }
    Ok(real)
}

async fn checkpoint(state: &Arc<State>, sid: &SessionId, cwd: &str, message: &str) -> Option<String> {
    let workspace = workspace_of(cwd).map_err(|e| crate::log!("checkpoint skipped: {}", e.message)).ok()?;
    let shadow = crate::checkpoints::Shadow::new(&state.sessions.checkpoint_dir(sid), &workspace)?;
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
fn notification(session_id: &str, push: Push) -> Option<Message> {
    let session_id = session_id.to_string();
    let (name, params) = match push {
        Push::Entry(entry) => {
            (SessionEntry::NAME, serde_json::to_value(SessionEntryNotification { session_id, entry }))
        }
        Push::Delta { turn, text } => {
            (SessionDelta::NAME, serde_json::to_value(SessionDeltaNotification { session_id, turn, text }))
        }
        Push::Interrupt => {
            (SessionInterruptRequested::NAME, serde_json::to_value(SessionInterruptNotification { session_id }))
        }
    };
    params.ok().map(|p| Message::notification(name, p))
}
