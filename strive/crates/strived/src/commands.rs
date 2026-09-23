//! `strive log`, `strive verify` and `strive sessions`.

use std::process::ExitCode;

use anyhow::{Result, anyhow};
use strive_proto::{
    Entry, Event, SessionInfo, SessionList, SessionListParams, SessionRead, SessionReadResult, SessionRef,
};

use crate::client::Client;

fn cwd() -> Result<String> {
    Ok(std::env::current_dir()?.display().to_string())
}

async fn list(c: &mut Client, all: bool) -> Result<Vec<SessionInfo>> {
    let cwd = if all { None } else { Some(cwd()?) };
    Ok(c.request::<SessionList>(SessionListParams { cwd }).await?.sessions)
}

/// The given session, or the latest one started in this directory.
async fn resolve(c: &mut Client, id: Option<String>) -> Result<String> {
    if let Some(id) = id {
        return Ok(id);
    }
    list(c, false)
        .await?
        .into_iter()
        .next()
        .map(|s| s.id)
        .ok_or_else(|| anyhow!("no sessions in {}; start one with `strive`", cwd().unwrap_or_default()))
}

fn clock(ms: u64) -> String {
    i64::try_from(ms).ok().and_then(|ms| jiff::Timestamp::from_millisecond(ms).ok()).map_or_else(
        || "??:??:??".into(),
        |t| t.to_zoned(jiff::tz::TimeZone::system()).strftime("%H:%M:%S").to_string(),
    )
}

fn describe(e: &Entry) -> String {
    match &e.event {
        Event::SessionStarted { cwd, .. } => format!("started in {cwd}"),
        Event::UserMessage { text } => format!("you: {text}"),
        Event::Recovered { discarded_bytes } => {
            format!("recovered after a crash: discarded a partial entry ({discarded_bytes} bytes)")
        }
    }
}

pub async fn log(c: &mut Client, id: Option<String>, json: bool) -> Result<ExitCode> {
    let id = resolve(c, id).await?;
    let r = c.request::<SessionRead>(SessionRef { id }).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&r)?);
    } else {
        println!("session {}  {}", r.session.id, r.session.cwd);
        for e in &r.entries {
            println!("#{} {}  {}", e.seq, clock(e.ts_ms), describe(e));
        }
        if let Some(p) = &r.problem {
            println!("journal FAILED verification: {p}");
        }
    }
    Ok(if r.problem.is_some() { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

pub async fn verify(c: &mut Client, id: Option<String>, all: bool) -> Result<ExitCode> {
    let ids = if all { list(c, true).await?.into_iter().map(|s| s.id).collect() } else { vec![resolve(c, id).await?] };
    let mut failed = false;
    for id in ids {
        let r: SessionReadResult = c.request::<SessionRead>(SessionRef { id: id.clone() }).await?;
        match r.problem {
            Some(p) => {
                failed = true;
                println!("FAIL  {id}  {p}");
            }
            None => println!("ok    {id}  {} entries", r.entries.len()),
        }
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

pub async fn sessions(c: &mut Client, all: bool, json: bool) -> Result<ExitCode> {
    let sessions = list(c, all).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
    } else {
        for s in sessions {
            let when = i64::try_from(s.created_at_ms)
                .ok()
                .and_then(|ms| jiff::Timestamp::from_millisecond(ms).ok())
                .map_or_else(String::new, |t| {
                    t.to_zoned(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d %H:%M").to_string()
                });
            println!("{}  {when}  {}", s.id, s.cwd);
        }
    }
    Ok(ExitCode::SUCCESS)
}
