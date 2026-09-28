//! Opening the desktop app, which runs on its own: `strive app` returns
//! once it has started.

use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

use anyhow::{Result, bail};

use crate::paths::Home;
use crate::tui::Session;

/// The command that starts the desktop app.
///
/// `STRIVE_DESKTOP` wins (development: `bunx electron /path/to/apps/desktop`);
/// otherwise `strive-desktop` next to this executable.
fn locate() -> Result<Vec<String>> {
    if let Ok(cmd) = std::env::var("STRIVE_DESKTOP") {
        let parts: Vec<String> = cmd.split_whitespace().map(String::from).collect();
        if !parts.is_empty() {
            return Ok(parts);
        }
    }
    let sibling = std::env::current_exe()?.with_file_name("strive-desktop");
    if sibling.is_file() {
        return Ok(vec![sibling.display().to_string()]);
    }
    bail!(
        "the desktop app isn't installed next to {}; set STRIVE_DESKTOP to run it from source",
        std::env::current_exe()?.display()
    )
}

/// Starts the desktop app on the session, detached from this terminal.
pub fn open(home: &Home, session: &Session) -> Result<()> {
    let cmd = locate()?;
    let mut c = Command::new(&cmd[0]);
    c.args(&cmd[1..]).arg("--cwd").arg(std::env::current_dir()?);
    match session {
        Session::New => {}
        Session::Continue => {
            c.arg("--continue");
        }
        Session::Resume(id) => {
            c.args(["--resume", id]);
        }
    }
    c.env("STRIVE_SOCKET", home.socket())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| anyhow::anyhow!("starting the desktop app ({}): {e}", cmd.join(" ")))?;
    Ok(())
}
