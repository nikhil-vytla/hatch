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
use strive_proto::ServerInfo;
use strive_proto::rpc::{Message, RpcError};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{Mutex, Notify, mpsc};

use crate::credentials::Credentials;
use crate::gateway::{self, Gateway};
use crate::log;
use crate::methods::{self, Conn};
use crate::paths::{Home, build_id};
use crate::sessions::Sessions;
use crate::settings::Settings;

/// Longest accepted message line. Larger messages close the connection.
const MAX_LINE: usize = 16 * 1024 * 1024;

/// How long a new daemon waits for an exiting one to release the lock.
const LOCK_WAIT: Duration = Duration::from_secs(5);

pub struct Config {
    pub home: Home,
    pub idle_exit: Duration,
}

pub struct State {
    pub info: ServerInfo,
    pub home: Home,
    pub started: Instant,
    pub idle_exit: Duration,
    pub clients: AtomicU32,
    /// When the client count last dropped to zero (or the daemon started).
    idle_since: Mutex<Instant>,
    pub shutdown: Notify,
    pub sessions: Sessions,
    pub settings: Settings,
    pub models: strive_budget::Models,
    pub credentials: Credentials,
    pub cas: strive_journal::cas::Cas,
    pub gateway: Gateway,
}

/// Outcome of trying to become the daemon.
pub enum Started {
    Served,
    /// Another daemon holds the lock; this process has nothing to do.
    AlreadyRunning,
}

pub async fn run(cfg: Config) -> Result<Started> {
    cfg.home.ensure()?;
    let lock = File::options().create(true).truncate(false).write(true).open(cfg.home.lock())?;
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
    let listener = UnixListener::bind(&socket).with_context(|| format!("binding {}", socket.display()))?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o600))?;

    let settings = Settings::load(&cfg.home.root)?;
    let models = strive_budget::Models::builtin().with_overrides(&settings.models);
    let (gateway, gateway_listener) = Gateway::bind().await.context("binding the model gateway")?;
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
        sessions: Sessions::open(&cfg.home.root).context("opening the session store")?,
        credentials: Credentials::load(&cfg.home.root).context("reading credentials")?,
        cas: strive_journal::cas::Cas::open(&cfg.home.root.join("cas")).context("opening the content store")?,
        settings,
        models,
        gateway,
    });
    let gateway_task = tokio::spawn(axum::serve(gateway_listener, gateway::router(state.clone())).into_future());
    log!("daemon {} listening on {} (pid {})", state.info.build, socket.display(), state.info.pid);

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
    // Unlink first so no new client can reach this daemon, then stop the
    // session writers, then release the lock so a successor (waiting in the
    // loop above) can start.
    let _ = fs::remove_file(&socket);
    drop(listener);
    gateway_task.abort();
    state.sessions.shutdown().await;
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
    let conn = Arc::new(Conn::new(&tx));
    loop {
        line.clear();
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            break;
        }
        if line.len() > MAX_LINE {
            let _ = tx.send(Message::err(None, RpcError::new(RpcError::INVALID_REQUEST, "message too large")));
            break;
        }
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Message>(&line) {
            Err(e) => {
                let _ = tx.send(Message::err(None, RpcError::new(RpcError::PARSE_ERROR, e.to_string())));
            }
            Ok(Message { id: Some(id), method: Some(method), params, .. }) => {
                // The handshake runs in order; after it, requests run
                // concurrently, so one waiting for approval (or a long
                // command) never holds up the rest.
                if conn.initialized() {
                    let (state, conn) = (state.clone(), conn.clone());
                    tokio::spawn(async move {
                        let reply = methods::dispatch(&state, &conn, id, &method, params).await;
                        conn.send(reply);
                    });
                } else {
                    let reply = methods::dispatch(state, &conn, id, &method, params).await;
                    let _ = tx.send(reply);
                }
            }
            // Client notifications and responses to server requests: none defined yet.
            Ok(_) => {}
        }
    }
    // The writer ends when the last strong sender, `tx`, is gone; `conn`
    // and everything it spawned hold only weak ones.
    conn.close();
    drop(tx);
    let _ = writer.await;
    Ok(())
}

pub fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}
