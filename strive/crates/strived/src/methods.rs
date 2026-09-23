//! Request handlers. Params are parsed into typed values here, at the
//! boundary; everything below works on validated types.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use serde_json::{Value, json};
use strive_proto::rpc::{Message, RequestId, RpcError};
use strive_proto::{
    DaemonShutdown, DaemonStatus, DaemonStatusResult, Empty, Event, Initialize, InitializeParams, InitializeResult,
    Method, Notification, PROTOCOL_VERSION, SessionAttach, SessionAttachParams, SessionAttachResult, SessionCreate,
    SessionCreateParams, SessionEntry, SessionEntryNotification, SessionList, SessionListParams, SessionListResult,
    SessionPrompt, SessionPromptParams, SessionPromptResult, SessionRead, SessionReadResult, SessionRef,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::server::State;
use crate::sessions::{SessionError, SessionId};

/// Per-connection state.
pub struct Conn {
    initialized: bool,
    out: mpsc::UnboundedSender<Message>,
    /// Tasks forwarding session entries to this connection. Each holds a
    /// sender to the connection's outbound queue, so they must be aborted
    /// for the connection to finish closing.
    subscriptions: Vec<JoinHandle<()>>,
}

impl Conn {
    pub fn new(out: mpsc::UnboundedSender<Message>) -> Self {
        Self { initialized: false, out, subscriptions: Vec::new() }
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        for t in &self.subscriptions {
            t.abort();
        }
    }
}

type Reply = Result<Value, RpcError>;

pub async fn dispatch(
    state: &Arc<State>,
    conn: &mut Conn,
    id: RequestId,
    method: &str,
    params: Option<Value>,
) -> Message {
    let params = params.unwrap_or_else(|| json!({}));
    let result = if method != Initialize::NAME && !conn.initialized {
        Err(RpcError::new(RpcError::NOT_INITIALIZED, "send initialize first"))
    } else {
        route(state, conn, method, params).await
    };
    match result {
        Ok(v) => Message::ok(id, v),
        Err(e) => Message::err(Some(id), e),
    }
}

async fn route(state: &Arc<State>, conn: &mut Conn, method: &str, params: Value) -> Reply {
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
        SessionCreate::NAME => {
            let SessionCreateParams { cwd } = parse::<SessionCreate>(params)?;
            reply::<SessionCreate>(state.sessions.create(cwd).await.map_err(session_error)?)
        }
        SessionList::NAME => {
            let SessionListParams { cwd } = parse::<SessionList>(params)?;
            let sessions = state.sessions.list(cwd.as_deref()).map_err(|e| internal(&e))?;
            reply::<SessionList>(SessionListResult { sessions })
        }
        SessionAttach::NAME => {
            let SessionAttachParams { id, after_seq } = parse::<SessionAttach>(params)?;
            let sid = session_id(&id)?;
            let (session, entries, mut stream) =
                state.sessions.attach(&sid, after_seq.unwrap_or(0)).await.map_err(session_error)?;
            let out = conn.out.clone();
            conn.subscriptions.push(tokio::spawn(async move {
                while let Some(entry) = stream.recv().await {
                    let n = SessionEntryNotification { session_id: id.clone(), entry };
                    let msg = Message::notification(SessionEntry::NAME, serde_json::to_value(n).expect("serializes"));
                    if out.send(msg).is_err() {
                        break;
                    }
                }
            }));
            reply::<SessionAttach>(SessionAttachResult { session, entries })
        }
        SessionPrompt::NAME => {
            let SessionPromptParams { id, text } = parse::<SessionPrompt>(params)?;
            let entries = state
                .sessions
                .append(&session_id(&id)?, vec![Event::UserMessage { text }])
                .await
                .map_err(session_error)?;
            reply::<SessionPrompt>(SessionPromptResult { seq: entries[0].seq })
        }
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
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

fn initialize(state: &Arc<State>, conn: &mut Conn, p: &InitializeParams) -> Reply {
    if p.protocol_version != PROTOCOL_VERSION {
        let mut e = RpcError::new(
            RpcError::PROTOCOL_MISMATCH,
            format!("client speaks protocol {}, daemon speaks {PROTOCOL_VERSION}", p.protocol_version),
        );
        e.data = Some(json!({ "protocolVersion": PROTOCOL_VERSION }));
        return Err(e);
    }
    conn.initialized = true;
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
