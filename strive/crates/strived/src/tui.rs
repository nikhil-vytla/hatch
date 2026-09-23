//! Handing the terminal to the TUI client.

use std::io::IsTerminal;
use std::os::unix::process::CommandExt;
use std::process::Command;

use anyhow::{Result, bail};

use crate::paths::Home;

/// The command that starts the TUI.
///
/// `STRIVE_TUI` wins (development: `bun /path/to/packages/tui/src/main.ts`);
/// otherwise `strive-tui` next to this executable, where `install.sh` puts it.
pub fn locate() -> Result<Vec<String>> {
    if let Ok(cmd) = std::env::var("STRIVE_TUI") {
        let parts: Vec<String> = cmd.split_whitespace().map(String::from).collect();
        if !parts.is_empty() {
            return Ok(parts);
        }
    }
    let sibling = std::env::current_exe()?.with_file_name("strive-tui");
    if sibling.is_file() {
        return Ok(vec![sibling.display().to_string()]);
    }
    bail!("strive-tui not found next to {}; run ./install.sh or set STRIVE_TUI", std::env::current_exe()?.display())
}

/// Which session the TUI opens. Passed as `STRIVE_SESSION`: `new`,
/// `continue`, or a session id.
pub enum Session {
    New,
    Continue,
    Resume(String),
}

/// Replaces this process with the TUI. Only returns on failure.
pub fn exec(home: &Home, session: &Session) -> Result<()> {
    if !std::io::stdin().is_terminal() || !std::io::stdout().is_terminal() {
        bail!(
            "strive needs a terminal; for scripts use `strive status --json` (headless runs arrive with `strive run`)"
        );
    }
    let cmd = locate()?;
    let err = Command::new(&cmd[0])
        .args(&cmd[1..])
        .env("STRIVE_SOCKET", home.socket())
        .env("STRIVE_VERSION", env!("CARGO_PKG_VERSION"))
        .env(
            "STRIVE_SESSION",
            match session {
                Session::New => "new",
                Session::Continue => "continue",
                Session::Resume(id) => id,
            },
        )
        .exec();
    bail!("starting the TUI ({}): {err}", cmd.join(" "))
}
