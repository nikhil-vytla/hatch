//! Starting or attaching to the daemon, and replacing a stale one.

use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use strive_proto::rpc::RpcError;
use strive_proto::{DaemonShutdown, Empty, InitializeResult};

use crate::client::{Client, ServerError};
use crate::paths::{Home, build_id};

const START_TIMEOUT: Duration = Duration::from_secs(5);

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
pub async fn ensure(home: &Home, client_name: &str) -> Result<(Client, InitializeResult)> {
    home.ensure()?;
    match attach(home, client_name).await {
        Ok(Some((c, init))) if init.server.build == build_id() => return Ok((c, init)),
        Ok(Some((mut c, init))) => {
            crate::log!(
                "replacing stale daemon {} (pid {})",
                init.server.build,
                init.server.pid
            );
            let _ = c.request::<DaemonShutdown>(Empty {}).await;
            wait_until_gone(home).await?;
        }
        Ok(None) => {}
        Err(e) if is_protocol_mismatch(&e) => {
            // A daemon from an incompatible release: we can't ask it nicely.
            bail!(
                "a daemon speaking a different protocol is running; stop it with `strive stop` from that release, or kill it"
            );
        }
        Err(e) => return Err(e),
    }
    spawn(home)?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        if let Some(pair) = attach(home, client_name).await.ok().flatten() {
            return Ok(pair);
        }
        if Instant::now() > deadline {
            bail!(
                "the daemon did not start within {}s; see {}",
                START_TIMEOUT.as_secs(),
                home.log().display()
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn is_protocol_mismatch(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ServerError>()
        .is_some_and(|s| s.0.code == RpcError::PROTOCOL_MISMATCH)
}

fn spawn(home: &Home) -> Result<()> {
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(home.log())
        .context("opening the daemon log")?;
    Command::new(std::env::current_exe()?)
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0) // detach from the terminal's job control and its Ctrl+C
        .spawn()
        .context("spawning the daemon")?;
    Ok(())
}

/// Waits for a daemon to release the socket after a shutdown request.
pub async fn wait_until_gone(home: &Home) -> Result<()> {
    let deadline = Instant::now() + START_TIMEOUT;
    while home.socket().exists() || Client::connect(&home.socket()).await.is_ok() {
        if Instant::now() > deadline {
            bail!(
                "the old daemon did not exit within {}s",
                START_TIMEOUT.as_secs()
            );
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    Ok(())
}
