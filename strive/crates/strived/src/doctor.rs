//! `strive doctor`: checks everything a first run depends on and says how to fix it.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::paths::{Home, build_id};
use crate::{launch, tui};

enum Level {
    Ok,
    Warn,
    Fail,
}

struct Report {
    failed: bool,
}

impl Report {
    fn line(&mut self, level: &Level, what: &str, detail: &str) {
        let mark = match level {
            Level::Ok => "ok  ",
            Level::Warn => "warn",
            Level::Fail => {
                self.failed = true;
                "FAIL"
            }
        };
        println!("{mark}  {what:<14} {detail}");
    }
}

#[allow(
    clippy::verbose_bit_mask,
    reason = "`mode & 0o077` reads as a permission check"
)]
pub async fn run(home: &Home) -> Result<bool> {
    let mut r = Report { failed: false };
    println!("strive {} ({})\n", env!("CARGO_PKG_VERSION"), build_id());

    match std::fs::metadata(&home.root) {
        Ok(m) if m.permissions().mode() & 0o077 == 0 => {
            r.line(&Level::Ok, "home", &home.root.display().to_string());
        }
        Ok(_) => r.line(
            &Level::Warn,
            "home",
            &format!(
                "{} is readable by other users; run chmod 700 on it",
                home.root.display()
            ),
        ),
        Err(_) => r.line(
            &Level::Ok,
            "home",
            &format!("{} (created on first run)", home.root.display()),
        ),
    }

    match launch::ensure(home, "strive-doctor").await {
        Ok((_, init)) => r.line(
            &Level::Ok,
            "daemon",
            &format!(
                "pid {}, protocol {}",
                init.server.pid, init.protocol_version
            ),
        ),
        Err(e) => r.line(
            &Level::Fail,
            "daemon",
            &format!("{e:#}; see {}", home.log().display()),
        ),
    }

    match tui::locate() {
        Ok(cmd) => r.line(&Level::Ok, "tui", &cmd.join(" ")),
        Err(e) => r.line(&Level::Fail, "tui", &format!("{e:#}")),
    }

    if cfg!(target_os = "macos") {
        let p = Path::new("/usr/bin/sandbox-exec");
        if p.exists() {
            r.line(&Level::Ok, "sandbox", "sandbox-exec (Seatbelt)");
        } else {
            r.line(
                &Level::Warn,
                "sandbox",
                "sandbox-exec missing; commands will need approval",
            );
        }
    } else {
        match which("bwrap") {
            Some(p) => r.line(
                &Level::Ok,
                "sandbox",
                &format!("bubblewrap at {}", p.display()),
            ),
            None => r.line(
                &Level::Warn,
                "sandbox",
                "install bubblewrap (bwrap) to sandbox commands",
            ),
        }
    }

    match which("git") {
        Some(p) => r.line(&Level::Ok, "git", &p.display().to_string()),
        None => r.line(
            &Level::Warn,
            "git",
            "git not found; checkpoints and /rewind need it",
        ),
    }

    let keys: Vec<&str> = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
        .into_iter()
        .filter(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty()))
        .collect();
    if keys.is_empty() {
        r.line(
            &Level::Warn,
            "credentials",
            "no API key in the environment; /login arrives with the model gateway",
        );
    } else {
        r.line(
            &Level::Ok,
            "credentials",
            &format!("{} set", keys.join(", ")),
        );
    }

    Ok(!r.failed)
}

pub fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join(bin))
            .find(|p| p.is_file())
    })
}
