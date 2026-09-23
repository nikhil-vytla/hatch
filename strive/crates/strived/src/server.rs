//! The daemon: one per user, serving JSON-RPC 2.0 over a Unix socket.
//!
//! Ownership is decided by an exclusive lock on `run/strived.lock`, not by the
//! socket file, so two `strive` commands racing to start a daemon cannot both
//! win, and a socket left behind by a crash is safely replaced.

use std::fs::{self, File, TryLockError};
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde_json::Value;
use strive_proto::rpc::{Message, RequestId, RpcError};
use strive_proto::{
    DaemonShutdown, DaemonStatus, DaemonStatusResult, Empty, Initialize, InitializeParams,
    InitializeResult, Method, PROTOCOL_VERSION, ServerInfo,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, Notify, mpsc};

use crate::log;
use crate::paths::{Home, build_id};

/// Longest accepted message line. Larger messages close the connection.
const MAX_LINE: usize = 16 * 1024 * 1024;

/// How long a new daemon waits for an exiting one to release the lock.
const LOCK_WAIT: Duration = Duration::from_secs(5);

pub struct Config {
    pub home: Home,
    pub idle_exit: Duration,
}

struct State {
    info: ServerInfo,
    home: Home,
    started: Instant,
    idle_exit: Duration,
    clients: AtomicU32,
    /// When the client count last dropped to zero (or the daemon started).
    idle_since: Mutex<Instant>,
    shutdown: Notify,
}

/// Outcome of trying to become the daemon.
pub enum Started {
    Served,
    /// Another daemon holds the lock; this process has nothing to do.
    AlreadyRunning,
}

pub async fn run(cfg: Config) -> Result<Started> {
    cfg.home.ensure()?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(cfg.home.lock())?;
    let socket = cfg.home.socket();
    // A held lock means either a live daemon (its socket answers) or one that
    // is exiting (socket already unlinked, lock not yet released). Only the
    // first is a reason to stand down; for the second, wait for the lock.
    let deadline = Instant::now() + LOCK_WAIT;
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(TryLockError::WouldBlock) => {
                if UnixStream::connect(&socket).await.is_ok() || Instant::now() > deadline {
                    return Ok(Started::AlreadyRunning);
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(TryLockError::Error(e)) => {
                return Err(e).context("locking the daemon lock file");
            }
        }
    }

    let _ = fs::remove_file(&socket); // stale from a crash; we hold the lock
    let listener =
        UnixListener::bind(&socket).with_context(|| format!("binding {}", socket.display()))?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;

    let state = Arc::new(State {
        info: ServerInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            build: build_id(),
            pid: std::process::id(),
            started_at_ms: epoch_ms(),
        },
        home: cfg.home.clone(),
        started: Instant::now(),
        idle_exit: cfg.idle_exit,
        clients: AtomicU32::new(0),
        idle_since: Mutex::new(Instant::now()),
        shutdown: Notify::new(),
    });
    log!(
        "daemon {} listening on {} (pid {})",
        state.info.build,
        socket.display(),
        state.info.pid
    );

    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    loop {
        tokio::select! {
            // Polled in order. Shutdown and signals come first, so a steady
            // stream of connections (a launcher retrying every 10 ms, say) can't
            // starve them. Accept comes before the idle timer, so a connection
            // already queued never loses to an idle exit. A client that connects
            // after the socket is unlinked below finds nothing and starts a new
            // daemon.
            biased;
            () = state.shutdown.notified() => { log!("shutdown requested"); break; }
            _ = term.recv() => { log!("SIGTERM"); break; }
            _ = int.recv() => { log!("SIGINT"); break; }
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let state = state.clone();
                    state.clients.fetch_add(1, Ordering::SeqCst);
                    tokio::spawn(async move {
                        if let Err(e) = serve_connection(&state, stream).await {
                            log!("connection ended with error: {e:#}");
                        }
                        if state.clients.fetch_sub(1, Ordering::SeqCst) == 1 {
                            *state.idle_since.lock().await = Instant::now();
                        }
                    });
                }
                Err(e) => log!("accept failed: {e}"),
            },
            _ = tick.tick() => {
                if state.clients.load(Ordering::SeqCst) == 0 && state.idle_since.lock().await.elapsed() >= state.idle_exit {
                    log!("idle for {}s with no clients, exiting", state.idle_exit.as_secs());
                    break;
                }
            }
        }
    }
    // Unlink first so no new client can reach this daemon, then release the
    // lock so a successor (waiting in the loop above) can start.
    let _ = fs::remove_file(&socket);
    drop(listener);
    drop(lock);
    Ok(Started::Served)
}

async fn serve_connection(state: &Arc<State>, stream: UnixStream) -> Result<()> {
    let (read, mut write) = stream.into_split();
    // All outbound messages go through one queue, so responses and (later)
    // streamed notifications never interleave mid-line.
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let mut line = serde_json::to_vec(&msg).expect("messages serialize");
            line.push(b'\n');
            if write.write_all(&line).await.is_err() {
                break;
            }
        }
    });

    let mut reader = BufReader::new(read);
    let mut line = String::new();
    let mut initialized = false;
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        if line.len() > MAX_LINE {
            let _ = tx.send(Message::err(
                None,
                RpcError::new(RpcError::INVALID_REQUEST, "message too large"),
            ));
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Message>(&line) {
            Err(e) => Some(Message::err(
                None,
                RpcError::new(RpcError::PARSE_ERROR, e.to_string()),
            )),
            Ok(msg) => match (msg.id, msg.method) {
                (Some(id), Some(method)) => {
                    Some(dispatch(state, &mut initialized, id, &method, msg.params))
                }
                // Client notifications and responses to server requests: none defined yet.
                _ => None,
            },
        };
        if let Some(reply) = reply {
            let _ = tx.send(reply);
        }
    }
    drop(tx);
    let _ = writer.await;
    Ok(())
}

fn dispatch(
    state: &Arc<State>,
    initialized: &mut bool,
    id: RequestId,
    method: &str,
    params: Option<Value>,
) -> Message {
    let params = params.unwrap_or(Value::Object(serde_json::Map::default()));
    if method != Initialize::NAME && !*initialized {
        return Message::err(
            Some(id),
            RpcError::new(RpcError::NOT_INITIALIZED, "send initialize first"),
        );
    }
    let result = match method {
        Initialize::NAME => call::<Initialize>(params, |p: InitializeParams| {
            if p.protocol_version != PROTOCOL_VERSION {
                let mut e = RpcError::new(
                    RpcError::PROTOCOL_MISMATCH,
                    format!(
                        "client speaks protocol {}, daemon speaks {PROTOCOL_VERSION}",
                        p.protocol_version
                    ),
                );
                e.data = Some(serde_json::json!({ "protocolVersion": PROTOCOL_VERSION }));
                return Err(e);
            }
            *initialized = true;
            Ok(InitializeResult {
                protocol_version: PROTOCOL_VERSION,
                server: state.info.clone(),
                home: state.home.root.display().to_string(),
            })
        }),
        DaemonStatus::NAME => call::<DaemonStatus>(params, |_: Empty| {
            Ok(DaemonStatusResult {
                server: state.info.clone(),
                uptime_ms: u64::try_from(state.started.elapsed().as_millis()).unwrap_or(u64::MAX),
                clients: state.clients.load(Ordering::SeqCst),
                idle_exit_secs: state.idle_exit.as_secs(),
            })
        }),
        DaemonShutdown::NAME => call::<DaemonShutdown>(params, |_: Empty| {
            state.shutdown.notify_one();
            Ok(Empty {})
        }),
        other => Err(RpcError::new(
            RpcError::METHOD_NOT_FOUND,
            format!("unknown method {other}"),
        )),
    };
    match result {
        Ok(v) => Message::ok(id, v),
        Err(e) => Message::err(Some(id), e),
    }
}

fn call<M: Method>(
    params: Value,
    f: impl FnOnce(M::Params) -> Result<M::Result, RpcError>,
) -> Result<Value, RpcError> {
    let p = serde_json::from_value(params)
        .map_err(|e| RpcError::new(RpcError::INVALID_PARAMS, e.to_string()))?;
    let r = f(p)?;
    serde_json::to_value(r).map_err(|e| RpcError::new(RpcError::INTERNAL_ERROR, e.to_string()))
}

pub fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
