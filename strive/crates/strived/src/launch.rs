//! Starting or attaching to the daemon, and replacing a stale one.

use std::fs::{File, OpenOptions, TryLockError};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use strive_proto::rpc::RpcError;
use strive_proto::{DaemonShutdown, Empty, InitializeResult};

use crate::client::{Client, ServerError};
use crate::paths::{Home, build_id};

const START_TIMEOUT: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_millis(10);

/// Connects to a running daemon without starting one.
pub async fn attach(home: &Home, client_name: &str) -> Result<Option<(Client, InitializeResult)>> {
    let Ok(mut c) = Client::connect(&home.socket()).await else {
        return Ok(None);
    };
    let init = c.initialize(client_name).await?;
    Ok(Some((c, init)))
}

/// Returns a client connected to a current daemon, starting or replacing the
/// daemon as needed.
///
/// Each pass re-reads the world instead of assuming what the last one saw:
/// the daemon we reached may be exiting (idle, or replaced by another
/// launcher), and a daemon we spawned may stand down because another
/// launcher's daemon won the lock. Every such case retries until the deadline.
pub async fn ensure(home: &Home, client_name: &str) -> Result<(Client, InitializeResult)> {
    home.ensure()?;
    let deadline = Instant::now() + START_TIMEOUT;
    let mut child: Option<Child> = None;
    loop {
        match attach(home, client_name).await {
            Ok(Some((c, init))) if init.server.build == build_id() => return Ok((c, init)),
            Ok(Some((mut c, init))) => {
                // Stale. Ask it to go; the next pass either finds it still
                // exiting, finds a current daemon another launcher started, or
                // finds nothing and spawns one (which waits for the lock).
                crate::log!("replacing stale daemon {} (pid {})", init.server.build, init.server.pid);
                let _ = c.request::<DaemonShutdown>(Empty {}).await;
            }
            Ok(None) => match child.as_mut().map(Child::try_wait) {
                Some(Ok(None)) => {}
                Some(Ok(Some(status))) if !status.success() => {
                    bail!("the daemon failed to start: {}", last_error(home));
                }
                // Not spawned yet, or it stood down because another daemon won the lock.
                _ => child = Some(spawn(home)?),
            },
            Err(e) if is_protocol_mismatch(&e) => {
                // A daemon from an incompatible release: we can't ask it nicely.
                bail!(
                    "a daemon speaking a different protocol is running; stop it with `strive stop` from that release, or kill it"
                );
            }
            Err(e) if e.downcast_ref::<ServerError>().is_some() => return Err(e),
            // Connected, but the daemon went away mid-handshake (idle exit or
            // shutdown). The next pass starts a fresh one.
            Err(_) => {}
        }
        if Instant::now() > deadline {
            bail!("the daemon did not start within {}s; see {}", START_TIMEOUT.as_secs(), home.log().display());
        }
        tokio::time::sleep(RETRY).await;
    }
}

/// The error a failed daemon printed as it exited: the log's last line.
fn last_error(home: &Home) -> String {
    std::fs::read_to_string(home.log())
        .ok()
        .and_then(|log| log.lines().last().map(|l| l.strip_prefix("strive: ").unwrap_or(l).to_string()))
        .unwrap_or_else(|| format!("no log at {}", home.log().display()))
}

fn is_protocol_mismatch(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ServerError>().is_some_and(|s| s.0.code == RpcError::PROTOCOL_MISMATCH)
}

fn spawn(home: &Home) -> Result<Child> {
    let log = OpenOptions::new().create(true).append(true).open(home.log()).context("opening the daemon log")?;
    // Not in the directory of whatever command started it, which may be
    // removed while it runs: the hosts it starts would inherit a deleted
    // directory and fail to start. So its home is passed whole.
    Command::new(std::env::current_exe()?)
        .arg("daemon")
        .current_dir("/")
        .env("STRIVE_HOME", std::path::absolute(&home.root)?)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0) // detach from the terminal's job control and its Ctrl+C
        .spawn()
        .context("spawning the daemon")
}

/// Waits for a stopped daemon to finish exiting: its socket no longer answers
/// and it has released the lock.
pub async fn wait_until_gone(home: &Home) -> Result<()> {
    let deadline = Instant::now() + START_TIMEOUT;
    while Client::connect(&home.socket()).await.is_ok() || !lock_is_free(home) {
        if Instant::now() > deadline {
            bail!("the old daemon did not exit within {}s", START_TIMEOUT.as_secs());
        }
        tokio::time::sleep(RETRY).await;
    }
    Ok(())
}

/// True when no daemon holds the lock. Taking it for this probe is harmless: a
/// daemon starting at the same moment waits for it (see `server::run`).
fn lock_is_free(home: &Home) -> bool {
    let Ok(f) = File::options().create(true).truncate(false).write(true).open(home.lock()) else {
        return false;
    };
    match f.try_lock() {
        Ok(()) => true,
        Err(TryLockError::WouldBlock | TryLockError::Error(_)) => false,
    }
}
