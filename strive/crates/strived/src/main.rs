//! `strive`: start in any repository with no configuration.
//!
//! With no subcommand, `strive` makes sure the per-user daemon is running and
//! current, then hands the terminal to the TUI.

mod checkpoints;
mod client;
mod commands;
mod context;
mod credentials;
mod doctor;
mod effects;
mod gateway;
mod hosts;
mod launch;
mod log;
mod mcp;
mod methods;
mod paths;
mod pinned;
mod server;
mod sessions;
mod settings;
mod sync;

mod tui;
mod workspaces;

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
    #[command(subcommand)]
    command: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
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

async fn run(cli: Cli) -> Result<ExitCode> {
    let home = Home::discover()?;
    match cli.command {
        None => {
            launch::ensure(&home, "strive").await?;
            let session = match (cli.continue_latest, cli.resume) {
                (_, Some(id)) => tui::Session::Resume(id),
                (true, None) => tui::Session::Continue,
                (false, None) => tui::Session::New,
            };
            tui::exec(&home, &session)?;
            unreachable!("exec returns only on error")
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
                    c.request::<DaemonShutdown>(Empty {}).await?;
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
