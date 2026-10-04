//! A vendor engine's tool calls (ADR-0031): the vendor runs its own tools,
//! and the daemon gates each one before it runs, as it does its own
//! effects, and journals it as `observed`. strive doesn't run them, so it
//! never runs one again after a crash.

use std::sync::Arc;

use serde_json::Value;
use strive_proto::rpc::RpcError;
use strive_proto::{
    ApprovalMode, Decision, EffectObserve, EffectObserveParams, EffectObserved, EffectOutcome, EffectRecord,
    EffectReport, EffectReportParams, EffectRequest, Empty, Engine, Event, SessionKind,
};

use crate::effects::Gate;
use crate::methods::{Reply, internal, parse, reply, session_error, session_id, workspace_of};
use crate::server::State;
use crate::sessions::Answer;

/// What a vendor's tool call amounts to, as strive's own effects name it,
/// for the gate and hooks: `None` for a tool that changes nothing.
fn as_request(tool: &str, input: &Value) -> Option<EffectRequest> {
    let text = |key: &str| input.get(key).and_then(Value::as_str).map(str::to_string);
    let path = || text("file_path").or_else(|| text("notebook_path")).or_else(|| text("path"));
    match tool {
        "Read" | "NotebookRead" | "Glob" | "Grep" | "LS" => {
            Some(EffectRequest::Read { path: path().unwrap_or_else(|| ".".into()), offset: None, limit: None })
        }
        "Write" => Some(EffectRequest::Write { path: path()?, content: text("content").unwrap_or_default() }),
        "Edit" | "MultiEdit" | "NotebookEdit" => {
            Some(EffectRequest::Edit { path: path()?, old_text: String::new(), new_text: String::new() })
        }
        "Bash" => Some(EffectRequest::Bash { command: text("command").unwrap_or_default(), timeout_ms: None }),
        _ => None,
    }
}

/// Tools that change nothing outside the vendor's own conversation: plans,
/// to-dos, and subagents (whose own tool calls are gated one by one).
const INERT: &[&str] = &["TodoWrite", "Task", "Agent", "ExitPlanMode", "EnterPlanMode", "BashOutput", "KillShell"];

/// The gate for a vendor's tool call. A file change and a read are gated
/// as strive's own are (strive's state is refused, and guarded files ask a
/// person in every mode). A command runs in the vendor's sandbox, not
/// strive's, so only the mode decides it. Anything else, a fetch from the
/// network included, asks unless the mode is full-auto.
fn gate(
    scope: &crate::effects::Scope,
    tool: &str,
    request: Option<&EffectRequest>,
    mode: ApprovalMode,
    allowed: &[std::path::PathBuf],
) -> Gate {
    let full_auto = mode == ApprovalMode::FullAuto;
    match request {
        Some(EffectRequest::Bash { .. }) if full_auto => Gate::Allow,
        Some(EffectRequest::Bash { command, .. }) => Gate::Ask(format!("run: {command}"), None),
        Some(r) => crate::effects::gate(scope, r, mode, allowed).0,
        None if INERT.contains(&tool) || full_auto => Gate::Allow,
        None => Gate::Ask(format!("use Claude Code's {tool} tool"), None),
    }
}

/// `effect/observe`: journals the call, decides it as the daemon decides
/// its own (the mode, guarded files, hooks, a person), and journals that
/// it may run, or how it was refused.
pub async fn observe(state: &Arc<State>, params: Value) -> Reply {
    let EffectObserveParams { id, call_id, tool, input } = parse::<EffectObserve>(params)?;
    let sid = session_id(&id)?;
    let info = state.sessions.info(&sid).await.map_err(session_error)?;
    if info.kind == Some(SessionKind::Learning) {
        return Err(RpcError::new(RpcError::INVALID_REQUEST, "a learning session runs no tools"));
    }
    let workspace = workspace_of(&info.cwd)?;
    let strive_home = state.home.root.canonicalize().map_err(|e| internal(&e))?;
    let (ws, home) = (workspace.clone(), strive_home.clone());
    let imports =
        tokio::task::spawn_blocking(move || crate::context::imports(&ws, &home)).await.map_err(|e| internal(&e))?;
    let scope = crate::effects::Scope {
        workspace,
        strive_home,
        unconfined: state.settings.sandbox == crate::settings::SandboxSetting::Off,
        imports,
    };
    let bytes = serde_json::to_vec(&input).map_err(|e| internal(&e))?;
    let record = EffectRecord::Observed {
        engine: Engine::ClaudeCode,
        tool: tool.clone(),
        input: state.cas.put(&bytes).map_err(|e| internal(&e))?,
    };
    let effect = state.sessions.start_effect(&sid, call_id.clone(), record).await.map_err(session_error)?;
    let (mode, allowed) = state.sessions.approvals(&sid).await.map_err(session_error)?;
    let request = as_request(&tool, &input);
    let first = gate(&scope, &tool, request.as_ref(), mode, &allowed);
    let gated = match &request {
        Some(r) => {
            let hooked = crate::hooks::stricter(state, &info, &scope, r, &allowed, first).await;
            let events = hooked
                .decided
                .into_iter()
                .map(|d| Event::HookDecided {
                    effect,
                    extension: d.extension,
                    digest: d.digest,
                    answer: d.answer,
                    reason: d.reason,
                })
                .collect::<Vec<_>>();
            if !events.is_empty() {
                state.sessions.append(&sid, events).await.map_err(session_error)?;
            }
            hooked.gate
        }
        None => first,
    };
    let cancelled = state.sessions.cancel_flag(&sid, &call_id);
    let refusal = match gated {
        Gate::Allow => None,
        Gate::Deny(why) => Some(why),
        Gate::Ask(what, file) => {
            let file = file.map(|f| f.display().to_string());
            match state.sessions.ask(&sid, effect, what.clone(), file, &cancelled).await.map_err(session_error)? {
                Answer::Decided(Decision::Allow | Decision::AllowSession) => None,
                Answer::Decided(Decision::Deny) => Some(format!("declined: {what}")),
                Answer::Cancelled => Some(format!("interrupted: {what}")),
                Answer::NoOne => {
                    Some(format!("{what} needs a person's approval, and no client is attached to give it"))
                }
            }
        }
    };
    state.sessions.forget_cancel(&sid, &call_id);
    match refusal {
        None => {
            state.sessions.append(&sid, vec![Event::EffectCleared { effect }]).await.map_err(session_error)?;
            reply::<EffectObserve>(EffectObserved { effect, allowed: true, reason: None })
        }
        Some(reason) => {
            let outcome = EffectOutcome::Refused { reason: reason.clone() };
            state.sessions.finish_effect(&sid, effect, outcome, 0).await.map_err(session_error)?;
            reply::<EffectObserve>(EffectObserved { effect, allowed: false, reason: Some(reason) })
        }
    }
}

/// `effect/report`: how an observed call the daemon cleared ended, as the
/// vendor gave it to the model. Only an observed effect, cleared and not
/// yet finished, takes a report.
pub async fn report(state: &Arc<State>, params: Value) -> Reply {
    let EffectReportParams { id, effect, output, failed } = parse::<EffectReport>(params)?;
    let sid = session_id(&id)?;
    let (_, journal) = state.sessions.read(&sid).map_err(session_error)?;
    let observed = journal.entries.iter().any(|e| {
        matches!(&e.event, Event::EffectStarted { effect: n, record: EffectRecord::Observed { .. }, .. } if *n == effect)
    });
    let cleared = journal.entries.iter().any(|e| matches!(e.event, Event::EffectCleared { effect: n } if n == effect));
    if !observed || !cleared {
        return Err(RpcError::new(
            RpcError::INVALID_PARAMS,
            format!("effect {effect} isn't an observed call the daemon allowed"),
        ));
    }
    if journal.entries.iter().any(|e| matches!(e.event, Event::EffectFinished { effect: n, .. } if n == effect)) {
        return Err(RpcError::new(RpcError::INVALID_PARAMS, format!("effect {effect} was already reported")));
    }
    let digest = state.cas.put(output.as_bytes()).map_err(|e| internal(&e))?;
    // A vendor's failed tool reads as a nonzero exit; its output says how.
    let outcome = EffectOutcome::Done { output: digest, exit_code: failed.then_some(1), truncated: false };
    state.sessions.finish_effect(&sid, effect, outcome, 0).await.map_err(session_error)?;
    reply::<EffectReport>(Empty {})
}
