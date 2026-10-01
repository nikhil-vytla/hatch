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
    Appended, Artifact, Change, Digest, Entry, Event, Evidence, Gate, LearnSignal, LearningDismiss,
    LearningDismissParams, LearningOpen, LearningRun, LearningRunParams, LearningSignals, LearningSignalsParams,
    LearningSignalsResult, MemoryItem, Method, ProjectRef, Proposal, ProposalDecide, ProposalDecideParams,
    ProposalDecision, ProposalList, ProposalListResult, ProposalRef, ProposalRollback, ProposalStatus, SessionInfo,
    SessionKind, StaleMention, Verdict,
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
    pub fn project(&self, sid: &SessionId) -> Arc<tokio::sync::Mutex<()>> {
        crate::sync::lock(&self.projects).entry(sid.clone()).or_default().clone()
    }
}

const AFTER_FAILURE: &str = "not run: the safety checks failed";
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
            let LearningRunParams { cwd, sessions, offer } = parse::<LearningRun>(params)?;
            run(state, &project(&cwd)?, sessions.unwrap_or_default(), offer.filter(|o| *o)).await
        }
        LearningSignals::NAME => {
            let LearningSignalsParams { cwd, session } = parse::<LearningSignals>(params)?;
            reply::<LearningSignals>(signals(state, &project(&cwd)?, &session).await?)
        }
        LearningDismiss::NAME => {
            require_person(conn)?;
            let LearningDismissParams { cwd, session, through } = parse::<LearningDismiss>(params)?;
            dismiss(state, &project(&cwd)?, &session, through).await
        }
        ProposalList::NAME => {
            let ProjectRef { cwd } = parse::<ProposalList>(params)?;
            let cwd = project(&cwd)?;
            let (mut folded, mut entries) = (Vec::new(), Vec::new());
            if let Some(sid) = find(state, &cwd)? {
                let lock = state.learning.project(&sid);
                let _held = lock.lock().await;
                folded = settled(state, &sid, &cwd).await?;
                rollable(state, &cwd, &mut folded).await?;
                previewed(state, &mut folded)?;
                entries = journal(state, &sid)?;
            }
            let memory = memory_now(state, &cwd, &folded).await?;
            let changed_outside_review = outside_review(state, &cwd, &entries, &memory).await?;
            let may_be_stale = stale(state, &cwd).await?;
            let skipped = strive_learning::triggers::skipped(&entries);
            let proposals = folded.into_iter().rev().map(|f| f.state).collect();
            reply::<ProposalList>(ProposalListResult {
                proposals,
                changed_outside_review,
                may_be_stale,
                skipped,
                memory: memory.unwrap_or_default(),
            })
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
pub fn find(state: &State, cwd: &str) -> Result<Option<SessionId>, RpcError> {
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

/// The project's learning session, created if it has none.
pub async fn open_id(state: &State, cwd: &str) -> Result<SessionId, RpcError> {
    learning_id(&open(state, cwd).await?)
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

fn invalid(why: String) -> RpcError {
    RpcError::new(RpcError::INVALID_PARAMS, why)
}

async fn run(state: &Arc<State>, cwd: &str, sessions: Vec<String>, offer: Option<bool>) -> Reply {
    let works = sessions.iter().map(|s| work_session(state, cwd, s).map_err(invalid)).collect::<Result<Vec<_>, _>>()?;
    let sid = learning_id(&open(state, cwd).await?)?;
    // The named sessions' signs go with the request: the learner reads them
    // first, and neither a trigger nor an offer brings them up again.
    let learning = journal(state, &sid)?;
    let mut found = Vec::new();
    for work in &works {
        if let Ok(entries) = work_entries(state, work) {
            found.extend(undealt(work, &entries, &learning));
        }
    }
    let signals = (!found.is_empty()).then_some(found);
    let entries = state
        .sessions
        .append(&sid, vec![Event::LearnRequested { sessions, trigger: None, signals, offer }])
        .await
        .map_err(session_error)?;
    state.hosts.ensure(&sid, &state.home.socket(), &state.sessions.session_dir(&sid).join("host.log"));
    reply::<LearningRun>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}

/// A work session's verified entries.
fn work_entries(state: &State, work: &SessionId) -> Result<Vec<Entry>, RpcError> {
    let (_, report) = state.sessions.read(work).map_err(session_error)?;
    match report.problem {
        Some(p) => Err(session_error(SessionError::Invalid(p))),
        None => Ok(report.entries),
    }
}

/// `work`'s signs past those the learning journal says were dealt with.
fn undealt(work: &SessionId, entries: &[Entry], learning: &[Entry]) -> Vec<LearnSignal> {
    let after = strive_learning::triggers::acted_on(learning, work.as_str());
    strive_learning::signals::scan(work.as_str(), entries, after)
}

/// A work session's signs that nothing has dealt with, and whether to offer
/// a person a run for them. No model is called and nothing is journaled; a
/// project with no learning session doesn't get one.
async fn signals(state: &State, cwd: &str, session: &str) -> Result<LearningSignalsResult, RpcError> {
    let work = work_session(state, cwd, session).map_err(invalid)?;
    let entries = work_entries(state, &work)?;
    let (learning, model) = match find(state, cwd)? {
        Some(sid) => (journal(state, &sid)?, state.sessions.model(&sid).await.map_err(session_error)?),
        None => (Vec::new(), None),
    };
    // A run with no key would only fail, so there's nothing to offer.
    let model = model.unwrap_or_else(|| state.settings.model.clone());
    let keyed = state.credentials.get(crate::methods::provider_of(&model)).is_some();
    let signals = undealt(&work, &entries, &learning);
    Ok(LearningSignalsResult {
        summary: strive_learning::signals::summary(&signals),
        ask: state.settings.learning.ask && keyed && !signals.is_empty(),
        estimate_usd_micros: strive_learning::triggers::cost_per_run(&learning)
            .or_else(|| first_estimate(state, &model)),
        signals,
    })
}

/// What a run should cost in a project with no run of its own yet: the
/// learner model's price for a typical run. Only this project's journal is
/// read for estimates; another project's usage isn't this window's to see.
/// None if the model's price isn't known.
fn first_estimate(state: &State, model: &str) -> Option<u64> {
    let price = state.models.get(model)?.price;
    Some(strive_budget::cost(&price, &strive_learning::triggers::TYPICAL_RUN))
}

/// A person declined to learn from `session`'s signs up to `through`.
async fn dismiss(state: &State, cwd: &str, session: &str, through: u64) -> Reply {
    let last = last_seq(state, cwd, session).map_err(invalid)?;
    if through > last {
        return Err(invalid(format!("session {session} has no entry {through}")));
    }
    let sid = open_id(state, cwd).await?;
    let entries = state
        .sessions
        .append(&sid, vec![Event::LearnDismissed { session: session.to_string(), through }])
        .await
        .map_err(session_error)?;
    reply::<LearningDismiss>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
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
    let entries = journal(state, sid)?;
    let before = match strive_learning::relative_path(&proposal.change.artifact()) {
        Ok(rel) => shown(&entries, &rel),
        Err(_) => None,
    };
    let findings = static_gate(state, cwd, &proposal, before).await?;
    let (verdict, detail) = strive_learning::verdict(&findings);
    let made = crate::judge::Made { proposal: &proposal, before, at_ms: crate::server::epoch_ms() };
    let mut gates = vec![(Gate::Static, verdict, detail)];
    let mut call = None;
    match judge_plan(state, cwd, verdict, &made, &entries) {
        crate::judge::Plan::Now(v, why) => gates.push((Gate::Judge, v, why)),
        crate::judge::Plan::Call(c) => call = Some(c),
    }
    let made = Event::ProposalMade { call_id, proposal, before };
    let written = state.sessions.propose(sid, made, gates).await.map_err(session_error)?;
    if let (Some(made), Some(call)) = (written.first(), call) {
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
    made: &crate::judge::Made,
    learning: &[Entry],
) -> crate::judge::Plan {
    match static_verdict {
        Verdict::Fail => crate::judge::Plan::Now(Verdict::Skipped, AFTER_FAILURE.into()),
        Verdict::Pass | Verdict::Skipped => crate::judge::plan(state, cwd, made, learning),
    }
}

/// Journals the judge's verdict on proposal `id`, unless it has one.
pub async fn judged(
    state: &Arc<State>,
    sid: &SessionId,
    id: u64,
    verdict: Verdict,
    detail: String,
) -> Result<(), RpcError> {
    let lock = state.learning.project(sid);
    let _held = lock.lock().await;
    let entries = journal(state, sid)?;
    if crate::judge::has_verdict(&entries, id) {
        return Ok(());
    }
    let verdict = Event::GateFinished { proposal: id, gate: Gate::Judge, verdict, detail };
    state.sessions.append(sid, vec![verdict]).await.map_err(session_error)?;
    crate::triggers::learning_quiet(state, sid.clone());
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

/// The project's learned files that aren't what review left there:
/// - memory, when a bullet names a source that isn't an applied proposal
///   which left it reading so (`strive_learning::memory::view`), or when the
///   file can't be read as a learned file. Hand-written bullets are a
///   person's, and count as reviewed;
/// - a skill, when it isn't what an accepted proposal last left there: its
///   content once applied, what it replaced once rolled back. A skill no
///   applied proposal wrote counts once it exists.
///
/// Nothing stops an editor or git from changing these files; this is how
/// review sees it.
async fn outside_review(
    state: &State,
    cwd: &str,
    entries: &[Entry],
    memory: &Result<Vec<MemoryItem>, String>,
) -> Result<Vec<String>, RpcError> {
    let mut changed = Vec::new();
    let flagged =
        |items: &Vec<MemoryItem>| items.iter().any(|i| matches!(i, MemoryItem::Bullet { outside_review: true, .. }));
    if memory.as_ref().map_or(true, flagged) {
        changed.push(strive_learning::MEMORY_PATH.to_string());
    }
    let mut paths: HashMap<u64, String> = HashMap::new();
    let mut replaced: HashMap<u64, Option<Digest>> = HashMap::new();
    let mut left: BTreeMap<String, Option<Digest>> = BTreeMap::new();
    for e in entries {
        match &e.event {
            Event::ProposalMade { proposal: Proposal { change: Change::Skill { name, .. }, .. }, .. } => {
                if let Ok(rel) = strive_learning::relative_path(&Artifact::Skill { name: name.clone() }) {
                    paths.insert(e.seq, rel);
                }
            }
            Event::ProposalApplied { proposal, before, after, .. } => {
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
    if let Ok(dir) = std::fs::read_dir(Path::new(cwd).join(strive_learning::SKILLS_DIR)) {
        let names = dir.filter_map(Result::ok).filter_map(|e| e.file_name().to_str().map(str::to_string));
        files.extend(
            names
                .filter(|n| strive_learning::valid_skill_name(n))
                .map(|n| format!("{}/{n}/SKILL.md", strive_learning::SKILLS_DIR)),
        );
    }
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

/// Marks the applied proposals a rollback would succeed for now, by the
/// rule `rollback` applies (`undo`): what they wrote is still as they wrote
/// it, or already undone (a rollback a crash cut off, which a retry
/// records). Any other would be refused.
async fn rollable(state: &State, cwd: &str, folded: &mut [Folded]) -> Result<(), RpcError> {
    let mut now: HashMap<String, Option<Vec<u8>>> = HashMap::new();
    for f in folded.iter_mut() {
        let (ProposalStatus::Applied, Some(applied), None) = (f.state.status, &f.applied, f.state.replaced_by) else {
            continue;
        };
        let Ok(rel) = strive_learning::relative_path(&f.state.proposal.change.artifact()) else { continue };
        let bytes = if let Some(b) = now.get(&rel) {
            b.clone()
        } else {
            let b = file_now(state, cwd, &rel).await?.ok().flatten();
            now.insert(rel, b.clone());
            b
        };
        f.state.can_roll_back = undo(&f.state.proposal.change, applied, f.state.id, bytes.as_deref()).is_ok();
    }
    Ok(())
}

/// Gives each memory proposal that was never applied its one-bullet diff
/// against the file the learner saw; an applied one has what it did.
fn previewed(state: &State, folded: &mut [Folded]) -> Result<(), RpcError> {
    for f in folded.iter_mut().filter(|f| f.state.bullet.is_none()) {
        if let Change::Memory(op) = &f.state.proposal.change {
            let shown = shown_text(state, f.state.before)?;
            f.state.bullet = strive_learning::memory::preview(&shown, op, f.state.id);
        }
    }
    Ok(())
}

/// What undoing an applied proposal does to its file as it is now.
enum Undo {
    /// Memory with its bullet put back as it was.
    Write(Vec<u8>),
    /// A skill's or check's file as it was: these contents, or none (it didn't exist).
    Restore(Option<Digest>),
    /// Nothing: it's already undone.
    Done,
}

fn undo(change: &Change, applied: &strive_learning::Applied, id: u64, now: Option<&[u8]>) -> Result<Undo, String> {
    match change {
        Change::Memory(_) => {
            let Some(edit) = &applied.bullet else {
                return Err(format!("#{id}'s journal entry doesn't say what it did to its bullet"));
            };
            let now = std::str::from_utf8(now.unwrap_or_default())
                .map_err(|_| format!("{} isn't UTF-8 text", strive_learning::MEMORY_PATH))?;
            match strive_learning::memory::undo(now, edit, id)? {
                Some(text) => Ok(Undo::Write(text.into_bytes())),
                None => Ok(Undo::Done),
            }
        }
        Change::Skill { .. } | Change::Check { .. } => {
            let now = now.map(strive_journal::cas::digest);
            if now == Some(applied.after) {
                Ok(Undo::Restore(applied.before))
            } else if now == applied.before {
                Ok(Undo::Done)
            } else {
                Err(format!("it has changed since #{id} was applied"))
            }
        }
    }
}

/// Lines of the project's memory, as it is now, that name a project path
/// which isn't there (`strive_learning::stale`). Nothing if the memory
/// can't be read as a learned file.
async fn stale(state: &State, cwd: &str) -> Result<Vec<StaleMention>, RpcError> {
    let rel = strive_learning::MEMORY_PATH;
    let Ok(Some(bytes)) = file_now(state, cwd, rel).await? else { return Ok(Vec::new()) };
    let text = String::from_utf8_lossy(&bytes);
    let named = strive_learning::stale::named_paths(&text);
    let cwd = cwd.to_string();
    tokio::task::spawn_blocking(move || {
        named
            .into_iter()
            .filter(|(_, p)| std::fs::symlink_metadata(Path::new(&cwd).join(p)).is_err())
            .map(|(line, missing)| StaleMention { file: rel.to_string(), line, missing })
            .collect()
    })
    .await
    .map_err(|e| internal(&e))
}

/// The project's memory as it is now, as every session reads it, each
/// bullet marked if it's changed outside review; or why it can't be read as
/// a learned file.
async fn memory_now(state: &State, cwd: &str, folded: &[Folded]) -> Result<Result<Vec<MemoryItem>, String>, RpcError> {
    let rel = strive_learning::MEMORY_PATH;
    Ok(match file_now(state, cwd, rel).await? {
        Err(why) => Err(why),
        Ok(None) => Ok(Vec::new()),
        Ok(Some(bytes)) => match String::from_utf8(bytes) {
            Ok(text) => Ok(strive_learning::memory::view(&text, folded)),
            Err(_) => Err(format!("{rel} isn't UTF-8 text")),
        },
    })
}

/// The file as the learner was shown it, from the content store; empty if
/// there was none.
fn shown_text(state: &State, before: Option<Digest>) -> Result<String, RpcError> {
    let Some(d) = before else { return Ok(String::new()) };
    let bytes = state.cas.get(&d).map_err(|e| internal(&e))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The static gate: the proposal's own text against the file as the
/// learner was shown it (`before`), where its file resolves (and that
/// what's there now is a file it could change), and its evidence.
async fn static_gate(state: &State, cwd: &str, p: &Proposal, before: Option<Digest>) -> Result<Vec<Finding>, RpcError> {
    let known: Vec<String> =
        crate::credentials::PROVIDERS.iter().filter_map(|(provider, _)| state.credentials.get(provider)).collect();
    let shown = shown_text(state, before)?;
    let mut findings = strive_learning::check(p, &known, Some(&shown));
    if let Ok(rel) = strive_learning::relative_path(&p.change.artifact())
        && let Err(why) = file_now(state, cwd, &rel).await?
    {
        findings.push(Finding::new(Rule::Path, why));
    }
    findings.extend(evidence(state, cwd, &p.evidence));
    Ok(findings)
}

/// The artifact's file as it is now, if it's where it may be: its bytes,
/// none if it doesn't exist, or why it can't be used.
pub async fn file_now(state: &State, cwd: &str, rel: &str) -> Result<Result<Option<Vec<u8>>, String>, RpcError> {
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
pub fn journal(state: &State, sid: &SessionId) -> Result<Vec<Entry>, RpcError> {
    let (_, report) = state.sessions.read(sid).map_err(session_error)?;
    match report.problem {
        Some(p) => Err(session_error(SessionError::Invalid(p))),
        None => Ok(report.entries),
    }
}

/// The project's proposals, oldest first, after finishing any checks a
/// crash cut short: gates without a verdict are run again, and a judge
/// call that isn't running is started. Call with the project's lock held.
pub async fn settled(state: &Arc<State>, sid: &SessionId, cwd: &str) -> Result<Vec<Folded>, RpcError> {
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
            let (v, detail) =
                strive_learning::verdict(&static_gate(state, cwd, &f.state.proposal, f.state.before).await?);
            events.push(Event::GateFinished { proposal: id, gate: Gate::Static, verdict: v, detail });
            v
        };
        if had(Gate::Judge).is_some() || state.learning.judging.has(sid, id) {
            continue;
        }
        let p = &f.state;
        let made = crate::judge::Made { proposal: &p.proposal, before: p.before, at_ms: p.made_at_ms };
        match judge_plan(state, cwd, static_verdict, &made, &entries) {
            crate::judge::Plan::Now(verdict, detail) => {
                events.push(Event::GateFinished { proposal: id, gate: Gate::Judge, verdict, detail });
            }
            crate::judge::Plan::Call(call) => calls.push((id, call)),
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
            ProposalStatus::Ready => {
                let entries = apply(state, &sid, cwd, &f, by).await?;
                reply::<ProposalDecide>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
            }
            ProposalStatus::Failed => Err(refused(format!(
                "proposal #{id} failed its safety checks, so it can't be accepted; `strive review {id}` shows why"
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

/// Writes an accepted proposal over the file as it is now: a memory
/// proposal if its bullet still reads as the learner saw it, a skill if its
/// file is still as the learner saw it. Otherwise the accept is recorded
/// alone, which makes it stale.
async fn apply(state: &State, sid: &SessionId, cwd: &str, f: &Folded, by: String) -> Result<Vec<Entry>, RpcError> {
    let id = f.state.id;
    let rel = strive_learning::relative_path(&f.state.proposal.change.artifact()).map_err(refused)?;
    let Some(_running) = state.sessions.begin_effect() else {
        return Err(internal(&"the daemon is stopping"));
    };
    // As an agent's write would: no edit of this file, and no rewind of
    // the project, runs while it's compared and written.
    let path = Path::new(cwd).join(&rel);
    let _file = state.sessions.workspaces.file(&path).await;
    let _project = state.sessions.workspaces.effect(vec![PathBuf::from(cwd)]).await;
    let now = file_now(state, cwd, &rel).await?.map_err(refused)?;
    let before = now.as_deref().map(|b| state.cas.put(b)).transpose().map_err(|e| internal(&e))?;
    let accepted = Event::ProposalDecided { proposal: id, decision: ProposalDecision::Accept, by };
    let mut events = vec![accepted];
    // What to write, if anything, and what to journal as applied.
    let (write, applied) = match &f.state.proposal.change {
        Change::Memory(op) => {
            let now =
                String::from_utf8(now.unwrap_or_default()).map_err(|_| refused(format!("{rel} isn't UTF-8 text")))?;
            match strive_learning::memory::apply(&now, &shown_text(state, f.state.before)?, op, id) {
                Ok(a) => {
                    let after = state.cas.put(a.text.as_bytes()).map_err(|e| internal(&e))?;
                    // Already there: an accept a crash cut off after its write, which this records.
                    let write = a.written.then(|| a.text.into_bytes());
                    (write, Some(Event::ProposalApplied { proposal: id, before, after, bullet: Some(a.edit) }))
                }
                Err(why) => {
                    crate::log!("proposal #{id} is stale: {why}");
                    (None, None)
                }
            }
        }
        Change::Skill { content, .. } | Change::Check { content, .. } => {
            let after = state.cas.put(content.as_bytes()).map_err(|e| internal(&e))?;
            let applied = Event::ProposalApplied { proposal: id, before: f.state.before, after, bullet: None };
            if before == f.state.before {
                (Some(content.clone().into_bytes()), Some(applied))
            } else if before == Some(after) {
                // The file is written and journals come after it, so a crash
                // between leaves the proposal's content with nothing recorded:
                // this retry records the apply over the file as the learner saw
                // it, so it can be rolled back.
                (None, Some(applied))
            } else {
                (None, None)
            }
        }
    };
    if let Some(bytes) = write {
        tokio::task::spawn_blocking(move || write_now(&path, &rel, Some(&bytes)))
            .await
            .map_err(|e| internal(&e))?
            .map_err(|why| refused(format!("{why}; nothing was written")))?;
    }
    events.extend(applied);
    state.sessions.append(sid, events).await.map_err(session_error)
}

/// Undoes an applied proposal: a memory proposal's bullet put back as it
/// was, a skill's file as it was. Refused if that has changed since.
async fn rollback(state: &Arc<State>, cwd: &str, id: u64, by: String) -> Reply {
    let (sid, f, _held) = proposal(state, cwd, id).await?;
    let applied = match (f.state.status, &f.applied) {
        (ProposalStatus::Applied, Some(applied)) => applied,
        (status, _) => {
            return Err(refused(format!(
                "proposal #{id} is {}; only an applied proposal can be rolled back",
                strive_learning::status_name(status)
            )));
        }
    };
    let rel = strive_learning::relative_path(&f.state.proposal.change.artifact()).map_err(refused)?;
    if let Some(by) = f.state.replaced_by {
        return Err(refused(format!(
            "#{by} was accepted over proposal #{id} and changed what it wrote, so nothing was rolled back; \
             roll back #{by} first, or edit {rel} by hand"
        )));
    }
    let Some(_running) = state.sessions.begin_effect() else {
        return Err(internal(&"the daemon is stopping"));
    };
    let path = Path::new(cwd).join(&rel);
    let _file = state.sessions.workspaces.file(&path).await;
    let _project = state.sessions.workspaces.effect(vec![PathBuf::from(cwd)]).await;
    let now = file_now(state, cwd, &rel).await?.map_err(refused)?;
    let write = match undo(&f.state.proposal.change, applied, id, now.as_deref()) {
        Ok(Undo::Write(bytes)) => Some(Some(bytes)),
        Ok(Undo::Restore(old)) => Some(old.map(|d| state.cas.get(&d)).transpose().map_err(|e| internal(&e))?),
        // Already as it was before: a rollback a crash cut off between its
        // write and its journal, which this retry records.
        Ok(Undo::Done) => None,
        Err(why) => {
            return Err(refused(format!("{rel}: {why}, so nothing was rolled back; edit it by hand instead")));
        }
    };
    if let Some(bytes) = write {
        tokio::task::spawn_blocking(move || write_now(&path, &rel, bytes.as_deref()))
            .await
            .map_err(|e| internal(&e))?
            .map_err(|why| refused(format!("{why}; nothing was rolled back")))?;
    }
    let entries = state
        .sessions
        .append(&sid, vec![Event::ProposalRolledBack { proposal: id, by }])
        .await
        .map_err(session_error)?;
    reply::<ProposalRollback>(Appended { seq: entries.last().map_or(0, |e| e.seq) })
}
