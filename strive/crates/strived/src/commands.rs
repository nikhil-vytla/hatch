//! `strive log`, `strive verify` and `strive sessions`.

use std::process::ExitCode;

use anyhow::{Result, anyhow};
use strive_budget::format_usd;
use strive_proto::{
    ApprovalMode, CallOutcome, Decision, EffectOutcome, EffectRecord, Entry, Event, SessionInfo, SessionList,
    SessionListParams, SessionRead, SessionReadResult, SessionRef, TurnEnd,
};

use crate::client::{Client, ServerError};

fn cwd() -> Result<String> {
    Ok(std::env::current_dir()?.display().to_string())
}

async fn list(c: &mut Client, all: bool) -> Result<Vec<SessionInfo>> {
    Ok(listing(c, all).await?.0)
}

/// Readable sessions, and the ids of unreadable ones (only with `all`).
async fn listing(c: &mut Client, all: bool) -> Result<(Vec<SessionInfo>, Vec<String>)> {
    let cwd = if all { None } else { Some(cwd()?) };
    let r = c.request::<SessionList>(SessionListParams { cwd }).await?;
    Ok((r.sessions, r.unreadable))
}

/// Every session id from a listing, newest first.
fn all_ids(sessions: &[SessionInfo], unreadable: &[String]) -> Vec<String> {
    let mut ids: Vec<String> = sessions.iter().map(|s| s.id.clone()).chain(unreadable.iter().cloned()).collect();
    ids.sort_by(|a, b| b.cmp(a));
    ids
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
        Event::BudgetSet { usd_micros, tokens } => match (usd_micros, tokens) {
            (None, None) => "budget: unlimited".into(),
            (Some(u), None) => format!("budget: {}", format_usd(*u)),
            (None, Some(t)) => format!("budget: {t} tokens"),
            (Some(u), Some(t)) => format!("budget: {} and {t} tokens", format_usd(*u)),
        },
        Event::ModelCallStarted { call, provider, model, reserved_usd_micros, .. } => {
            format!("model call {call}: {provider} {model}, holding up to {}", format_usd(*reserved_usd_micros))
        }
        Event::ModelCallFinished { call, outcome, duration_ms, .. } => match outcome {
            CallOutcome::Complete { usage, cost_usd_micros, .. } => format!(
                "model call {call} done in {}.{}s: {} in, {} out, {} cached · {}",
                duration_ms / 1000,
                duration_ms % 1000 / 100,
                usage.input,
                usage.output,
                usage.cache_read + usage.cache_write,
                format_usd(*cost_usd_micros)
            ),
            CallOutcome::Rejected { status } => format!("model call {call} refused by the provider (HTTP {status})"),
            CallOutcome::Broken { reason, cost_usd_micros, .. } => {
                format!("model call {call} broke ({reason}); charged its full hold of {}", format_usd(*cost_usd_micros))
            }
        },
        Event::EffectStarted { effect, record, .. } => format!("effect {effect}: {}", describe_effect(record)),
        Event::EffectFinished { effect, outcome, duration_ms } => match outcome {
            EffectOutcome::Done { exit_code: Some(code), .. } => {
                format!("effect {effect} done in {}.{}s, exit {code}", duration_ms / 1000, duration_ms % 1000 / 100)
            }
            EffectOutcome::Done { .. } => {
                format!("effect {effect} done in {}.{}s", duration_ms / 1000, duration_ms % 1000 / 100)
            }
            EffectOutcome::Refused { reason } => format!("effect {effect} refused: {reason}"),
            EffectOutcome::Interrupted => format!("effect {effect} interrupted: the daemon stopped while it ran"),
        },
        Event::ApprovalModeSet { mode } => format!("approvals: {}", mode_name(*mode)),
        Event::Checkpointed { checkpoint, .. } => format!("checkpoint {checkpoint}: files saved"),
        Event::Rewound { to, saved_as } => {
            format!("rewound to checkpoint {to}; the files before are checkpoint {saved_as}")
        }
        Event::TurnStarted { turn } => format!("turn {turn} started"),
        Event::ContextLoaded { instructions, skills } => {
            let files: Vec<&str> = instructions.iter().map(|f| f.path.as_str()).collect();
            format!(
                "agent context: {} instruction file(s){}, {} skill(s){}",
                files.len(),
                if files.is_empty() { String::new() } else { format!(" ({})", files.join(", ")) },
                skills.len(),
                if skills.is_empty() { String::new() } else { format!(" ({})", skills.join(", ")) }
            )
        }
        Event::AssistantMessage { text, tool_calls, .. } => {
            let calls: Vec<&str> = tool_calls.iter().map(|c| c.name.as_str()).collect();
            match (text.trim().is_empty(), calls.is_empty()) {
                (_, true) => format!("agent: {}", text.trim()),
                (true, false) => format!("agent calls {}", calls.join(", ")),
                (false, false) => format!("agent: {} (calls {})", text.trim(), calls.join(", ")),
            }
        }
        Event::TurnEnded { turn, reason } => match reason {
            TurnEnd::Done => format!("turn {turn} done"),
            TurnEnd::Interrupted => format!("turn {turn} interrupted"),
            TurnEnd::TimedOut { seconds } => format!("turn {turn} stopped at its {seconds}s limit"),
            TurnEnd::Failed { error } => format!("turn {turn} failed: {error}"),
        },
        Event::ApprovalRequested { effect, description } => format!("effect {effect} asks: {description}"),
        Event::ApprovalDecided { effect, decision, by } => format!(
            "effect {effect} {} by {by}",
            match decision {
                Decision::Allow => "allowed",
                Decision::AllowSession => "allowed for the rest of the session",
                Decision::Deny => "declined",
            }
        ),
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
    let ids = if all {
        let (sessions, unreadable) = listing(c, true).await?;
        all_ids(&sessions, &unreadable)
    } else {
        vec![resolve(c, id).await?]
    };
    let mut failed = false;
    for id in ids {
        match c.request::<SessionRead>(SessionRef { id: id.clone() }).await {
            Ok(SessionReadResult { problem: None, entries, .. }) => println!("ok    {id}  {} entries", entries.len()),
            Ok(SessionReadResult { problem: Some(p), .. }) => {
                failed = true;
                println!("FAIL  {id}  {p}");
            }
            Err(e) => match e.downcast_ref::<ServerError>().and_then(|s| s.0.data.as_ref()?.get("problem")?.as_str()) {
                Some(p) => {
                    failed = true;
                    println!("FAIL  {id}  {p}");
                }
                None => return Err(e),
            },
        }
    }
    Ok(if failed { ExitCode::FAILURE } else { ExitCode::SUCCESS })
}

pub async fn sessions(c: &mut Client, all: bool, json: bool) -> Result<ExitCode> {
    let (sessions, unreadable) = listing(c, all).await?;
    if json {
        println!("{}", serde_json::to_string_pretty(&sessions)?);
    } else {
        for id in &unreadable {
            println!("{id}  unreadable journal");
        }
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

pub async fn auth(c: &mut Client, provider: Option<String>) -> Result<ExitCode> {
    use std::io::IsTerminal;
    let Some(provider) = provider else {
        for p in c.request::<strive_proto::AuthStatus>(strive_proto::Empty {}).await?.providers {
            let source = match p.source.as_str() {
                "file" => "set with strive auth",
                "env" => "from the daemon's environment",
                _ => "not set",
            };
            println!("{:<10} {source}", p.provider);
        }
        return Ok(ExitCode::SUCCESS);
    };
    let key = if std::io::stdin().is_terminal() {
        rpassword::prompt_password(format!("Paste your {provider} API key (it won't be shown): "))?
    } else {
        let mut line = String::new();
        std::io::stdin().read_line(&mut line)?;
        line
    };
    c.request::<strive_proto::AuthSet>(strive_proto::AuthSetParams { provider: provider.clone(), api_key: key })
        .await?;
    println!("saved the {provider} key; new model calls use it");
    Ok(ExitCode::SUCCESS)
}

pub async fn gateway(c: &mut Client, id: Option<String>) -> Result<ExitCode> {
    let id = resolve(c, id).await?;
    let g = c.request::<strive_proto::SessionGateway>(SessionRef { id }).await?;
    println!("ANTHROPIC_BASE_URL={}", g.anthropic);
    println!("OPENAI_BASE_URL={}", g.openai);
    Ok(ExitCode::SUCCESS)
}

fn describe_effect(r: &EffectRecord) -> String {
    match r {
        EffectRecord::Read { path, .. } => format!("read {path}"),
        EffectRecord::Write { path, bytes, .. } => format!("write {path} ({bytes} bytes)"),
        EffectRecord::Edit { path, .. } => format!("edit {path}"),
        EffectRecord::Bash { command, .. } => format!("bash: {command}"),
    }
}

pub fn mode_name(m: ApprovalMode) -> &'static str {
    match m {
        ApprovalMode::Ask => "ask",
        ApprovalMode::AutoEdit => "auto-edit",
        ApprovalMode::FullAuto => "full-auto",
    }
}
