//! The replay gate in the daemon (ADR-0018): past tasks of the project,
//! mined from its work journals, run again by the agent with and without a
//! proposal, each in a scratch copy of the files as they were.
//!
//! Every run is a session of its own (`kind: replay`): the real host, the
//! gateway and the sandbox, full-auto approvals with no one attached, and a
//! budget carved from a hold on the learning session's. Its commands may
//! write only in its scratch area, which lies outside the project; its
//! agent's writes elsewhere ask, and are refused. The task's check command
//! runs afterwards as an effect of that session, sandboxed and journaled.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use strive_budget::{Ledger, Limits, Refusal, format_usd};
use strive_learning::replay::{Task, TaskTally};
use strive_proto::{
    ApprovalMode, Digest, EffectOutcome, EffectRecord, EffectRequest, Entry, Event, Proposal, ReplayRun, SessionKind,
    TurnEnd, Verdict,
};

use crate::server::State;
use crate::sessions::{Push, ReplayDone, SessionId};

/// How long a run's host has to start its turn.
const START_LIMIT: Duration = Duration::from_secs(60);
/// How long past the turn's own time limit a run is waited for.
const TURN_GRACE: Duration = Duration::from_secs(60);
/// The check command's time limit.
const CHECK_TIMEOUT_MS: u64 = 300_000;
/// The call id a run's check is journaled under.
const CHECK_CALL: &str = "replay-check";

/// What the replay gate does with a proposal.
pub enum Plan {
    /// Journal it as skipped, for this reason.
    Now(String),
    /// Run these tasks.
    Run(Replay),
}

#[derive(Clone)]
pub struct Replay {
    model: String,
    cap: u64,
    runs: u32,
    tasks: Vec<Task>,
    /// The learned files as the learner was shown them, in every run.
    learned: Vec<(String, Digest)>,
    /// The proposal's file and content, in the runs with the change.
    path: String,
    content: String,
}

/// Replays running, by learning session and proposal, with a flag that
/// stops each before its next run; and the sessions their runs use, with
/// whether the gateway refused one of their calls for want of budget.
#[derive(Default)]
pub struct Running {
    proposals: StdMutex<HashMap<(SessionId, u64), Arc<AtomicBool>>>,
    runs: StdMutex<HashMap<SessionId, bool>>,
}

impl Running {
    pub fn has(&self, sid: &SessionId, id: u64) -> bool {
        crate::sync::lock(&self.proposals).contains_key(&(sid.clone(), id))
    }

    /// Stops proposal `id`'s replay, if one is going, before its next run:
    /// a person rejected it, so its verdict can't matter.
    pub fn cancel(&self, sid: &SessionId, id: u64) {
        if let Some(stop) = crate::sync::lock(&self.proposals).get(&(sid.clone(), id)) {
            stop.store(true, Ordering::SeqCst);
        }
    }

    /// Replays running now: they keep the daemon from idling out.
    pub fn count(&self) -> u32 {
        u32::try_from(crate::sync::lock(&self.proposals).len()).unwrap_or(u32::MAX)
    }

    /// The gateway refused a call of `session` for its budget.
    pub fn note_refused(&self, session: &SessionId) {
        if let Some(refused) = crate::sync::lock(&self.runs).get_mut(session) {
            *refused = true;
        }
    }
}

/// Removes a replay from `Running` however it ends.
struct Mark {
    state: Arc<State>,
    key: (SessionId, u64),
}

impl Drop for Mark {
    fn drop(&mut self) {
        crate::sync::lock(&self.state.learning.replaying.proposals).remove(&self.key);
    }
}

fn skipped(why: impl Into<String>) -> Plan {
    Plan::Now(format!("not run: {}", why.into()))
}

/// The replayed agent's model: `replay.model`, else the cheaper of the
/// agent's and the judge's, by output price.
fn model(state: &State) -> String {
    if let Some(m) = &state.settings.replay.model {
        return m.clone();
    }
    let price = |m: &str| state.models.get(m).map_or(u64::MAX, |p| p.price.output.saturating_add(p.price.input));
    let agent = state.settings.model.clone();
    match &state.settings.judge_model {
        Some(judge) if price(judge) < price(&agent) => judge.clone(),
        _ => agent,
    }
}

/// Where a replay session's commands may write besides its workspace: the
/// scratch area's `tmp`, beside the `work` directory it runs in.
pub fn temp_of(cwd: &str) -> Option<PathBuf> {
    Path::new(cwd).parent().map(|scratch| scratch.join("tmp"))
}

/// Decides whether the proposal can be replayed, and if so which tasks.
/// `learning` is the learning session's journal; `made_at_ms` is when the
/// proposal was made, so a later session isn't mined for it.
pub fn plan(state: &State, cwd: &str, proposal: &Proposal, made_at_ms: u64, learning: &[Entry]) -> Plan {
    let settings = &state.settings.replay;
    let cap = settings.budget_micros();
    if cap == 0 {
        return skipped("replay is off (\"replay\": {\"budgetUsd\": 0} in ~/.strive/settings.json)");
    }
    if state.settings.sandbox == crate::settings::SandboxSetting::Off || !crate::effects::sandbox_available() {
        return skipped(
            "replayed commands run only in the OS sandbox, and there's none here (or \"sandbox\" is \"off\")",
        );
    }
    if !crate::hosts::Hosts::available() {
        return skipped(
            "no agent host can be started to replay tasks (STRIVE_HOST is \"none\", or strive-tui is missing)",
        );
    }
    let model = model(state);
    if state.models.get(&model).is_none() {
        return skipped(format!(
            "no price is known for the replay's model {model}; set \"replay\": {{\"model\": ...}} or add it under \"models\" in ~/.strive/settings.json"
        ));
    }
    let provider = crate::methods::provider_of(&model);
    if state.credentials.get(provider).is_none() {
        return skipped(format!(
            "there's no {provider} API key for the replayed agent; `strive auth {provider}` sets one"
        ));
    }
    let Ok(path) = strive_learning::relative_path(&proposal.artifact) else {
        return skipped("the proposal's file has no path in the project");
    };
    let cited: Vec<&str> = proposal.evidence.iter().map(|e| e.session.as_str()).collect();
    let (tasks, passed_over) = tasks(state, cwd, &cited, made_at_ms, settings.tasks);
    if tasks.is_empty() {
        let over = match passed_over.first() {
            Some((check, path)) => format!(
                ", other than checks that name a path outside the project and so pass or fail by more than the \
                 change (`{check}` names {path}, outside the project)"
            ),
            None => String::new(),
        };
        return skipped(format!(
            "no past task could be replayed: no session of this project that the proposal doesn't cite ran a \
             command that failed and later passed{over}"
        ));
    }
    let learned = crate::judge::shown_files(learning);
    Plan::Run(Replay { model, cap, runs: settings.runs, tasks, learned, path, content: proposal.content.clone() })
}

/// Up to `limit` tasks from the project's newest work sessions the proposal
/// doesn't cite, begun before it, whose journals verify and whose
/// checkpoints are there to start from; and the checks passed over for
/// naming a path outside the project, with the path.
fn tasks(
    state: &State,
    cwd: &str,
    cited: &[&str],
    made_at_ms: u64,
    limit: usize,
) -> (Vec<Task>, Vec<(String, String)>) {
    let (mut out, mut passed_over) = (Vec::new(), Vec::new());
    let Ok((sessions, _)) = state.sessions.list(Some(cwd), SessionKind::Work) else { return (out, passed_over) };
    let names: Vec<&str> = std::iter::once(cwd).chain(alias(cwd)).collect();
    for s in sessions.into_iter().filter(|s| !cited.contains(&s.id.as_str()) && s.created_at_ms <= made_at_ms) {
        let Some(sid) = SessionId::parse(&s.id) else { continue };
        let Some(entries) = crate::judge::verified(state, cwd, &s.id) else { continue };
        if !state.sessions.checkpoint_dir(&sid).join("HEAD").exists() {
            continue;
        }
        for task in strive_learning::replay::mine(&s.id, &entries) {
            match strive_learning::replay::outside_path(&task.check, &names) {
                Some(path) => passed_over.push((task.check, path)),
                None => out.push(task),
            }
        }
        if out.len() >= limit {
            break;
        }
    }
    out.truncate(limit);
    (out, passed_over)
}

/// The other name a directory goes by: `/tmp/p` for `/private/tmp/p` on macOS.
fn alias(dir: &str) -> Option<&str> {
    dir.strip_prefix("/private").filter(|a| a.starts_with('/'))
}

/// Starts the replay of proposal `id` in the background. Call with the
/// project's lock held, so no other look starts one too.
pub fn start(state: &Arc<State>, sid: &SessionId, id: u64, replay: Replay) {
    let key = (sid.clone(), id);
    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut running = crate::sync::lock(&state.learning.replaying.proposals);
        if running.contains_key(&key) {
            return;
        }
        running.insert(key.clone(), stop.clone());
    }
    let mark = Mark { state: state.clone(), key };
    let (state, sid) = (state.clone(), sid.clone());
    tokio::spawn(async move {
        match state.sessions.hold(&sid, id, replay.cap).await {
            Ok(Ok(_)) => {
                let (ended, done) = run(&state, &sid, id, replay, &stop).await;
                let journaled = match ended {
                    Ended::Verdict(verdict, detail) => {
                        crate::learning::replayed(&state, &sid, id, verdict, detail, Some(done)).await
                    }
                    Ended::Stopped(why) => crate::learning::replay_stopped(&state, &sid, id, why, done).await,
                };
                if let Err(e) = journaled {
                    crate::log!("could not journal the replay of proposal #{id}: {e:?}");
                }
            }
            Ok(Err(refusal)) => {
                let detail = format!("not run: {}", unaffordable(&refusal, replay.cap));
                if let Err(e) = crate::learning::replayed(&state, &sid, id, Verdict::Skipped, detail, None).await {
                    crate::log!("could not journal the replay of proposal #{id}: {e:?}");
                }
            }
            Err(e) => crate::log!("could not hold the budget for the replay of proposal #{id}: {e:?}"),
        }
        drop(mark);
    });
}

fn unaffordable(r: &Refusal, cap: u64) -> String {
    match *r {
        Refusal::Usd { limit, committed, .. } => format!(
            "the replay may spend up to {} (\"replay\": {{\"budgetUsd\"}} in ~/.strive/settings.json), but only {} of the learning session's {} budget is left",
            format_usd(cap),
            format_usd(limit.saturating_sub(committed)),
            format_usd(limit)
        ),
        Refusal::Tokens { limit, committed, .. } => {
            format!("the learning session has used {committed} of its {limit} tokens")
        }
    }
}

/// One run: how its check went, what it cost, and whether the gateway
/// refused one of its calls for want of budget.
struct Ran {
    session: String,
    /// Whether the check passed, or why the run couldn't go on.
    passed: Result<bool, String>,
    cost: u64,
    tokens: u64,
    out_of_budget: bool,
}

/// How a replay ended: with a verdict and its detail, or stopped before its
/// runs were over, for this reason, with none.
enum Ended {
    Verdict(Verdict, String),
    Stopped(&'static str),
}

/// Every run, interleaved (without, with, without, ...) so a cap that runs
/// out doesn't fall on one side, until `stop` is set. Returns how it ended
/// and what `ReplayFinished` records.
async fn run(state: &Arc<State>, learning: &SessionId, id: u64, r: Replay, stop: &AtomicBool) -> (Ended, ReplayDone) {
    let mut done = ReplayDone { proposal: id, cost_usd_micros: 0, tokens: 0, runs: Vec::new() };
    let mut tallies = Vec::new();
    let mut stopped: Option<String> = None;
    let mut set_aside: Vec<String> = Vec::new();
    'tasks: for task in &r.tasks {
        let mut tally = TaskTally {
            session: task.session.clone(),
            prompt_seq: task.prompt_seq,
            check: task.check.clone(),
            ..TaskTally::default()
        };
        for _ in 0..r.runs {
            for with_change in [false, true] {
                if stop.load(Ordering::SeqCst) {
                    return (Ended::Stopped("it was rejected"), done);
                }
                let left = r.cap.saturating_sub(done.cost_usd_micros);
                let ran = match once(state, (learning, id), &r, task, with_change, left).await {
                    Ok(ran) => ran,
                    Err(Unrun::SetAside(why)) => {
                        set_aside.push(format!(
                            "session {} #{} `{}`: set aside: {why}",
                            task.session, task.prompt_seq, task.check
                        ));
                        continue 'tasks;
                    }
                    Err(Unrun::Broke(why)) => {
                        stopped = Some(format!("a run couldn't be set up ({why})"));
                        break 'tasks;
                    }
                };
                done.cost_usd_micros = done.cost_usd_micros.saturating_add(ran.cost);
                done.tokens = done.tokens.saturating_add(ran.tokens);
                let passed = match ran.passed {
                    Ok(passed) => passed,
                    Err(why) => {
                        stopped = Some(format!("a run couldn't finish ({why}; replay session {})", ran.session));
                        break 'tasks;
                    }
                };
                done.runs.push(ReplayRun {
                    session: ran.session,
                    task_session: task.session.clone(),
                    task_seq: task.prompt_seq,
                    with_change,
                    passed,
                });
                let (passed_count, runs) = if with_change {
                    (&mut tally.with_passed, &mut tally.with_runs)
                } else {
                    (&mut tally.without_passed, &mut tally.without_runs)
                };
                *runs += 1;
                *passed_count += u32::from(passed);
                if ran.out_of_budget {
                    stopped = Some(format!(
                        "the replay's cap of {} ran out after {} runs; raise \"replay\": {{\"budgetUsd\"}} in ~/.strive/settings.json",
                        format_usd(r.cap),
                        done.runs.len()
                    ));
                    break 'tasks;
                }
            }
        }
        tallies.push(tally);
    }
    crate::log!("replay of proposal #{id} in learning session {} done", learning.as_str());
    let cost = format!("{} of its {} cap", format_usd(done.cost_usd_micros), format_usd(r.cap));
    let aside: String = set_aside.iter().flat_map(|l| ["\n", l.as_str()]).collect();
    if let Some(why) = stopped {
        return (
            Ended::Verdict(Verdict::Skipped, format!("not run to the end: {why}\n{}, {cost}{aside}", r.model)),
            done,
        );
    }
    if tallies.is_empty() {
        return (Ended::Verdict(Verdict::Skipped, format!("not run: every task was set aside{aside}")), done);
    }
    let (verdict, detail) = strive_learning::replay::verdict(&tallies, &r.model, &cost);
    (Ended::Verdict(verdict, format!("{detail}{aside}")), done)
}

/// A scratch area outside the project: `work` is the copy the agent runs
/// in, `tmp` where its commands may also write. Removed when dropped.
struct Scratch {
    _dir: tempfile::TempDir,
    root: PathBuf,
    work: PathBuf,
}

fn scratch(project: &Path) -> std::io::Result<Scratch> {
    let dir = tempfile::Builder::new().prefix("strive-replay-").tempdir_in(std::env::temp_dir())?;
    let root = dir.path().canonicalize()?;
    if root.starts_with(project) || project.starts_with(&root) {
        return Err(std::io::Error::other(format!(
            "the temp directory {} overlaps the project {}",
            root.display(),
            project.display()
        )));
    }
    let work = root.join("work");
    std::fs::create_dir(&work)?;
    std::fs::create_dir(root.join("tmp"))?;
    Ok(Scratch { _dir: dir, root, work })
}

/// Why a run couldn't start.
enum Unrun {
    /// The task can't be replayed safely; the other tasks still can.
    SetAside(String),
    /// Something broke; the replay stops.
    Broke(String),
}

/// The first path from `work` to any of `rels` (each component, the last
/// included) that is a symlink in the copy. A checkpoint's tree can hold
/// symlinks, and the daemon, which runs unsandboxed, must not remove or
/// write the learned files through one.
fn linked(work: &Path, rels: &[&str]) -> Option<String> {
    rels.iter().find_map(|rel| {
        let mut at = PathBuf::new();
        Path::new(rel).components().find_map(|c| {
            at.push(c);
            let link = work.join(&at).symlink_metadata().is_ok_and(|m| m.file_type().is_symlink());
            link.then(|| at.display().to_string())
        })
    })
}

/// Writes `bytes` at `rel` under `root`, making its directories, without
/// following a symlink on the way.
fn put(root: &Path, rel: &str, bytes: &[u8]) -> std::io::Result<()> {
    use crate::pinned::Error as E;
    crate::pinned::parent(&root.join(rel), true).and_then(|(dir, name)| dir.replace(&name, bytes)).map_err(
        |e| match e {
            E::Changed => std::io::Error::other(format!("a directory on the way to {rel} is a symlink")),
            E::NotRegular => std::io::Error::other(format!("{rel} isn't a regular file")),
            E::NotFound => std::io::Error::from(std::io::ErrorKind::NotFound),
            E::Io(e) => e,
        },
    )
}

/// The task's files as they were before its prompt, with the learned files
/// as the learner was shown them in place of the checkpoint's, and the
/// proposal's file when `with_change`. A checkpoint with a symlink on the
/// way to a learned file sets the task aside.
fn materialize(state: &State, r: &Replay, task: &Task, with_change: bool, s: &Scratch) -> Result<(), Unrun> {
    let broke = |e: std::io::Error| {
        Unrun::Broke(format!("copying checkpoint {} of session {}: {e}", task.commit, task.session))
    };
    let sid =
        SessionId::parse(&task.session).ok_or_else(|| Unrun::Broke("the task's session id isn't valid".into()))?;
    let shadow = crate::checkpoints::Shadow::new(&state.sessions.checkpoint_dir(&sid), &s.work)
        .ok_or_else(|| Unrun::Broke("checkpoints need git, which isn't available".into()))?;
    let index = s.root.join("index");
    shadow.export(&task.commit, &index).map_err(broke)?;
    std::fs::remove_file(&index).map_err(broke)?;
    let mut rels = vec![strive_learning::MEMORY_PATH, strive_learning::SKILLS_DIR, r.path.as_str()];
    rels.extend(r.learned.iter().map(|(rel, _)| rel.as_str()));
    if let Some(link) = linked(&s.work, &rels) {
        return Err(Unrun::SetAside(format!(
            "{link} is a symlink in the task's checkpoint, so the learned files can't be put in the copy safely"
        )));
    }
    let memory = s.work.join(strive_learning::MEMORY_PATH);
    if memory.symlink_metadata().is_ok() {
        std::fs::remove_file(&memory).map_err(broke)?;
    }
    // No symlink leads here (checked above), and `remove_dir_all` doesn't
    // follow the ones inside.
    let skills = s.work.join(strive_learning::SKILLS_DIR);
    if skills.symlink_metadata().is_ok() {
        std::fs::remove_dir_all(&skills).map_err(broke)?;
    }
    for (rel, digest) in &r.learned {
        put(&s.work, rel, &state.cas.get(digest).map_err(broke)?).map_err(broke)?;
    }
    if with_change {
        put(&s.work, &r.path, r.content.as_bytes()).map_err(broke)?;
    }
    Ok(())
}

/// One run of proposal `of.1`'s replay in learning session `of.0`, with
/// `left` of its cap to spend.
async fn once(
    state: &Arc<State>,
    of: (&SessionId, u64),
    r: &Replay,
    task: &Task,
    with_change: bool,
    left: u64,
) -> Result<Ran, Unrun> {
    let broke = |why: &str| Unrun::Broke(why.to_string());
    let project = state
        .sessions
        .peek(&SessionId::parse(&task.session).ok_or_else(|| broke("the task's session id isn't valid"))?)
        .map(|i| PathBuf::from(i.cwd))
        .ok_or_else(|| broke("the task's session is gone"))?;
    let s = scratch(&project).map_err(|e| broke(&format!("making a scratch copy: {e}")))?;
    let (st, rr, t) = (state.clone(), r.clone(), task.clone());
    let s = tokio::task::spawn_blocking(move || materialize(&st, &rr, &t, with_change, &s).map(|()| s))
        .await
        .map_err(|e| broke(&e.to_string()))??;
    let cwd = s.work.display().to_string();
    let limits = Limits { usd_micros: Some(left), tokens: None };
    let info = state
        .sessions
        .create(cwd, limits, ApprovalMode::FullAuto, Some(SessionKind::Replay))
        .await
        .map_err(|e| broke(&format!("creating a replay session: {e:?}")))?;
    let sid = SessionId::parse(&info.id).ok_or_else(|| broke("the replay session's id isn't valid"))?;
    // Named before it can spend: a crash from here on leaves the hold's runs findable.
    let (learning, proposal) = of;
    let named = Event::ReplayRunStarted { proposal, session: info.id.clone() };
    state
        .sessions
        .append(learning, vec![named])
        .await
        .map_err(|e| broke(&format!("naming the run in the learning session: {e:?}")))?;
    crate::sync::lock(&state.learning.replaying.runs).insert(sid.clone(), false);
    let result = drive(state, &sid, r, task, &project, &s).await;
    let refused = crate::sync::lock(&state.learning.replaying.runs).remove(&sid).unwrap_or(false);
    state.hosts.stop(&sid);
    let (cost, tokens) = spent(state, &sid, left);
    state.sessions.close(&sid).await;
    drop(s);
    Ok(Ran { session: info.id, passed: result, cost, tokens, out_of_budget: refused })
}

/// The run's session from its prompt to its check: whether the check passed.
/// `text` with the project's directory, under each name it may go by
/// (`/private/tmp/p` is also `/tmp/p` on macOS), made the scratch copy's.
fn relocated(text: &str, project: &Path, work: &Path) -> String {
    let (from, to) = (project.display().to_string(), work.display().to_string());
    let text = strive_learning::replay::relocate(text, &from, &to);
    match alias(&from) {
        Some(alias) => strive_learning::replay::relocate(&text, alias, &to),
        None => text,
    }
}

async fn drive(
    state: &Arc<State>,
    sid: &SessionId,
    r: &Replay,
    task: &Task,
    project: &Path,
    s: &Scratch,
) -> Result<bool, String> {
    let set = state.sessions.set_model(sid, r.model.clone()).await.map_err(|e| format!("{e:?}"))?;
    set.map_err(|why| format!("choosing the model: {why}"))?;
    // Attached (not as a person) before the prompt, so its turn can't end unseen.
    let (_, _, mut stream) = state.sessions.attach(sid, 0, false).await.map_err(|e| format!("{e:?}"))?;
    let prompt = relocated(&task.prompt, project, &s.work);
    state.sessions.prompt(sid, prompt, None).await.map_err(|e| format!("{e:?}"))?;
    let log = state.sessions.session_dir(sid).join("host.log");
    state.hosts.ensure(sid, &state.home.socket(), &log);
    let started = tokio::time::Instant::now();
    let turn_limit = Duration::from_secs(state.settings.turn_seconds) + TURN_GRACE;
    let mut turn: Option<(u64, tokio::time::Instant)> = None;
    loop {
        let deadline = turn.map_or(started + START_LIMIT, |(_, at)| at + turn_limit);
        let push = match tokio::time::timeout_at(deadline, stream.recv()).await {
            Ok(Some(push)) => push,
            Ok(None) => return Err("the replay session's journal stopped".into()),
            Err(_) if turn.is_none() => {
                return Err(format!(
                    "the agent host didn't start within {}s; see {}",
                    START_LIMIT.as_secs(),
                    log.display()
                ));
            }
            Err(_) => {
                // Over its time: the check still runs on what it left.
                let _ = state.sessions.push(sid, Push::Interrupt).await; // the host may be gone
                break;
            }
        };
        let Push::Entry(e) = push else { continue };
        match e.event {
            Event::TurnStarted { turn: n, .. } if turn.is_none() => turn = Some((n, tokio::time::Instant::now())),
            Event::TurnEnded { turn: n, reason } if turn.is_some_and(|(t, _)| t == n) => {
                if let TurnEnd::Failed { error } = &reason {
                    crate::log!("replay session {}: the turn failed: {error}", sid.as_str());
                }
                break;
            }
            _ => {}
        }
    }
    state.hosts.stop(sid);
    check(state, sid, &relocated(&task.check, project, &s.work), s).await
}

/// Runs the task's check in the run's workspace, sandboxed, as an effect of
/// its session: whether it exited 0.
async fn check(state: &Arc<State>, sid: &SessionId, command: &str, s: &Scratch) -> Result<bool, String> {
    let scope = crate::effects::Scope {
        workspace: s.work.clone(),
        strive_home: state.home.root.canonicalize().map_err(|e| e.to_string())?,
        unconfined: false,
        temp: Some(s.root.join("tmp")),
    };
    let request = EffectRequest::Bash { command: command.to_string(), timeout_ms: Some(CHECK_TIMEOUT_MS) };
    let record = EffectRecord::Bash { command: command.to_string(), timeout_ms: CHECK_TIMEOUT_MS };
    let Some(_running) = state.sessions.begin_effect() else { return Err("the daemon is stopping".into()) };
    let effect = state.sessions.start_effect(sid, CHECK_CALL.into(), record).await.map_err(|e| format!("{e:?}"))?;
    let started = std::time::Instant::now();
    let (gate, target) = crate::effects::gate(&scope, &request, ApprovalMode::FullAuto);
    let result = match gate {
        crate::effects::Gate::Allow => {
            let files = state.sessions.workspaces.effect(vec![s.work.clone()]).await;
            let cancelled = std::sync::atomic::AtomicBool::new(false);
            tokio::task::spawn_blocking(move || {
                let _held = files;
                crate::effects::perform(&scope, &request, &target, &cancelled)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        crate::effects::Gate::Ask(what) => crate::effects::Result::Refused(format!("{what} would need approval")),
        crate::effects::Gate::Deny(why) => crate::effects::Result::Refused(why),
    };
    let (outcome, passed) = match result {
        crate::effects::Result::Done { text, exit_code, truncated } => {
            let output = state.cas.put(text.as_bytes()).map_err(|e| e.to_string())?;
            (EffectOutcome::Done { output, exit_code, truncated }, exit_code == Some(0))
        }
        crate::effects::Result::Refused(reason) => (EffectOutcome::Refused { reason }, false),
    };
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    state.sessions.finish_effect(sid, effect, outcome, ms).await.map_err(|e| format!("{e:?}"))?;
    Ok(passed)
}

/// What the run's session spent, from its journal: calls left open are
/// charged their reservation, and a journal that can't be read its whole
/// budget, `left`.
fn spent(state: &State, sid: &SessionId, left: u64) -> (u64, u64) {
    match state.sessions.read(sid) {
        Ok((_, report)) => {
            let events: Vec<Event> = report.entries.into_iter().map(|e| e.event).collect();
            let l = Ledger::replay(&events);
            (l.spent_usd(), l.spent_tokens())
        }
        Err(e) => {
            crate::log!("could not read replay session {} to charge it: {e:?}", sid.as_str());
            (left, 0)
        }
    }
}

/// Finishes, in every learning session, the replay holds a crash cut off.
/// Each is charged what its runs' journals show they spent (calls left open
/// at what they reserved), or the whole hold if a run's journal can't be
/// read. Without this a hold would stay charged in full for good. Call at
/// startup, before any replay can begin, so none of these holds is live.
pub async fn settle_cut_off(state: &State) {
    let learning = match state.sessions.list(None, SessionKind::Learning) {
        Ok((sessions, _)) => sessions,
        Err(e) => {
            crate::log!("could not list learning sessions to settle cut-off replays: {e}");
            return;
        }
    };
    for sid in learning.iter().filter_map(|s| SessionId::parse(&s.id)) {
        let entries = match state.sessions.read(&sid) {
            Ok((_, report)) if report.problem.is_none() => report.entries,
            Ok(_) | Err(_) => continue,
        };
        // Latest first: `ReplayFinished` releases its proposal's latest hold.
        for hold in strive_learning::replay::cut_off(&entries).into_iter().rev() {
            let (cost, tokens) = cut_off_cost(state, &hold);
            crate::log!(
                "the replay of proposal #{} in learning session {} was cut off after {} runs; charged {} of its {} hold",
                hold.proposal,
                sid.as_str(),
                hold.runs.len(),
                format_usd(cost),
                format_usd(hold.reserved_usd_micros)
            );
            let done = ReplayDone { proposal: hold.proposal, cost_usd_micros: cost, tokens, runs: Vec::new() };
            if let Err(e) = state.sessions.release(&sid, done, Vec::new()).await {
                crate::log!("could not settle the replay of proposal #{}: {e:?}", hold.proposal);
            }
        }
    }
}

/// What a cut-off hold's runs spent: the whole hold, at least, if one of
/// their journals can't be read.
fn cut_off_cost(state: &State, hold: &strive_learning::replay::CutOff) -> (u64, u64) {
    let (mut cost, mut tokens, mut unread) = (0u64, 0u64, false);
    for run in &hold.runs {
        let read = SessionId::parse(run).map(|sid| state.sessions.read(&sid));
        match read {
            Some(Ok((_, report))) if report.problem.is_none() => {
                let events: Vec<Event> = report.entries.into_iter().map(|e| e.event).collect();
                let l = Ledger::replay(&events);
                cost = cost.saturating_add(l.spent_usd());
                tokens = tokens.saturating_add(l.spent_tokens());
            }
            Some(Ok(_) | Err(_)) | None => unread = true,
        }
    }
    if unread { (cost.max(hold.reserved_usd_micros), tokens) } else { (cost, tokens) }
}

/// Whether the journal already has proposal `id`'s replay verdict.
pub fn has_verdict(entries: &[Entry], id: u64) -> bool {
    entries.iter().any(
        |e| matches!(&e.event, Event::GateFinished { proposal, gate: strive_proto::Gate::Replay, .. } if *proposal == id),
    )
}
