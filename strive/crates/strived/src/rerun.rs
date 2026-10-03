//! Effects a crash cut off while they ran, run again where that is safe
//! (ADR-0030): a read, a write (the same content again leaves the same
//! file), and an edit whose file shows whether it landed. Only effects the
//! gate, the hooks and any person had cleared run again, on the decisions
//! the journal holds: nothing is asked again, and no hook runs again.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use strive_proto::rpc::RpcError;
use strive_proto::{ApprovalMode, EffectOutcome, EffectRecord, EffectRequest, Event, SessionKind};

use crate::effects::{Gate, Result as Done};
use crate::server::State;
use crate::sessions::SessionId;

/// Runs again each effect of the session that a crash cut off after it was
/// cleared, if its kind is safe to run again, and journals how it ended as
/// `effectRerun`. The rest stay interrupted.
pub async fn after_crash(state: &Arc<State>, sid: &SessionId) -> std::result::Result<usize, RpcError> {
    // Through the session's writer, which closes what a crash left open
    // before it takes any command: so the journal read next shows it.
    state.sessions.approvals(sid).await.map_err(crate::methods::session_error)?;
    let (info, report) = state.sessions.read(sid).map_err(crate::methods::session_error)?;
    if info.kind == Some(SessionKind::Learning) || report.problem.is_some() {
        return Ok(0);
    }
    let mut records = HashMap::new();
    let (mut cleared, mut cut_off, mut done) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
    for e in &report.entries {
        match &e.event {
            Event::EffectStarted { effect, record, .. } => {
                records.insert(*effect, record.clone());
            }
            Event::EffectCleared { effect } => {
                cleared.insert(*effect);
            }
            // Only recovery after a crash finishes an effect as interrupted.
            Event::EffectFinished { effect, outcome: EffectOutcome::Interrupted, .. } => {
                cut_off.insert(*effect);
            }
            Event::EffectRerun { effect, .. } => {
                done.insert(*effect);
            }
            _ => {}
        }
    }
    let due: Vec<u64> = cleared.intersection(&cut_off).filter(|e| !done.contains(e)).copied().collect();
    if due.is_empty() {
        return Ok(0);
    }
    let scope = scope(state, &info.cwd).await?;
    let mut ran = 0;
    for effect in due {
        let Some(request) = records.get(&effect).and_then(|r| request(state, r)) else { continue };
        let started = std::time::Instant::now();
        let Some(result) = perform(state, &scope, request).await? else { continue };
        let outcome = match result {
            Done::Done { text, exit_code, truncated } => {
                let output = state.cas.put(text.as_bytes()).map_err(|e| crate::methods::internal(&e))?;
                EffectOutcome::Done { output, exit_code, truncated }
            }
            Done::Refused(reason) => EffectOutcome::Refused { reason },
        };
        let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        state
            .sessions
            .append(sid, vec![Event::EffectRerun { effect, outcome, duration_ms }])
            .await
            .map_err(crate::methods::session_error)?;
        ran += 1;
    }
    Ok(ran)
}

/// Where the session's effects run, as `effect/run` has it.
async fn scope(state: &State, cwd: &str) -> std::result::Result<crate::effects::Scope, RpcError> {
    let workspace = crate::methods::workspace_of(cwd)?;
    let strive_home = state.home.root.canonicalize().map_err(|e| crate::methods::internal(&e))?;
    let (ws, home) = (workspace.clone(), strive_home.clone());
    let imports = tokio::task::spawn_blocking(move || crate::context::imports(&ws, &home))
        .await
        .map_err(|e| crate::methods::internal(&e))?;
    Ok(crate::effects::Scope {
        workspace,
        strive_home,
        unconfined: state.settings.sandbox == crate::settings::SandboxSetting::Off,
        imports,
    })
}

/// The request an effect of a kind safe to run again was; `None` for any
/// other kind, or if what it wrote isn't in the content store.
fn request(state: &State, record: &EffectRecord) -> Option<EffectRequest> {
    let text = |d| state.cas.get(d).ok().and_then(|b| String::from_utf8(b).ok());
    match record {
        EffectRecord::Read { path, offset, limit } => {
            Some(EffectRequest::Read { path: path.clone(), offset: *offset, limit: *limit })
        }
        EffectRecord::Write { path, content, .. } => {
            Some(EffectRequest::Write { path: path.clone(), content: text(content)? })
        }
        EffectRecord::Edit { path, old_text, new_text } => {
            Some(EffectRequest::Edit { path: path.clone(), old_text: text(old_text)?, new_text: text(new_text)? })
        }
        // A command, a tool or a check may have done its work, or half of it.
        EffectRecord::Bash { .. }
        | EffectRecord::Mcp { .. }
        | EffectRecord::Extension { .. }
        | EffectRecord::Check { .. } => None,
    }
}

/// Runs `request` again on the path the gate resolves now, held as
/// `effect/run` holds it; `None` if the path is now refused, or an edit's
/// file doesn't show whether it landed.
async fn perform(
    state: &State,
    scope: &crate::effects::Scope,
    request: EffectRequest,
) -> std::result::Result<Option<Done>, RpcError> {
    // The decision to run it was made and journaled; only the path's
    // policy is checked again, as a symlink may have moved since.
    let (gate, target) = crate::effects::gate(scope, &request, ApprovalMode::FullAuto, &[]);
    let Some(path) = target.path().map(std::path::Path::to_path_buf) else { return Ok(None) };
    if matches!(gate, Gate::Deny(_)) {
        return Ok(None);
    }
    let mut paths = vec![scope.workspace.clone()];
    if !path.starts_with(&scope.workspace) {
        paths.push(path.clone());
    }
    let file = match &request {
        EffectRequest::Edit { .. } | EffectRequest::Write { .. } => Some(state.sessions.workspaces.file(&path).await),
        _ => None,
    };
    let files = state.sessions.workspaces.effect(paths).await;
    let scope = scope.clone();
    tokio::task::spawn_blocking(move || {
        let _held = (files, file);
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        match &request {
            EffectRequest::Edit { path, old_text, new_text } => {
                crate::effects::rerun_edit(&target, path, old_text, new_text)
            }
            _ => Some(crate::effects::perform(&scope, &request, &target, &cancelled)),
        }
    })
    .await
    .map_err(|e| crate::methods::internal(&e))
}
