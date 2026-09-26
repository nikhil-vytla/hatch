//! The judge gate in the daemon (ADR-0017): choosing what the judge sees,
//! calling the model through the daemon's own gateway on the learning
//! session's budget, and journaling the verdict.
//!
//! The rubric, the request and the reading of the answer are in
//! `strive_learning::judge`. Everything here is chosen by the daemon: the
//! learner's only input is its proposal.

use std::collections::HashSet;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use strive_learning::judge::{FileText, Material, RolledBack, SessionText};
use strive_proto::{Digest, Entry, Event, Gate, Proposal, SessionKind, Verdict};

use crate::server::State;
use crate::sessions::SessionId;

/// The most sessions held out, newest first.
pub const HELD_OUT: usize = 3;
/// Characters of held-out journals, shared among them: about 12k tokens.
const HELD_OUT_CHARS: usize = 48_000;
/// Characters of cited journals, shared among them.
const CITED_CHARS: usize = 32_000;
/// Characters of each memory or skill file shown.
const FILE_CHARS: usize = 8_000;
/// The longest the judge's call may take.
const CALL_LIMIT: Duration = Duration::from_secs(300);

/// What the judge gate does with a proposal.
pub enum Plan {
    /// Journal it as skipped (or failed), for this reason, with the proposal.
    Now(Verdict, String),
    /// Call the model, then journal what it says.
    Call(Call),
}

pub struct Call {
    model: String,
    body: Vec<u8>,
    held_out: Vec<String>,
}

/// Proposals whose judge call is running, so a list while one runs doesn't
/// start another. A crash empties it; then the next look judges again.
#[derive(Default)]
pub struct Running(StdMutex<HashSet<(SessionId, u64)>>);

impl Running {
    pub fn has(&self, sid: &SessionId, id: u64) -> bool {
        crate::sync::lock(&self.0).contains(&(sid.clone(), id))
    }
}

/// Removes a proposal from `Running` however its call ends.
struct Mark {
    state: Arc<State>,
    key: (SessionId, u64),
}

impl Drop for Mark {
    fn drop(&mut self) {
        crate::sync::lock(&self.state.learning.judging.0).remove(&self.key);
    }
}

fn skipped(why: impl Into<String>) -> Plan {
    Plan::Now(Verdict::Skipped, format!("not run: {}", why.into()))
}

/// The judge's model: `judgeModel` in settings, else the agent's.
fn model(state: &State) -> &str {
    state.settings.judge_model.as_deref().unwrap_or(&state.settings.model)
}

/// A proposal as the judge gate takes it.
pub struct Made<'a> {
    pub proposal: &'a Proposal,
    /// The file as the learner was shown it.
    pub before: Option<Digest>,
    /// When it was made, so a later session isn't held out against it.
    pub at_ms: u64,
    /// The project's learning mode is `gated`, so the judge is told its
    /// verdict may be final.
    pub gated: bool,
}

/// Decides whether the proposal can be judged, and if so builds the call.
/// `learning` is the learning session's journal.
pub fn plan(state: &State, cwd: &str, made: &Made, learning: &[Entry]) -> Plan {
    let &Made { proposal, before, at_ms: made_at_ms, gated } = made;
    let model = model(state);
    if crate::methods::provider_of(model) != "anthropic" {
        return skipped(format!(
            "the judge runs on Anthropic models, and {model} isn't one; set \"judgeModel\" in ~/.strive/settings.json"
        ));
    }
    if state.credentials.get("anthropic").is_none() {
        return skipped("there's no Anthropic API key for the judge; `strive auth anthropic` sets one");
    }
    if state.models.get(model).is_none() {
        return skipped(format!(
            "no price is known for the judge's model {model}; add it under \"models\" in ~/.strive/settings.json"
        ));
    }
    let blob = |d: &Digest| state.cas.get(d).ok().map(|b| String::from_utf8_lossy(&b).into_owned());
    let cited_ids: Vec<&str> = {
        let mut ids: Vec<&str> = proposal.evidence.iter().map(|e| e.session.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    let held = held_out(state, cwd, &cited_ids, made_at_ms);
    if held.is_empty() {
        return skipped(
            "no work session of this project could be held out: each one is cited by the proposal, \
             has no prompt, or began after it",
        );
    }
    let share = HELD_OUT_CHARS / held.len();
    let held_out: Vec<SessionText> = held
        .iter()
        .map(|(id, entries)| SessionText {
            id: id.clone(),
            journal: strive_learning::render::render(entries, &[], share, &blob),
        })
        .collect();
    let cited: Vec<SessionText> = cited_ids
        .iter()
        .filter_map(|id| {
            let entries = verified(state, cwd, id)?;
            let seqs: Vec<u64> =
                proposal.evidence.iter().filter(|e| e.session == *id).flat_map(|e| e.seqs.iter().copied()).collect();
            let share = CITED_CHARS / cited_ids.len().max(1);
            Some(SessionText {
                id: (*id).to_string(),
                journal: strive_learning::render::render(&entries, &seqs, share, &blob),
            })
        })
        .collect();
    let path = strive_learning::relative_path(&proposal.artifact).unwrap_or_default();
    let current = before.and_then(|d| blob(&d));
    let learned = shown_files(learning)
        .into_iter()
        .filter(|(p, _)| *p != path)
        .filter_map(|(path, d)| Some(FileText { path, text: strive_learning::render::cut(&blob(&d)?, FILE_CHARS) }))
        .collect();
    let folded = strive_learning::fold(learning);
    let rolled_back = strive_learning::rolled_back(&folded, &proposal.artifact)
        .into_iter()
        .map(|s| RolledBack { proposal: s.id, content: s.proposal.content.clone() })
        .collect();
    let material = Material { proposal, current: current.as_deref(), learned, cited, held_out, rolled_back, gated };
    let body = strive_learning::judge::request(model, &material).to_string().into_bytes();
    Plan::Call(Call { model: model.to_string(), body, held_out: held.into_iter().map(|(id, _)| id).collect() })
}

/// The memory and skill files the learner was last shown, by path.
pub fn shown_files(learning: &[Entry]) -> Vec<(String, Digest)> {
    learning
        .iter()
        .rev()
        .find_map(|e| match &e.event {
            Event::ContextLoaded { learned, .. } => Some(learned.clone().unwrap_or_default()),
            _ => None,
        })
        .unwrap_or_default()
        .into_iter()
        .map(|f| (f.path, f.digest))
        .collect()
}

/// A work session of the project whose journal verifies: its entries.
pub fn verified(state: &State, cwd: &str, id: &str) -> Option<Vec<Entry>> {
    let sid = SessionId::parse(id)?;
    let (info, report) = state.sessions.read(&sid).ok()?;
    let work = info.kind.unwrap_or_default() == SessionKind::Work && info.cwd == cwd;
    (work && report.problem.is_none()).then_some(report.entries)
}

/// The project's newest work sessions the proposal doesn't cite, begun
/// before it, with a prompt and a journal that verifies: at most `HELD_OUT`.
pub fn held_out(state: &State, cwd: &str, cited: &[&str], made_at_ms: u64) -> Vec<(String, Vec<Entry>)> {
    let Ok((sessions, _)) = state.sessions.list(Some(cwd), SessionKind::Work) else { return Vec::new() };
    sessions
        .into_iter()
        .filter(|s| !cited.contains(&s.id.as_str()) && s.created_at_ms <= made_at_ms)
        .filter_map(|s| {
            let entries = verified(state, cwd, &s.id)?;
            entries.iter().any(|e| matches!(e.event, Event::UserMessage { .. })).then_some((s.id, entries))
        })
        .take(HELD_OUT)
        .collect()
}

/// Starts the judge's call for proposal `id` in the background. Call with
/// the project's lock held, so no other look starts one too.
pub fn start(state: &Arc<State>, sid: &SessionId, id: u64, call: Call) {
    let key = (sid.clone(), id);
    if !crate::sync::lock(&state.learning.judging.0).insert(key.clone()) {
        return;
    }
    let mark = Mark { state: state.clone(), key };
    let (state, sid) = (state.clone(), sid.clone());
    tokio::spawn(async move {
        let (verdict, detail) = judge(&state, &sid, call).await;
        if let Err(e) = crate::learning::judged(&state, &sid, id, verdict, detail).await {
            crate::log!("could not journal the judge's verdict on proposal #{id}: {e:?}");
        }
        drop(mark);
    });
}

/// The call, through the gateway as the learning session: its budget, its
/// journal. What came back decides the verdict.
async fn judge(state: &State, sid: &SessionId, call: Call) -> (Verdict, String) {
    let Call { model, body, held_out } = call;
    let url = match state.gateway.info(sid) {
        Ok(urls) => format!("{}/v1/messages", urls.anthropic),
        Err(e) => return (Verdict::Fail, format!("failed: the judge couldn't be reached ({e}), so it wasn't judged")),
    };
    let client = match reqwest::Client::builder().no_proxy().timeout(CALL_LIMIT).build() {
        Ok(c) => c,
        Err(e) => return (Verdict::Fail, format!("failed: the judge couldn't be reached ({e}), so it wasn't judged")),
    };
    let sent = client
        .post(url)
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .body(body)
        .send()
        .await;
    let (status, bytes) = match sent {
        Ok(r) => {
            let status = r.status().as_u16();
            match r.bytes().await {
                Ok(b) => (status, b.to_vec()),
                Err(e) => return (Verdict::Fail, broke(&e.to_string())),
            }
        }
        Err(e) => return (Verdict::Fail, broke(&e.to_string())),
    };
    let message = || {
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| String::from_utf8_lossy(&bytes).chars().take(300).collect())
    };
    match status {
        200 => match strive_learning::judge::read(&bytes) {
            Ok(j) => (j.verdict(), strive_learning::judge::detail(&j, &model, &held_out)),
            Err(why) => (Verdict::Fail, strive_learning::judge::unreadable(&why, &model, &held_out)),
        },
        // The gateway's own refusals: the learning session can't pay, or
        // there's no key after all.
        402 => (
            Verdict::Skipped,
            format!("not run: the learning session's budget can't pay for the judge ({})", ours(&message())),
        ),
        401 if message().starts_with("strive: ") => (Verdict::Skipped, format!("not run: {}", ours(&message()))),
        status => (
            Verdict::Fail,
            format!(
                "failed: the judge's call was refused (HTTP {status}: {}), so it wasn't judged; `strive learn` asks for the proposal again",
                message()
            ),
        ),
    }
}

fn ours(message: &str) -> &str {
    message.strip_prefix("strive: ").unwrap_or(message)
}

fn broke(why: &str) -> String {
    format!(
        "failed: the judge's call broke off ({why}), so it wasn't judged; `strive learn` asks for the proposal again"
    )
}

/// Whether the journal already has proposal `id`'s judge verdict.
pub fn has_verdict(entries: &[Entry], id: u64) -> bool {
    entries
        .iter()
        .any(|e| matches!(&e.event, Event::GateFinished { proposal, gate: Gate::Judge, .. } if *proposal == id))
}
