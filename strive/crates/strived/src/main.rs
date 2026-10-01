//! `strive`: start in any repository with no configuration.
//!
//! With no subcommand, `strive` makes sure the per-user daemon is running and
//! current, then hands the terminal to the TUI.

mod checkpoints;
mod checks;
mod client;
mod commands;
mod context;
mod credentials;
mod desktop;

mod doctor;
mod effects;
mod extensions;
mod gateway;
mod hooks;
mod hosts;
mod judge;
mod launch;
mod learning;
mod log;
mod mcp;
mod methods;
mod paths;
mod pinned;
mod review;
mod run;

mod server;
mod sessions;
mod settings;
mod sync;
mod terminal;

mod triggers;
mod tui;
mod workspaces;

use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use strive_proto::{DaemonShutdown, DaemonStatus, Empty};

use crate::paths::Home;

#[derive(Parser)]
#[command(name = "strive", version, about = "A self-improving coding agent you can trust.")]
struct Cli {
    /// Continue the latest session in this directory.
    #[arg(short = 'c', long = "continue", conflicts_with = "resume")]
    continue_latest: bool,
    /// Resume a session by id (see `strive sessions`).
    #[arg(short = 'r', long, value_name = "ID")]
    resume: Option<String>,
    /// Start a new session in safe mode: no extension's tools or hooks run in it.
    #[arg(long, conflicts_with_all = ["continue_latest", "resume"])]
    safe: bool,
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run one task headless in a new session here, and exit with how it ended
    /// (0 done, 1 failed, 3 timed out, 4 interrupted).
    Run {
        /// The task; read from stdin if omitted or `-`.
        task: Option<String>,
        /// Print each journal entry as a JSON line.
        #[arg(long)]
        json: bool,
        /// What the agent may do without asking: ask, auto-edit or full-auto.
        /// No one is there to approve, so unattended runs want full-auto.
        #[arg(long, value_parser = ["ask", "auto-edit", "full-auto"])]
        approvals: Option<String>,
        /// The session's spending limit, in dollars.
        #[arg(long, value_name = "USD")]
        budget: Option<f64>,
        /// Safe mode: no extension's tools or hooks run in the session.
        #[arg(long)]
        safe: bool,
    },
    /// Open the desktop app on a new session in this directory.
    App {
        /// Continue the latest session in this directory.
        #[arg(short = 'c', long = "continue", conflicts_with = "resume")]
        continue_latest: bool,
        /// Resume a session by id.
        #[arg(short = 'r', long, value_name = "ID")]
        resume: Option<String>,
        /// Start a new session in safe mode: no extension's tools or hooks run in it.
        #[arg(long, conflicts_with_all = ["continue_latest", "resume"])]
        safe: bool,
    },
    /// Show the daemon's status.
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Stop the daemon. It also exits on its own after it has had no clients for a while.
    Stop,
    /// Check that everything strive needs is in place.
    Doctor,
    /// Show a session's journal (default: the latest session in this directory).
    Log {
        id: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Check that session journals are intact. Exits 1 if any is not.
    Verify {
        id: Option<String>,
        /// Every session, in every directory.
        #[arg(long, conflicts_with = "id")]
        all: bool,
    },
    /// Print a session's model gateway URLs as `ANTHROPIC_BASE_URL` and
    /// `OPENAI_BASE_URL`, so any SDK-based tool runs under its budget and journal.
    Gateway { id: Option<String> },
    /// Store a provider API key, or with no provider, show which keys are set.
    Auth {
        #[arg(value_parser = ["anthropic", "openai"])]
        provider: Option<String>,
    },
    /// List sessions started in this directory, newest first.
    Sessions {
        /// Sessions from every directory.
        #[arg(long)]
        all: bool,
        #[arg(long)]
        json: bool,
    },
    /// Ask this project's learner to study its sessions and propose changes
    /// to the agent's memory and skills, then show what it proposed.
    Learn {
        /// A work session to study (repeatable); default: those since it last looked.
        #[arg(long = "session", value_name = "ID")]
        sessions: Vec<String>,
    },
    /// List the learner's proposals here; with an id, show one (its diff
    /// and checks), or accept, reject or roll it back.
    Review {
        id: Option<u64>,
        #[arg(requires = "id", value_parser = ["accept", "reject", "rollback"])]
        action: Option<String>,
        /// With an id: also why, the evidence, and each check in full.
        #[arg(long, requires = "id")]
        full: bool,
        /// Show the memory as every session reads it now, each bullet with
        /// the proposal that last wrote it.
        #[arg(long, conflicts_with = "id")]
        memory: bool,
    },
    /// Run the daemon in the foreground (normally started for you).
    #[command(hide = true)]
    Daemon {
        /// Seconds with no clients before exiting.
        #[arg(long, env = "STRIVE_IDLE_SECS", default_value_t = 900)]
        idle_exit_secs: u64,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if matches!(cli.command, Some(Cmd::Daemon { .. }))
        && let Err(e) = close_inherited(&[Path::new("/dev/fd"), Path::new("/proc/self/fd")])
    {
        eprintln!("strive: {e}");
        return ExitCode::FAILURE;
    }
    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("strive: could not start the async runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run(cli)) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("strive: {e:#}");
            ExitCode::FAILURE
        }
    }
}

/// Closes every descriptor above stderr that the daemon was started with.
/// A launcher (a CI runner, an editor, a shell) can leave descriptors open
/// across exec, and every command, host and MCP server the daemon starts
/// would inherit them, sandboxed commands included. Run before the runtime
/// exists, so nothing of the daemon's own is open yet. It fails closed: a
/// daemon that can't list its descriptors, or finds one still open after
/// closing, doesn't start.
fn close_inherited(listings: &[&Path]) -> Result<()> {
    let (listing, open) = listings
        .iter()
        .find_map(|dir| open_fds(dir).ok().map(|fds| (*dir, fds)))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "can't list the daemon's open descriptors (tried {}), so it can't close ones it was started with; not starting",
                listings.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", ")
            )
        })?;
    for fd in open.into_iter().filter(|fd| *fd > 2) {
        // EBADF is the listing's own descriptor, already closed; anything
        // else shows as still open below.
        let _ = nix::unistd::close(fd);
    }
    // The new listing opens one descriptor of its own, the lowest free one;
    // it's the only one above stderr only if every other was closed.
    let left: Vec<i32> = open_fds(listing)?.into_iter().filter(|fd| *fd > 2).collect();
    anyhow::ensure!(
        left.len() <= 1,
        "descriptors it was started with stay open after closing them ({left:?}); not starting"
    );
    Ok(())
}

/// The descriptors a listing directory (`/dev/fd`) shows, read whole first:
/// the listing holds a descriptor of its own while it's read.
fn open_fds(dir: &Path) -> std::io::Result<Vec<i32>> {
    Ok(std::fs::read_dir(dir)?.filter_map(Result::ok).filter_map(|e| e.file_name().to_str()?.parse().ok()).collect())
}

#[expect(clippy::too_many_lines, reason = "one short arm per command")]
async fn run(cli: Cli) -> Result<ExitCode> {
    let home = Home::discover()?;
    match cli.command {
        None => {
            launch::ensure(&home, "strive").await?;
            let session = match (cli.continue_latest, cli.resume) {
                (_, Some(id)) => tui::Session::Resume(id),
                (true, None) => tui::Session::Continue,
                (false, None) => tui::Session::New { safe: cli.safe },
            };
            tui::exec(&home, &session)?;
            unreachable!("exec returns only on error")
        }
        Some(Cmd::Run { task, json, approvals, budget, safe }) => {
            let task = match task.as_deref() {
                None | Some("-") => std::io::read_to_string(std::io::stdin())?,
                Some(t) => t.to_string(),
            };
            if task.trim().is_empty() {
                anyhow::bail!("no task: give it as an argument or on stdin");
            }
            let approvals = approvals.map(|a| match a.as_str() {
                "ask" => strive_proto::ApprovalMode::Ask,
                "auto-edit" => strive_proto::ApprovalMode::AutoEdit,
                _ => strive_proto::ApprovalMode::FullAuto,
            });
            let (mut c, _) = launch::ensure(&home, "strive-run").await?;
            let opts = run::Options {
                home: home.root.clone(),
                task: task.trim().to_string(),
                json,
                approvals,
                budget_usd: budget,
                safe,
            };
            run::run(&mut c, opts).await
        }
        Some(Cmd::App { continue_latest, resume, safe }) => {
            launch::ensure(&home, "strive-app").await?;
            let session = match (continue_latest, resume) {
                (_, Some(id)) => tui::Session::Resume(id),
                (true, None) => tui::Session::Continue,
                (false, None) => tui::Session::New { safe },
            };
            desktop::open(&home, &session)?;
            println!("opened the desktop app");
            Ok(ExitCode::SUCCESS)
        }
        Some(Cmd::Log { id, json }) => commands::log(&mut launch::ensure(&home, "strive-log").await?.0, id, json).await,
        Some(Cmd::Verify { id, all }) => {
            commands::verify(&mut launch::ensure(&home, "strive-verify").await?.0, id, all).await
        }
        Some(Cmd::Gateway { id }) => commands::gateway(&mut launch::ensure(&home, "strive-gateway").await?.0, id).await,
        Some(Cmd::Auth { provider }) => {
            commands::auth(&mut launch::ensure(&home, "strive-auth").await?.0, provider).await
        }
        Some(Cmd::Sessions { all, json }) => {
            commands::sessions(&mut launch::ensure(&home, "strive-sessions").await?.0, all, json).await
        }
        Some(Cmd::Learn { sessions }) => {
            review::learn(&mut launch::ensure(&home, "strive-learn").await?.0, &home.root, sessions).await
        }
        Some(Cmd::Review { memory: true, .. }) => {
            review::memory(&mut launch::ensure(&home, "strive-review").await?.0).await
        }
        Some(Cmd::Review { id, action, full, memory: false }) => {
            let action = action.map(|a| match a.as_str() {
                "accept" => review::Action::Accept,
                "reject" => review::Action::Reject,
                _ => review::Action::Rollback,
            });
            review::review(&mut launch::ensure(&home, "strive-review").await?.0, id, action, full).await
        }
        Some(Cmd::Status { json }) => {
            let (mut c, _) = launch::ensure(&home, "strive-status").await?;
            let s = c.request::<DaemonStatus>(Empty {}).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&s)?);
            } else {
                println!("daemon  pid {}  up {}s  clients {}", s.server.pid, s.uptime_ms / 1000, s.clients);
                println!("build   {}", s.server.build);
                println!("socket  {}", home.socket().display());
                println!("log     {}", home.log().display());
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Cmd::Stop) => {
            match launch::attach(&home, "strive-stop").await? {
                Some((mut c, init)) => {
                    // A daemon with nothing to wind down can exit before its
                    // reply is written; a closed connection then is the stop
                    // asked for. Whether it's really gone is checked next.
                    if let Err(e) = c.request::<DaemonShutdown>(Empty {}).await
                        && e.downcast_ref::<client::ServerError>().is_some()
                    {
                        return Err(e);
                    }
                    launch::wait_until_gone(&home).await?;
                    println!("stopped daemon (pid {})", init.server.pid);
                }
                None => println!("no daemon running"),
            }
            Ok(ExitCode::SUCCESS)
        }
        Some(Cmd::Doctor) => Ok(if doctor::run(&home).await? { ExitCode::SUCCESS } else { ExitCode::FAILURE }),
        Some(Cmd::Daemon { idle_exit_secs }) => {
            match server::run(server::Config { home, idle_exit: Duration::from_secs(idle_exit_secs) }).await? {
                server::Started::Served | server::Started::AlreadyRunning => Ok(ExitCode::SUCCESS),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    /// A daemon that can't see its descriptors doesn't start with them. Only
    /// listings that don't exist are tried here: a real one would close the
    /// test process's own descriptors.
    #[test]
    fn a_daemon_that_cant_list_its_descriptors_doesnt_start() {
        let e = super::close_inherited(&[Path::new("/nonexistent/fd"), Path::new("/nonexistent/proc")]).unwrap_err();
        let text = e.to_string();
        assert!(text.contains("/nonexistent/fd, /nonexistent/proc") && text.ends_with("not starting"), "{text}");
    }
}
