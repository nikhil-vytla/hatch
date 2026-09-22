//! `strive`: start in any repository with no configuration.
//!
//! With no subcommand, `strive` makes sure the per-user daemon is running and
//! current, then hands the terminal to the TUI.

mod client;
mod doctor;
mod launch;
mod log;
mod paths;
mod server;
mod tui;

use std::process::ExitCode;
use std::time::Duration;

use anyhow::Result;
use clap::{Parser, Subcommand};
use strive_proto::{DaemonShutdown, DaemonStatus, Empty};

use crate::paths::Home;

#[derive(Parser)]
#[command(
    name = "strive",
    version,
    about = "A self-improving coding agent you can trust."
)]
struct Cli {
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
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
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
            tui::exec(&home)?;
            unreachable!("exec returns only on error")
        }
        Some(Cmd::Status { json }) => {
            let (mut c, _) = launch::ensure(&home, "strive-status").await?;
            let s = c.request::<DaemonStatus>(Empty {}).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&s)?);
            } else {
                println!(
                    "daemon  pid {}  up {}s  clients {}",
                    s.server.pid,
                    s.uptime_ms / 1000,
                    s.clients
                );
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
        Some(Cmd::Doctor) => Ok(if doctor::run(&home).await? {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        }),
        Some(Cmd::Daemon { idle_exit_secs }) => {
            match server::run(server::Config {
                home,
                idle_exit: Duration::from_secs(idle_exit_secs),
            })
            .await?
            {
                server::Started::Served | server::Started::AlreadyRunning => Ok(ExitCode::SUCCESS),
            }
        }
    }
}
