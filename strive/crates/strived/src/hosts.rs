//! Agent hosts: the processes that run a session's agent loop.
//!
//! A host registers for a session and then receives its prompts through the
//! session's entries. When a prompt arrives and no host is registered, the
//! daemon starts one. A host being started counts as present for a while,
//! so two prompts can't start two hosts.

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::sessions::SessionId;

const START_GRACE: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Slot {
    registered: u32,
    starting: Option<Instant>,
}

#[derive(Default)]
pub struct Hosts {
    slots: Mutex<HashMap<SessionId, Slot>>,
}

impl Hosts {
    pub fn register(&self, id: &SessionId) {
        let mut slots = crate::sync::lock(&self.slots);
        let slot = slots.entry(id.clone()).or_default();
        slot.registered += 1;
        slot.starting = None;
    }

    /// Connections registered as hosts: they don't keep the daemon awake.
    pub fn count(&self) -> u32 {
        crate::sync::lock(&self.slots).values().map(|s| s.registered).sum()
    }

    pub fn unregister(&self, id: &SessionId) {
        if let Some(slot) = crate::sync::lock(&self.slots).get_mut(id) {
            slot.registered = slot.registered.saturating_sub(1);
        }
    }

    /// Starts a host for the session unless one is registered or starting.
    pub fn ensure(&self, id: &SessionId, socket: &Path, log: &Path) {
        let Some(mut cmd) = command() else { return };
        {
            let mut slots = crate::sync::lock(&self.slots);
            let slot = slots.entry(id.clone()).or_default();
            if slot.registered > 0 || slot.starting.is_some_and(|t| t.elapsed() < START_GRACE) {
                return;
            }
            slot.starting = Some(Instant::now());
        }
        let Ok(out) = OpenOptions::new().create(true).append(true).open(log) else { return };
        let Ok(err) = out.try_clone() else { return };
        cmd.args(["--session", id.as_str()])
            .env("STRIVE_SOCKET", socket)
            .stdin(Stdio::null())
            .stdout(out)
            .stderr(err)
            .process_group(0);
        match cmd.spawn() {
            Ok(_) => crate::log!("started an agent host for session {}", id.as_str()),
            Err(e) => {
                crate::log!("could not start an agent host: {e}");
                if let Some(slot) = crate::sync::lock(&self.slots).get_mut(id) {
                    slot.starting = None;
                }
            }
        }
    }
}

/// How to start a host: `STRIVE_HOST` (a command line, or `none` to never
/// start one), else `strive-tui host` next to this executable.
fn command() -> Option<Command> {
    match std::env::var("STRIVE_HOST") {
        Ok(v) if v.trim() == "none" => None,
        Ok(v) if !v.trim().is_empty() => {
            let parts: Vec<&str> = v.split_whitespace().collect();
            let mut c = Command::new(parts[0]);
            c.args(&parts[1..]);
            Some(c)
        }
        _ => {
            let exe = std::env::current_exe().ok()?.with_file_name("strive-tui");
            exe.is_file().then(|| {
                let mut c = Command::new(exe);
                c.arg("host");
                c
            })
        }
    }
}
