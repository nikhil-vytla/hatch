//! Automatic learning (ADR-0020): when a work session goes idle (or ends
//! every `everyTurns`th turn), its journal is scanned for signs worth
//! learning from, with no model. Only a session with a sign starts a
//! learner run, and only within the project's limits. Whatever happens past
//! the scan is journaled in the learning session: the request with its
//! trigger, or why it was skipped.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use strive_budget::{InputRate, Reservation};
use strive_proto::rpc::RpcError;
use strive_proto::{Entry, Event, LearnTrigger, TriggerKind};

use crate::methods::session_error;
use crate::server::State;
use crate::sessions::{CallError, SessionId};
use crate::settings::{LearningMode, PROJECT_SETTINGS, ProjectSettings};

const DAY_MS: u64 = 24 * 60 * 60 * 1000;

/// A work session's host recorded `turnEnded`: scans it now if it has
/// ended a multiple of `everyTurns` turns, and again once it has been idle
/// for `idleSeconds`. Each turn's end starts its own wait; a wait that finds
/// a prompt after its turn's end stops there.
pub fn turn_ended(state: &Arc<State>, cwd: String, work: SessionId) {
    let state = state.clone();
    tokio::spawn(async move {
        let Some((ended, turns)) = last_turn_end(&state, &work) else { return };
        let every = state.settings.learning.every_turns;
        if every > 0 && turns % every == 0 {
            consider(&state, &cwd, &work, TriggerKind::Turns).await;
        }
        tokio::time::sleep(Duration::from_secs(state.settings.learning.idle_seconds)).await;
        if prompted_since(&state, &work, ended) {
            crate::log!(
                "session {} not scanned for learning: prompted within idleSeconds of entry {ended}",
                work.as_str()
            );
            return;
        }
        consider(&state, &cwd, &work, TriggerKind::Idle).await;
    });
}

/// A learner's turn or a proposal's checks ended in learning session `sid`.
/// Once nothing is going there, the sessions whose scans were skipped for
/// that meanwhile are scanned again, oldest first: nothing else would scan
/// them until they were prompted again. The daily cap and the other limits
/// apply as to any scan.
pub fn learning_quiet(state: &Arc<State>, sid: SessionId) {
    let state = state.clone();
    tokio::spawn(async move {
        if let Err(e) = rescan(&state, &sid).await {
            crate::log!("could not scan again the sessions learning session {} skipped: {e:?}", sid.as_str());
        }
    });
}

async fn rescan(state: &Arc<State>, sid: &SessionId) -> Result<(), RpcError> {
    let Some(cwd) = state.sessions.peek(sid).map(|i| i.cwd) else { return Ok(()) };
    let learning = crate::learning::journal(state, sid)?;
    if strive_learning::triggers::busy(&learning).is_some() {
        return Ok(());
    }
    for (session, kind) in strive_learning::triggers::waiting(&learning) {
        let Some(work) = SessionId::parse(&session) else { continue };
        crate::log!("session {session} scanned again for learning: its last scan was skipped while learning was busy");
        consider(state, &cwd, &work, kind).await;
    }
    Ok(())
}

/// The seq of the session's last `turnEnded`, and how many turns it has ended.
fn last_turn_end(state: &State, work: &SessionId) -> Option<(u64, u64)> {
    let entries = verified(state, work)?;
    let ends: Vec<u64> = entries.iter().filter(|e| matches!(e.event, Event::TurnEnded { .. })).map(|e| e.seq).collect();
    Some((*ends.last()?, ends.len() as u64))
}

/// Whether a prompt was journaled after entry `ended`. A journal that can't
/// be read says nothing about prompts; the scan logs why it can't read it.
fn prompted_since(state: &State, work: &SessionId, ended: u64) -> bool {
    verified(state, work)
        .is_some_and(|entries| entries.iter().any(|e| e.seq > ended && matches!(e.event, Event::UserMessage { .. })))
}

/// The session's entries, if its journal verifies.
fn verified(state: &State, work: &SessionId) -> Option<Vec<Entry>> {
    match state.sessions.read(work) {
        Ok((_, report)) if report.problem.is_none() => Some(report.entries),
        Ok(_) | Err(_) => None,
    }
}

async fn consider(state: &Arc<State>, cwd: &str, work: &SessionId, kind: TriggerKind) {
    if let Err(e) = scan_and_ask(state, cwd, work, kind).await {
        crate::log!("could not consider an automatic learning run for session {}: {e:?}", work.as_str());
    }
}

/// Scans `work` for signs past those already acted on, and if there are
/// any, asks the learner to study it, or journals why it didn't. What it
/// decided without journaling is logged.
async fn scan_and_ask(state: &Arc<State>, cwd: &str, work: &SessionId, kind: TriggerKind) -> Result<(), RpcError> {
    let id = work.as_str();
    let mode = mode(state, cwd).await;
    if mode == LearningMode::Off {
        crate::log!("session {id} not scanned for learning: \"learning\" is off for {cwd}");
        return Ok(());
    }
    let Some(entries) = verified(state, work) else {
        crate::log!("session {id} not scanned for learning: its journal doesn't verify");
        return Ok(());
    };
    let signs = |learning: &[Entry]| {
        let after = strive_learning::triggers::acted_on(learning, work.as_str());
        strive_learning::signals::scan(work.as_str(), &entries, after)
    };
    // Most sessions have nothing: decided without creating a learning session.
    let known = match crate::learning::find(state, cwd)? {
        Some(sid) => crate::learning::journal(state, &sid)?,
        None => Vec::new(),
    };
    if signs(&known).is_empty() {
        crate::log!("session {id} scanned for learning: no new signs");
        return Ok(());
    }
    let sid = crate::learning::open_id(state, cwd).await?;
    let lock = state.learning.project(&sid);
    let _held = lock.lock().await;
    // A proposal a crash left `checking` would hold the run back until
    // someone listed proposals: its checks are finished (or restarted) first.
    crate::learning::settled(state, &sid, cwd).await?;
    // Again under the lock: another trigger may have acted on these signs.
    let learning = crate::learning::journal(state, &sid)?;
    let signals = signs(&learning);
    if signals.is_empty() {
        crate::log!("session {id} scanned for learning: no new signs");
        return Ok(());
    }
    let trigger = LearnTrigger { kind, signals };
    if let Some(reason) = held_back(state, &sid, &learning).await? {
        crate::log!("automatic learning run for {cwd} skipped: {reason}");
        state.sessions.append(&sid, vec![Event::LearnSkipped { trigger, reason }]).await.map_err(session_error)?;
        return Ok(());
    }
    let asked = Event::LearnRequested { sessions: vec![work.as_str().to_string()], trigger: Some(trigger) };
    state.sessions.append(&sid, vec![asked]).await.map_err(session_error)?;
    state.hosts.ensure(&sid, &state.home.socket(), &state.sessions.session_dir(&sid).join("host.log"));
    Ok(())
}

/// Why an automatic run shouldn't start now, if it shouldn't.
async fn held_back(state: &State, sid: &SessionId, learning: &[Entry]) -> Result<Option<String>, RpcError> {
    if let Some(why) = strive_learning::triggers::busy(learning) {
        // A turn a crash cut off ends only when its host resumes, and only
        // `strive learn` would start that host: without it, this request
        // would hold every automatic run back for good. With a host
        // registered or starting, this does nothing.
        if why == strive_learning::triggers::RUN_GOING {
            state.hosts.ensure(sid, &state.home.socket(), &state.sessions.session_dir(sid).join("host.log"));
        }
        return Ok(Some(why.to_string()));
    }
    let cap = state.settings.learning.daily_runs;
    let since = crate::server::epoch_ms().saturating_sub(DAY_MS);
    let started = strive_learning::triggers::automatic_since(learning, since);
    if started >= cap {
        return Ok(Some(format!(
            "{started} automatic run{} already started in the last 24 hours, the most \"learning\": {{\"dailyRuns\"}} \
             in ~/.strive/settings.json allows",
            if started == 1 { "" } else { "s" }
        )));
    }
    let model_id =
        state.sessions.model(sid).await.map_err(session_error)?.unwrap_or_else(|| state.settings.model.clone());
    let provider = crate::methods::provider_of(&model_id);
    if state.credentials.get(provider).is_none() {
        return Ok(Some(format!("there's no {provider} API key for the learner; `strive auth {provider}` sets one")));
    }
    let Some(model) = state.models.get(&model_id).copied() else {
        return Ok(Some(format!(
            "no price is known for the learner's model {model_id}; add it under \"models\" in ~/.strive/settings.json"
        )));
    };
    // The most one call of the learner can hold: a run that can't make even
    // that call would only fail.
    let worst = Reservation::for_call(
        &model,
        model.context_window,
        Some(model.max_output.min(state.settings.agent_max_output)),
        1,
        InputRate::Plain,
    );
    match state.sessions.check_budget(sid, worst).await {
        Ok(()) => Ok(None),
        Err(CallError::Refused(r)) => Ok(Some(format!(
            "the learning session's budget can't cover the learner's first call: {r}; `strive log {}` shows what it \
             spent",
            sid.as_str()
        ))),
        Err(CallError::Session(e)) => Err(session_error(e)),
    }
}

/// The learning mode for a project: the user's, lowered by the project's own
/// `.strive/settings.json` if it sets a lower one. A project file can't
/// raise it: anyone who can commit to the repository, or a work session's
/// command, can write that file. One that can't be read turns automatic
/// learning off for the project, and the log says why.
pub async fn mode(state: &State, cwd: &str) -> LearningMode {
    let user = state.settings.learning.mode;
    match project_mode(state, cwd).await {
        Ok(Some(project)) => user.min(project),
        Ok(None) => user,
        Err(why) => {
            crate::log!("automatic learning is off for {cwd}: {why}");
            LearningMode::Off
        }
    }
}

async fn project_mode(state: &State, cwd: &str) -> Result<Option<LearningMode>, String> {
    // A project at `~` has strive's home as its `.strive`: that settings
    // file is the user's, already read.
    let home = state.home.root.canonicalize().map_err(|e| e.to_string())?;
    if Path::new(cwd).join(".strive").canonicalize().is_ok_and(|p| p == home) {
        return Ok(None);
    }
    let read = crate::learning::file_now(state, cwd, PROJECT_SETTINGS).await.map_err(|e| format!("{e:?}"))?;
    let Some(bytes) = read.map_err(|why| format!("{PROJECT_SETTINGS}: {why}"))? else { return Ok(None) };
    Ok(ProjectSettings::parse(&bytes)?.learning.map(|l| l.mode))
}
