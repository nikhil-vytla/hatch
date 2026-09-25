//! Trusted learning in the daemon (ADR-0016): a project's learning session,
//! the proposals its host records, the static gate, and a person's accept,
//! reject and rollback.
//!
//! The learner can only propose. Its proposals are checked here, outside
//! its reach, and a file is written only by the daemon, only when a person
//! accepts, and only over the file as it was when the learner proposed.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use serde_json::Value;
use strive_learning::{Finding, Folded, Rule};
use strive_proto::rpc::RpcError;
use strive_proto::{
    Appended, Digest, Entry, Event, Evidence, Gate, LearningOpen, LearningRun, LearningRunParams, Method, ProjectRef,
    Proposal, ProposalDecide, ProposalDecideParams, ProposalDecision, ProposalList, ProposalListResult, ProposalRef,
    ProposalRollback, ProposalStatus, SessionInfo, SessionKind, Verdict,
};

use crate::methods::{Conn, Reply, client_name, internal, parse, reply, require_person, session_error};
use crate::server::State;
use crate::sessions::{SessionError, SessionId};

/// Serializes what reads and then changes a project's proposals.
#[derive(Default)]
pub struct Locks {
    /// Held while finding or creating a learning session, so two opens
    /// can't make two.
    open: tokio::sync::Mutex<()>,
    /// Per learning session: proposing, checking, deciding, rolling back.
    projects: StdMutex<HashMap<SessionId, Arc<tokio::sync::Mutex<()>>>>,
    /// Proposals the judge is working on.
    pub judging: crate::judge::Running,
}

impl Locks {
    fn project(&self, sid: &SessionId) -> Arc<tokio::sync::Mutex<()>> {
        crate::sync::lock(&self.projects).entry(sid.clone()).or_default().clone()
    }
}

const REPLAY_SKIPPED: &str = "not run: replaying past tasks isn't built yet";
const AFTER_FAILURE: &str = "not run: the static check failed";
/// The most of a file as it is now that is read to keep or compare.
const READ_LIMIT: u64 = 1024 * 1024;

pub async fn route(state: &Arc<State>, conn: &Arc<Conn>, method: &str, params: Value) -> Reply {
    match method {
        LearningOpen::NAME => {
            let ProjectRef { cwd } = parse::<LearningOpen>(params)?;
            reply::<LearningOpen>(open(state, &project(&cwd)?).await?)
        }
        LearningRun::NAME => {
            // Asking spends the learning session's budget: a person's call.
            require_person(conn)?;
            let LearningRunParams { cwd, sessions } = parse::<LearningRun>(params)?;
            run(state, &project(&cwd)?, sessions.unwrap_or_default()).await
        }
        ProposalList::NAME => {
            let ProjectRef { cwd } = parse::<ProposalList>(params)?;
            let cwd = project(&cwd)?;
            let (mut proposals, mut entries) = (Vec::new(), Vec::new());
            if let Some(sid) = find(state, &cwd)? {
                let lock = state.learning.project(&sid);
                let _held = lock.lock().await;
                proposals = settled(state, &sid, &cwd).await?.into_iter().map(|f| f.state).collect();
                proposals.reverse();
                entries = journal(state, &sid)?;
            }
            let changed_outside_review = outside_review(state, &cwd, &entries).await?;
            reply::<ProposalList>(ProposalListResult { proposals, changed_outside_review })
        }
        ProposalDecide::NAME => {
            require_person(conn)?;
            let ProposalDecideParams { cwd, proposal, decision } = parse::<ProposalDecide>(params)?;
            decide(state, &project(&cwd)?, proposal, decision, client_name(conn)).await
        }
        ProposalRollback::NAME => {
            require_person(conn)?;
            let ProposalRef { cwd, proposal } = parse::<ProposalRollback>(params)?;
            rollback(state, &project(&cwd)?, proposal, client_name(conn)).await
        }
        other => Err(RpcError::new(RpcError::METHOD_NOT_FOUND, format!("unknown method {other}"))),
    }
}

fn refused(why: impl Into<String>) -> RpcError {
    RpcError::new(RpcError::INVALID_REQUEST, why)
}

/// The project's directory, as its sessions record it: its real path.
fn project(cwd: &str) -> Result<String, RpcError> {
    let real = Path::new(cwd)
        .canonicalize()
        .map_err(|e| RpcError::new(RpcError::INVALID_PARAMS, format!("can't open the project {cwd}: {e}")))?;
    if !real.is_dir() {
        return Err(RpcError::new(RpcError::INVALID_PARAMS, format!("the project {cwd} isn't a directory")));
    }
    Ok(real.display().to_string())
}

/// The project's learning session, if it has one. The oldest wins, so the
/// answer never changes once there is one.
fn find(state: &State, cwd: &str) -> Result<Option<SessionId>, RpcError> {
    let (found, _) = state.sessions.list(Some(cwd), SessionKind::Learning).map_err(|e| internal(&e))?;
    Ok(found.last().and_then(|s| SessionId::parse(&s.id)))
}

/// Finds or creates the project's learning session.
async fn open(state: &State, cwd: &str) -> Result<SessionInfo, RpcError> {
    let _held = state.learning.open.lock().await;
    let (found, _) = state.sessions.list(Some(cwd), SessionKind::Learning).map_err(|e| internal(&e))?;
    if let Some(info) = found.into_iter().last() {
        return Ok(info);
    }
    state
        .sessions
        .create(cwd.to_string(), state.settings.budget.limits(), state.settings.approvals, Some(SessionKind::Learning))
        .await
        .map_err(session_error)
}

fn learning_id(info: &SessionInfo) -> Result<SessionId, RpcError> {
    SessionId::parse(&info.id).ok_or_else(|| internal(&format!("the learning session's id {:?} isn't valid", info.id)))
}

/// A work session of the project, or why `id` isn't one.
fn work_session(state: &State, cwd: &str, id: &str) -> Result<SessionId, String> {
    let sid = SessionId::parse(id).ok_or_else(|| format!("{id:?} isn't a session id"))?;
    let info = state.sessions.peek(&sid).ok_or_else(|| format!("there's no session {id}"))?;
    match info.kind.unwrap_or_default() {
        SessionKind::Learning => Err(format!("{id} is the learning session of {}, not a work session", info.cwd)),
        SessionKind::Work if info.cwd != cwd => Err(format!("session {id} worked in {}, not in {cwd}", info.cwd)),
        SessionKind::Work => Ok(sid),
    }
}

async fn run(state: &Arc<State>, cwd: &str, sessions: Vec<String>) -> Reply {
    for s in &sessions {
        work_session(state, cwd, s).map_err(|why| RpcError::new(RpcError::INVALID_PARAMS, why))?;
    }
    let sid = learning_id(&open(state, cwd).await?)?;
    let entries = state.sessions.append(&sid, vec![Event::LearnRequested { sessions }]).await.map_err(session_error)?;
    state.hosts.ensure(&sid, &state.home.socket(), &state.sessions.session_dir(&sid).join("host.log"));
    reply::<LearningRun>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}

/// Journals a proposal the learning session's host made, with the file's
/// digest as it is now and the outcome of each gate that can be decided at
/// once. A judge call, if one is needed, starts once it's journaled.
pub async fn propose(
    state: &Arc<State>,
    sid: &SessionId,
    cwd: &str,
    call_id: Option<String>,
    proposal: Proposal,
    before: Option<Digest>,
) -> Result<Vec<Entry>, RpcError> {
    if before.is_some() {
        return Err(RpcError::new(
            RpcError::INVALID_PARAMS,
            "the daemon records the file as the learner was shown it (before) itself; leave it out",
        ));
    }
    let lock = state.learning.project(sid);
    let _held = lock.lock().await;
    let findings = static_gate(state, cwd, &proposal).await?;
    let entries = journal(state, sid)?;
    let before = match strive_learning::relative_path(&proposal.artifact) {
        Ok(rel) => shown(&entries, &rel),
        Err(_) => None,
    };
    let (verdict, detail) = strive_learning::verdict(&findings);
    let judge = judge_plan(state, cwd, verdict, &proposal, before, crate::server::epoch_ms(), &entries);
    let mut gates = vec![(Gate::Static, verdict, detail)];
    let call = match judge {
        crate::judge::Plan::Now(v, why) => {
            gates.push((Gate::Judge, v, why));
            None
        }
        crate::judge::Plan::Call(call) => Some(call),
    };
    gates.push((Gate::Replay, Verdict::Skipped, replay_skipped(verdict)));
    let made = Event::ProposalMade { call_id, proposal, before };
    let written = state.sessions.propose(sid, made, gates).await.map_err(session_error)?;
    if let (Some(call), Some(made)) = (call, written.first()) {
        crate::judge::start(state, sid, made.seq, call);
    }
    Ok(written)
}

/// The judge's plan, given the static gate's verdict: nothing to judge
/// after a static failure.
fn judge_plan(
    state: &State,
    cwd: &str,
    static_verdict: Verdict,
    proposal: &Proposal,
    before: Option<Digest>,
    made_at_ms: u64,
    learning: &[Entry],
) -> crate::judge::Plan {
    match static_verdict {
        Verdict::Fail => crate::judge::Plan::Now(Verdict::Skipped, AFTER_FAILURE.into()),
        Verdict::Pass | Verdict::Skipped => crate::judge::plan(state, cwd, proposal, before, made_at_ms, learning),
    }
}

fn replay_skipped(static_verdict: Verdict) -> String {
    match static_verdict {
        Verdict::Fail => AFTER_FAILURE.into(),
        Verdict::Pass | Verdict::Skipped => REPLAY_SKIPPED.into(),
    }
}

/// Journals the judge's verdict on proposal `id`, unless it has one.
pub async fn judged(state: &State, sid: &SessionId, id: u64, verdict: Verdict, detail: String) -> Result<(), RpcError> {
    let lock = state.learning.project(sid);
    let _held = lock.lock().await;
    if crate::judge::has_verdict(&journal(state, sid)?, id) {
        return Ok(());
    }
    let event = Event::GateFinished { proposal: id, gate: Gate::Judge, verdict, detail };
    state.sessions.append(sid, vec![event]).await.map_err(session_error)?;
    Ok(())
}

/// The file at `rel` as the learner was last shown it; none if it wasn't
/// there. Accepting writes only over this, so a change the learner never
/// saw is never overwritten.
fn shown(entries: &[Entry], rel: &str) -> Option<Digest> {
    let learned = entries.iter().rev().find_map(|e| match &e.event {
        Event::ContextLoaded { learned, .. } => Some(learned.as_deref().unwrap_or_default()),
        _ => None,
    })?;
    learned.iter().find(|f| f.path == rel).map(|f| f.digest)
}

/// The project's learned files that aren't what an accepted proposal last
/// left there: its content once applied, what it replaced once rolled back.
/// A file no applied proposal wrote counts once it exists. Nothing stops an
/// editor or git from changing these files; this is how review sees it.
async fn outside_review(state: &State, cwd: &str, entries: &[Entry]) -> Result<Vec<String>, RpcError> {
    let mut paths: HashMap<u64, String> = HashMap::new();
    let mut replaced: HashMap<u64, Option<Digest>> = HashMap::new();
    let mut left: BTreeMap<String, Option<Digest>> = BTreeMap::new();
    for e in entries {
        match &e.event {
            Event::ProposalMade { proposal, .. } => {
                if let Ok(rel) = strive_learning::relative_path(&proposal.artifact) {
                    paths.insert(e.seq, rel);
                }
            }
            Event::ProposalApplied { proposal, before, after } => {
                if let Some(rel) = paths.get(proposal) {
                    left.insert(rel.clone(), Some(*after));
                    replaced.insert(*proposal, *before);
                }
            }
            Event::ProposalRolledBack { proposal, .. } => {
                if let (Some(rel), Some(before)) = (paths.get(proposal), replaced.get(proposal)) {
                    left.insert(rel.clone(), *before);
                }
            }
            _ => {}
        }
    }
    let mut files: BTreeSet<String> = left.keys().cloned().collect();
    files.insert(strive_learning::MEMORY_PATH.into());
    if let Ok(dir) = std::fs::read_dir(Path::new(cwd).join(strive_learning::SKILLS_DIR)) {
        let names = dir.filter_map(Result::ok).filter_map(|e| e.file_name().to_str().map(str::to_string));
        files.extend(
            names
                .filter(|n| strive_learning::valid_skill_name(n))
                .map(|n| format!("{}/{n}/SKILL.md", strive_learning::SKILLS_DIR)),
        );
    }
    let mut changed = Vec::new();
    for rel in files {
        // Something there that isn't a plain file (a symlink, say) is a change too.
        let now = file_now(state, cwd, &rel).await?.map(|b| b.map(|b| strive_journal::cas::digest(&b)));
        let differs = match (left.get(&rel), now) {
            (_, Err(_)) => true,
            (Some(expected), Ok(now)) => *expected != now,
            (None, Ok(now)) => now.is_some(),
        };
        if differs {
            changed.push(rel);
        }
    }
    Ok(changed)
}

/// The static gate: the proposal's own text, where its file resolves (and
/// that what's there now is a file it could replace), and its evidence.
async fn static_gate(state: &State, cwd: &str, p: &Proposal) -> Result<Vec<Finding>, RpcError> {
    let known: Vec<String> =
        crate::credentials::PROVIDERS.iter().filter_map(|(provider, _)| state.credentials.get(provider)).collect();
    let mut findings = strive_learning::check(p, &known);
    if let Ok(rel) = strive_learning::relative_path(&p.artifact)
        && let Err(why) = file_now(state, cwd, &rel).await?
    {
        findings.push(Finding::new(Rule::Path, why));
    }
    findings.extend(evidence(state, cwd, &p.evidence));
    Ok(findings)
}

/// The artifact's file as it is now, if it's where it may be: its bytes,
/// none if it doesn't exist, or why it can't be used.
async fn file_now(state: &State, cwd: &str, rel: &str) -> Result<Result<Option<Vec<u8>>, String>, RpcError> {
    let home = state.home.root.canonicalize().map_err(|e| internal(&e))?;
    let (cwd, rel) = (cwd.to_string(), rel.to_string());
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&cwd).join(&rel);
        located(&home, &cwd, &path, &rel)?;
        read_now(&path, &rel)
    })
    .await
    .map_err(|e| internal(&e))
}

/// Whether the file's path stays inside the project's `.strive/` with
/// every symlink followed, and out of strive's own home (a project at `~`
/// has `~/.strive` as its `.strive`).
fn located(home: &Path, cwd: &str, path: &Path, rel: &str) -> Result<(), String> {
    // A link anywhere under the project, dangling or not, could lead a
    // write out of it.
    if let Some(link) = path
        .ancestors()
        .take_while(|p| *p != Path::new(cwd))
        .find(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err(format!("{rel} leads through a symlink at {}; it must stay in {cwd}/.strive", link.display()));
    }
    let resolved = crate::effects::real_path(path).ok_or_else(|| format!("{rel} can't be resolved"))?;
    if resolved.starts_with(home) || path.starts_with(home) {
        return Err(format!("{cwd}/.strive is strive's own home, so learned files can't go there"));
    }
    if resolved != path {
        return Err(format!("{rel} leads to {} through a symlink; it must stay in {cwd}/.strive", resolved.display()));
    }
    Ok(())
}

/// A file's bytes, read without following symlinks; none if it's absent.
fn read_now(path: &Path, rel: &str) -> Result<Option<Vec<u8>>, String> {
    use crate::pinned::Error as E;
    let opened = crate::pinned::parent(path, false).and_then(|(dir, name)| dir.open_regular(&name));
    let file = match opened {
        Ok((file, _)) => file,
        Err(E::NotFound) => return Ok(None),
        Err(E::NotRegular) => return Err(format!("{rel} isn't a regular file")),
        Err(E::Changed) => return Err(format!("{rel}, or a directory on the way to it, is a symlink")),
        Err(E::Io(e)) => return Err(format!("can't read {rel}: {e}")),
    };
    let mut bytes = Vec::new();
    file.take(READ_LIMIT + 1).read_to_end(&mut bytes).map_err(|e| format!("can't read {rel}: {e}"))?;
    if bytes.len() as u64 > READ_LIMIT {
        return Err(format!("{rel} is over {} KiB; trim it by hand first", READ_LIMIT / 1024));
    }
    Ok(Some(bytes))
}

/// Replaces (or with `None`, removes) a file without following symlinks.
fn write_now(path: &Path, rel: &str, bytes: Option<&[u8]>) -> Result<(), String> {
    use crate::pinned::Error as E;
    let done = match bytes {
        Some(b) => crate::pinned::parent(path, true).and_then(|(dir, name)| dir.replace(&name, b)),
        None => crate::pinned::parent(path, false).and_then(|(dir, name)| dir.remove(&name)),
    };
    done.map_err(|e| match e {
        E::NotFound => format!("{rel} is gone"),
        E::NotRegular => format!("{rel} isn't a regular file"),
        E::Changed => format!("a directory on the way to {rel} was replaced by a symlink"),
        E::Io(e) => format!("can't write {rel}: {e}"),
    })
}

/// Evidence must name work sessions of this project whose journals
/// verify, and entries they have.
fn evidence(state: &State, cwd: &str, evidence: &[Evidence]) -> Vec<Finding> {
    let mut found = Vec::new();
    // Each session's last seq, or none once it has been reported.
    let mut seen: HashMap<&str, Option<u64>> = HashMap::new();
    for e in evidence {
        let last = *seen.entry(e.session.as_str()).or_insert_with(|| match last_seq(state, cwd, &e.session) {
            Ok(last) => Some(last),
            Err(why) => {
                found.push(Finding::new(Rule::Evidence, why));
                None
            }
        });
        let Some(last) = last else { continue };
        if let Some(bad) = e.seqs.iter().find(|&&s| s == 0 || s > last) {
            found.push(Finding::new(Rule::Evidence, format!("session {} has no entry {bad}", e.session)));
        }
    }
    found
}

/// The last seq of a work session of the project, verified.
fn last_seq(state: &State, cwd: &str, id: &str) -> Result<u64, String> {
    let sid = work_session(state, cwd, id)?;
    match state.sessions.read(&sid) {
        Ok((_, report)) => match report.problem {
            Some(p) => Err(format!("session {id}'s journal failed verification: {p}")),
            None => Ok(report.entries.last().map_or(0, |e| e.seq)),
        },
        Err(SessionError::NotFound) => Err(format!("there's no session {id}")),
        Err(SessionError::Invalid(p)) => Err(format!("session {id}'s journal failed verification: {p}")),
        Err(SessionError::Io(e)) => Err(format!("session {id} can't be read: {e}")),
    }
}

/// The learning session's committed entries, verified.
fn journal(state: &State, sid: &SessionId) -> Result<Vec<Entry>, RpcError> {
    let (_, report) = state.sessions.read(sid).map_err(session_error)?;
    match report.problem {
        Some(p) => Err(session_error(SessionError::Invalid(p))),
        None => Ok(report.entries),
    }
}

/// The project's proposals, oldest first, after finishing any checks a
/// crash cut short: gates without a verdict are run again, and a judge
/// call that isn't running is started. Call with the project's lock held.
async fn settled(state: &Arc<State>, sid: &SessionId, cwd: &str) -> Result<Vec<Folded>, RpcError> {
    let entries = journal(state, sid)?;
    let folded = strive_learning::fold(&entries);
    let mut events = Vec::new();
    let mut calls = Vec::new();
    for f in folded.iter().filter(|f| f.state.status == ProposalStatus::Checking) {
        let id = f.state.id;
        let had = |gate: Gate| f.state.gates.iter().find(|g| g.gate == gate).map(|g| g.verdict);
        let static_verdict = if let Some(v) = had(Gate::Static) {
            v
        } else {
            let (v, detail) = strive_learning::verdict(&static_gate(state, cwd, &f.state.proposal).await?);
            events.push(Event::GateFinished { proposal: id, gate: Gate::Static, verdict: v, detail });
            v
        };
        if had(Gate::Judge).is_none() && !state.learning.judging.has(sid, id) {
            let p = &f.state;
            match judge_plan(state, cwd, static_verdict, &p.proposal, p.before, p.made_at_ms, &entries) {
                crate::judge::Plan::Now(verdict, detail) => {
                    events.push(Event::GateFinished { proposal: id, gate: Gate::Judge, verdict, detail });
                }
                crate::judge::Plan::Call(call) => calls.push((id, call)),
            }
        }
        if had(Gate::Replay).is_none() {
            let detail = replay_skipped(static_verdict);
            events.push(Event::GateFinished { proposal: id, gate: Gate::Replay, verdict: Verdict::Skipped, detail });
        }
    }
    for (id, call) in calls {
        crate::judge::start(state, sid, id, call);
    }
    if events.is_empty() {
        return Ok(folded);
    }
    state.sessions.append(sid, events).await.map_err(session_error)?;
    Ok(strive_learning::fold(&journal(state, sid)?))
}

/// The proposal, with the project's lock held while the caller acts on it.
async fn proposal(
    state: &Arc<State>,
    cwd: &str,
    id: u64,
) -> Result<(SessionId, Folded, tokio::sync::OwnedMutexGuard<()>), RpcError> {
    let missing = || RpcError::new(RpcError::INVALID_PARAMS, format!("there's no proposal #{id} for {cwd}"));
    let sid = find(state, cwd)?.ok_or_else(missing)?;
    let held = state.learning.project(&sid).lock_owned().await;
    let f = settled(state, &sid, cwd).await?.into_iter().find(|f| f.state.id == id).ok_or_else(missing)?;
    Ok((sid, f, held))
}

async fn decide(state: &Arc<State>, cwd: &str, id: u64, decision: ProposalDecision, by: String) -> Reply {
    let (sid, f, _held) = proposal(state, cwd, id).await?;
    let status = f.state.status;
    let name = strive_learning::status_name(status);
    match decision {
        ProposalDecision::Reject => match status {
            ProposalStatus::Checking | ProposalStatus::Ready | ProposalStatus::Failed => {
                let decided = Event::ProposalDecided { proposal: id, decision, by };
                let entries = state.sessions.append(&sid, vec![decided]).await.map_err(session_error)?;
                reply::<ProposalDecide>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
            }
            ProposalStatus::Rejected | ProposalStatus::Applied | ProposalStatus::Stale | ProposalStatus::RolledBack => {
                Err(refused(format!("proposal #{id} is already {name}; only an undecided one can be rejected")))
            }
        },
        ProposalDecision::Accept => match status {
            ProposalStatus::Ready => apply(state, &sid, cwd, &f, by).await,
            ProposalStatus::Failed => Err(refused(format!(
                "proposal #{id} failed its checks, so it can't be accepted; `strive review {id}` shows why"
            ))),
            ProposalStatus::Checking
            | ProposalStatus::Rejected
            | ProposalStatus::Applied
            | ProposalStatus::Stale
            | ProposalStatus::RolledBack => {
                Err(refused(format!("proposal #{id} is {name}; only a ready proposal can be accepted")))
            }
        },
    }
}

/// Writes an accepted proposal if the file is still as it was when it was
/// proposed; otherwise records the accept alone, which makes it stale.
async fn apply(state: &State, sid: &SessionId, cwd: &str, f: &Folded, by: String) -> Reply {
    let id = f.state.id;
    let p = &f.state.proposal;
    let rel = strive_learning::relative_path(&p.artifact).map_err(refused)?;
    let Some(_running) = state.sessions.begin_effect() else {
        return Err(internal(&"the daemon is stopping"));
    };
    // As an agent's write would: no edit of this file, and no rewind of
    // the project, runs while it's compared and written.
    let path = Path::new(cwd).join(&rel);
    let _file = state.sessions.workspaces.file(&path).await;
    let _project = state.sessions.workspaces.effect(vec![PathBuf::from(cwd)]).await;
    let now = file_now(state, cwd, &rel).await?.map_err(refused)?;
    let now = now.map(|b| state.cas.put(&b)).transpose().map_err(|e| internal(&e))?;
    let accepted = Event::ProposalDecided { proposal: id, decision: ProposalDecision::Accept, by };
    let mut events = vec![accepted];
    if now == f.state.before {
        let after = state.cas.put(p.content.as_bytes()).map_err(|e| internal(&e))?;
        let (content, path_, rel_) = (p.content.clone().into_bytes(), path.clone(), rel.clone());
        tokio::task::spawn_blocking(move || write_now(&path_, &rel_, Some(&content)))
            .await
            .map_err(|e| internal(&e))?
            .map_err(|why| refused(format!("{why}; nothing was written")))?;
        events.push(Event::ProposalApplied { proposal: id, before: f.state.before, after });
    }
    let entries = state.sessions.append(sid, events).await.map_err(session_error)?;
    reply::<ProposalDecide>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}

/// Puts an applied proposal's file back as it was, if it's still as applied.
async fn rollback(state: &Arc<State>, cwd: &str, id: u64, by: String) -> Reply {
    let (sid, f, _held) = proposal(state, cwd, id).await?;
    let applied = match (f.state.status, f.applied) {
        (ProposalStatus::Applied, Some(applied)) => applied,
        (status, _) => {
            return Err(refused(format!(
                "proposal #{id} is {}; only an applied proposal can be rolled back",
                strive_learning::status_name(status)
            )));
        }
    };
    let rel = strive_learning::relative_path(&f.state.proposal.artifact).map_err(refused)?;
    let Some(_running) = state.sessions.begin_effect() else {
        return Err(internal(&"the daemon is stopping"));
    };
    let path = Path::new(cwd).join(&rel);
    let _file = state.sessions.workspaces.file(&path).await;
    let _project = state.sessions.workspaces.effect(vec![PathBuf::from(cwd)]).await;
    let now = file_now(state, cwd, &rel).await?.map_err(refused)?;
    let now = now.map(|b| state.cas.put(&b)).transpose().map_err(|e| internal(&e))?;
    if now != Some(applied.after) {
        return Err(refused(format!(
            "{rel} has changed since proposal #{id} was applied, so nothing was rolled back; edit it by hand instead"
        )));
    }
    let old = applied.before.map(|d| state.cas.get(&d)).transpose().map_err(|e| internal(&e))?;
    tokio::task::spawn_blocking(move || write_now(&path, &rel, old.as_deref()))
        .await
        .map_err(|e| internal(&e))?
        .map_err(|why| refused(format!("{why}; nothing was rolled back")))?;
    let entries = state
        .sessions
        .append(&sid, vec![Event::ProposalRolledBack { proposal: id, by }])
        .await
        .map_err(session_error)?;
    reply::<ProposalRollback>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}
