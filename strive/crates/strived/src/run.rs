//! `strive run`: one task, headless. It starts a session here, sends the
//! task as its prompt, prints the turn as it happens, and exits with how the
//! turn ended. For scripts and benchmarks: nothing asks a person, so
//! unattended runs want `--approvals full-auto`.

use std::process::ExitCode;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use strive_proto::{
    ApprovalMode, Entry, Event, SessionApprovals, SessionApprovalsParams, SessionAttach, SessionAttachParams,
    SessionBudget, SessionBudgetParams, SessionCreate, SessionCreateParams, SessionEntryNotification, SessionInterrupt,
    SessionPrompt, SessionPromptParams, SessionRef, TurnEnd,
};

use crate::client::Client;

pub struct Options {
    /// strive's home, where the session's host log is.
    pub home: std::path::PathBuf,
    pub task: String,
    pub json: bool,
    pub approvals: Option<ApprovalMode>,
    pub budget_usd: Option<f64>,
}

/// How long the agent's host has to start the turn.
const START_TIMEOUT: Duration = Duration::from_secs(60);

/// Exit codes: 0 the turn finished; 1 it failed; 3 it hit its time limit;
/// 4 it was interrupted.
fn exit_code(reason: &TurnEnd) -> ExitCode {
    ExitCode::from(match reason {
        TurnEnd::Done => 0,
        TurnEnd::Failed { .. } => 1,
        TurnEnd::TimedOut { .. } => 3,
        TurnEnd::Interrupted => 4,
    })
}

pub async fn run(c: &mut Client, opts: Options) -> Result<ExitCode> {
    let cwd = std::env::current_dir()?.canonicalize()?.display().to_string();
    let session = c.request::<SessionCreate>(SessionCreateParams { cwd }).await?;
    let id = session.id.clone();
    if let Some(mode) = opts.approvals {
        c.request::<SessionApprovals>(SessionApprovalsParams { id: id.clone(), mode }).await?;
    }
    if let Some(usd) = opts.budget_usd {
        if !(usd.is_finite() && usd >= 0.0) {
            bail!("--budget is a number of dollars, 0 or more");
        }
        #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "checked non-negative just above")]
        let usd_micros = Some((usd * 1_000_000.0).round() as u64);
        c.request::<SessionBudget>(SessionBudgetParams { id: id.clone(), usd_micros, tokens: None }).await?;
    }
    // An observer: nobody here can approve, so approval requests don't wait.
    let attached = c
        .request::<SessionAttach>(SessionAttachParams { id: id.clone(), after_seq: None, observer: Some(true) })
        .await?;
    for e in &attached.entries {
        show(e, opts.json)?;
    }
    let shown = attached.entries.last().map_or(0, |e| e.seq);
    let prompt = c.request::<SessionPrompt>(SessionPromptParams { id: id.clone(), text: opts.task }).await?.seq;
    if !opts.json {
        eprintln!("strive: session {id} (strive log {id} shows it again)");
    }

    let mut turn: Option<u64> = None;
    let started = tokio::time::Instant::now();
    let mut interrupted = false;
    loop {
        let note = tokio::select! {
            n = c.notification() => n?,
            _ = tokio::signal::ctrl_c(), if !interrupted => {
                interrupted = true;
                c.request::<SessionInterrupt>(SessionRef { id: id.clone() }).await?;
                continue;
            }
                        () = tokio::time::sleep_until(started + START_TIMEOUT), if turn.is_none() => {
                let log = opts.home.join("sessions").join(&id).join("host.log");
                let tail = std::fs::read_to_string(&log).unwrap_or_default();
                let lines: Vec<&str> = tail.lines().collect();
                let last = lines.get(lines.len().saturating_sub(8)..).unwrap_or_default();
                bail!(
                    "the agent didn't start within {}s (see `strive doctor`); {} ends:\n{}",
                    START_TIMEOUT.as_secs(),
                    log.display(),
                    if last.is_empty() { "(nothing: the host may not have started at all)".to_string() } else { last.join("\n") }
                );
            }
        };
        if note.method.as_deref() != Some("session/entry") {
            continue;
        }
        let entry: SessionEntryNotification =
            serde_json::from_value(note.params.unwrap_or_default()).context("a session/entry notification")?;
        if entry.session_id != id {
            continue;
        }
        let entry = entry.entry;
        if entry.seq <= shown {
            continue; // shown from the attach already
        }
        show(&entry, opts.json)?;
        match &entry.event {
            // The turn that took this run's prompt.
            Event::TurnStarted { turn: n, through_seq }
                if through_seq.is_none_or(|s| s >= prompt) && turn.is_none() =>
            {
                turn = Some(*n);
            }
            Event::TurnEnded { turn: n, reason } if Some(*n) == turn => return Ok(exit_code(reason)),
            _ => {}
        }
    }
}

/// One entry: a JSON line, or the line `strive log` would print.
fn show(e: &Entry, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string(e)?);
    } else {
        let text = crate::commands::describe(e);
        if !text.is_empty() {
            println!("{text}");
        }
    }
    Ok(())
}
