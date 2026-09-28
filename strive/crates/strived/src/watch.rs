//! Predictions checked (ADR-0019): each applied proposal's watch, evaluated
//! on the project's later work sessions and journaled in its learning
//! session. The daemon only records and tallies; a rollback stays a
//! person's request.

use std::collections::HashMap;
use std::sync::Arc;

use strive_proto::rpc::RpcError;
use strive_proto::{Event, ProposalStatus, SessionInfo, SessionKind, Watch, WatchOutcome};

use crate::methods::{internal, session_error};
use crate::server::State;
use crate::sessions::SessionId;

/// Checks work session `work` of project `cwd` in the background, once one
/// of its turns has ended.
pub fn turn_ended(state: &Arc<State>, cwd: String, work: SessionId) {
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = check(&state, &cwd, Some(work.clone())).await {
            crate::log!("could not check predictions against session {work:?}: {e:?}");
        }
    });
}

/// An applied proposal whose watch is checked, and when it was applied.
struct Watched {
    id: u64,
    watch: Watch,
    applied_at_ms: u64,
}

/// Checks the project's applied watches against its work sessions (only
/// `only`, if given), and journals each outcome that is new for its
/// (proposal, session) pair. Returns how many were journaled.
pub async fn check(state: &Arc<State>, cwd: &str, only: Option<SessionId>) -> Result<usize, RpcError> {
    let Some(sid) = crate::learning::find(state, cwd)? else { return Ok(0) };
    let lock = state.learning.project(&sid);
    let _held = lock.lock().await;
    let entries = crate::learning::journal(state, &sid)?;
    let watched: Vec<Watched> = strive_learning::fold(&entries)
        .into_iter()
        .filter(|f| f.state.status == ProposalStatus::Applied)
        .filter_map(|f| {
            let applied = f.applied?;
            let watch = *f.state.proposal.watch?;
            Some(Watched { id: f.state.id, watch, applied_at_ms: applied.at_ms })
        })
        .collect();
    if watched.is_empty() {
        return Ok(0);
    }
    let mut latest: HashMap<(u64, String), WatchOutcome> = HashMap::new();
    for e in &entries {
        if let Event::PredictionChecked { proposal, session, outcome, .. } = &e.event {
            latest.insert((*proposal, session.clone()), *outcome);
        }
    }
    let (state2, cwd2) = (state.clone(), cwd.to_string());
    let events = tokio::task::spawn_blocking(move || evaluate(&state2, &cwd2, only.as_ref(), &watched, &latest))
        .await
        .map_err(|e| internal(&e))??;
    let n = events.len();
    if n > 0 {
        state.sessions.append(&sid, events).await.map_err(session_error)?;
    }
    Ok(n)
}

/// The outcomes to journal: each watch read on each work session begun
/// since its proposal was applied, where it differs from the latest record.
fn evaluate(
    state: &State,
    cwd: &str,
    only: Option<&SessionId>,
    watched: &[Watched],
    latest: &HashMap<(u64, String), WatchOutcome>,
) -> Result<Vec<Event>, RpcError> {
    let sessions: Vec<SessionInfo> = match only {
        Some(work) => state.sessions.peek(work).into_iter().collect(),
        None => state.sessions.list(Some(cwd), SessionKind::Work).map_err(|e| internal(&e))?.0,
    };
    let earliest = watched.iter().map(|w| w.applied_at_ms).min().unwrap_or(u64::MAX);
    let mut events = Vec::new();
    for info in sessions {
        // A session begun before a proposal was applied started with the old file.
        if info.kind.unwrap_or_default() != SessionKind::Work || info.cwd != cwd || info.created_at_ms < earliest {
            continue;
        }
        let Some(work) = SessionId::parse(&info.id) else { continue };
        // A journal that doesn't verify can't be read as evidence either way.
        let report = match state.sessions.read(&work) {
            Ok((_, report)) if report.problem.is_none() => report,
            Ok(_) | Err(_) => continue,
        };
        let mut output = |d: &strive_proto::Digest| state.cas.get(d).ok();
        for w in watched.iter().filter(|w| info.created_at_ms >= w.applied_at_ms) {
            let Some(checked) = strive_learning::watch::check(&w.watch, &report.entries, &mut output) else {
                continue;
            };
            if latest.get(&(w.id, info.id.clone())) == Some(&checked.outcome) {
                continue;
            }
            events.push(Event::PredictionChecked {
                proposal: w.id,
                session: info.id.clone(),
                through_seq: checked.through_seq,
                outcome: checked.outcome,
                detail: checked.detail,
            });
        }
    }
    Ok(events)
}
