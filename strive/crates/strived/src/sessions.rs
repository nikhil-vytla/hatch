//! Live sessions: one writer thread per open journal.
//!
//! The writer owns the journal, the session's budget ledger and the list of
//! subscribers. Commands queued while it was busy are committed together
//! (one fsync), then broadcast. A model call is reserved against the ledger
//! and journaled as started in one step, and settled and journaled as
//! finished in another, so the ledger always matches the journal. Attaches
//! go through the same thread, after the commit, so a new subscriber's
//! history snapshot and its live stream never overlap or gap.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};

use strive_budget::{Ledger, Limits, Refusal, Reservation, charge, open_calls};
use strive_journal::{Journal, Key, OpenError, Problem, Report};
use strive_proto::{
    ApprovalMode, CallOutcome, Decision, Digest, EffectOutcome, EffectRecord, Entry, Event, Gate, SessionInfo,
    SessionKind, Verdict,
};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::server::epoch_ms;

pub const FORMAT: u32 = 1;

/// A canonical ULID. Parsed at the protocol boundary, so a session id can
/// never name a path outside the sessions directory.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SessionId(String);

impl SessionId {
    pub fn parse(s: &str) -> Option<Self> {
        let u = ulid::Ulid::from_string(s).ok()?;
        (u.to_string() == s).then(|| Self(s.to_string()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug)]
pub enum SessionError {
    NotFound,
    Invalid(Problem),
    Io(io::Error),
}

impl From<io::Error> for SessionError {
    fn from(e: io::Error) -> Self {
        SessionError::Io(e)
    }
}

impl From<OpenError> for SessionError {
    fn from(e: OpenError) -> Self {
        match e {
            OpenError::Io(e) => SessionError::Io(e),
            OpenError::Invalid(p) => SessionError::Invalid(p),
        }
    }
}

type Result<T> = std::result::Result<T, SessionError>;

/// A model call about to be sent upstream.
pub struct CallStart {
    pub provider: String,
    pub model: String,
    pub request: Digest,
    pub reservation: Reservation,
}

#[derive(Debug)]
pub enum CallError {
    Refused(Refusal),
    Session(SessionError),
}

impl From<SessionError> for CallError {
    fn from(e: SessionError) -> Self {
        CallError::Session(e)
    }
}

/// What a session's subscribers receive.
#[derive(Debug, Clone)]
pub enum Push {
    Entry(Entry),
    /// The model's reply so far; shown while it streams, not journaled.
    Delta {
        turn: u64,
        text: String,
    },
    /// The host should stop the current turn.
    Interrupt,
}

enum Cmd {
    /// Journals events a host recorded (turns and assistant messages).
    Append {
        events: Vec<Event>,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    /// Sends something to subscribers without journaling it.
    Push {
        push: Push,
    },
    SetBudget {
        limits: Limits,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    StartCall {
        start: CallStart,
        reply: oneshot::Sender<std::result::Result<u64, CallError>>,
    },
    FinishCall {
        call: u64,
        outcome: CallOutcome,
        response: Option<Digest>,
        duration_ms: u64,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    SetMode {
        mode: ApprovalMode,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    /// The approval mode, and the files allowed for the session.
    GetMode {
        reply: oneshot::Sender<(ApprovalMode, Vec<PathBuf>)>,
    },
    /// Chooses the agent's model; refused (with why) once there is a prompt.
    SetModel {
        model: String,
        reply: oneshot::Sender<std::result::Result<io::Result<Vec<Entry>>, String>>,
    },
    /// The model chosen for the session, if one was.
    GetModel {
        reply: oneshot::Sender<Option<String>>,
    },
    /// Journals an approval request; replies with how many attached clients received it.
    Ask {
        /// An `ApprovalRequested`.
        request: Event,
        reply: oneshot::Sender<io::Result<usize>>,
    },
    Decide {
        effect: u64,
        decision: Decision,
        by: String,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    /// A prompt, preceded by the checkpoint taken just before it.
    Prompt {
        text: String,
        command: Option<strive_proto::CommandUse>,
        commit: Option<String>,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    CheckpointCommit {
        checkpoint: u64,
        reply: oneshot::Sender<Option<String>>,
    },
    /// A checkpoint taken outside a prompt (before a rewind); replies with its number.
    Checkpoint {
        commit: String,
        reply: oneshot::Sender<io::Result<u64>>,
    },
    /// A rewind to `to`; `saved_as` holds the files from just before it.
    Rewound {
        to: u64,
        saved_as: u64,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    /// Whether a reservation would fit, without holding it.
    CheckBudget {
        reservation: Reservation,
        reply: oneshot::Sender<std::result::Result<(), Refusal>>,
    },
    StartEffect {
        call_id: String,
        record: EffectRecord,
        reply: oneshot::Sender<io::Result<u64>>,
    },
    FinishEffect {
        effect: u64,
        outcome: EffectOutcome,
        duration_ms: u64,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    Attach {
        after_seq: u64,
        person: bool,
        reply: AttachReply,
    },
    /// Ends the last turn if it started and didn't end: its host is gone.
    /// Decided here, against what is committed, so no write slips between
    /// the check and the end. Replies with whether it ended one.
    /// Ends `turn` if it is still the open one.
    EndOpenTurn {
        turn: u64,
        reason: strive_proto::TurnEnd,
        reply: oneshot::Sender<io::Result<bool>>,
    },
    /// A proposal and its gates' outcomes, which name it by the seq it gets.
    Propose {
        made: Event,
        gates: Vec<(Gate, Verdict, String)>,
        reply: oneshot::Sender<io::Result<Vec<Entry>>>,
    },
    /// A host's record, checked against the journal before it's staged.
    HostRecord {
        event: Event,
        reply: oneshot::Sender<std::result::Result<io::Result<Vec<Entry>>, String>>,
    },
    /// How many people are attached (clients that aren't agent hosts).
    People {
        reply: oneshot::Sender<usize>,
    },
    /// Finish the batch this arrives in, then exit. Shutdown can't wait for
    /// every sender to drop: a request waiting on a person holds one.
    Stop,
}

/// History for a new subscriber, and its stream of later entries.
type AttachReply = oneshot::Sender<Result<(Vec<Entry>, mpsc::UnboundedReceiver<Push>)>>;

struct Live {
    info: SessionInfo,
    tx: mpsc::UnboundedSender<Cmd>,
    thread: std::thread::JoinHandle<()>,
}

pub struct Sessions {
    root: PathBuf,
    key: Key,
    ids: StdMutex<ulid::Generator>,
    live: Mutex<HashMap<SessionId, Live>>,
    /// Effects waiting for a person's decision.
    pending: StdMutex<HashMap<(SessionId, u64), oneshot::Sender<Decision>>>,
    /// Set by shutdown: no new writers may start.
    stopping: std::sync::atomic::AtomicBool,
    /// One checkpoint at a time per session: git can't share an index.
    checkpointing: StdMutex<HashMap<SessionId, Arc<Mutex<()>>>>,
    /// Cancel flags for effects by the agent's call id. A cancel can arrive
    /// before its effect does, so either side may create the flag.
    cancels: StdMutex<HashMap<(SessionId, String), Arc<std::sync::atomic::AtomicBool>>>,
    /// Directories effects are changing and rewinds are restoring.
    pub workspaces: Arc<crate::workspaces::Workspaces>,
    /// Effects and rewinds running now; shutdown waits for them.
    in_flight: Arc<std::sync::atomic::AtomicUsize>,
    /// Set when shutdown begins: no new effect or rewind may start.
    closing: std::sync::atomic::AtomicBool,
    effects_done: Arc<tokio::sync::Notify>,
}

/// An effect counted as running until dropped.
pub struct InFlight {
    count: Arc<std::sync::atomic::AtomicUsize>,
    done: Arc<tokio::sync::Notify>,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if self.count.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 1 {
            self.done.notify_waiters();
        }
    }
}

/// How an approval request ended.
pub enum Answer {
    Decided(Decision),
    /// No person was (or is still) attached to decide.
    NoOne,
    /// The agent cancelled the effect.
    Cancelled,
}

#[derive(Debug)]
pub enum DecideError {
    /// No approval is pending for that effect: unknown, or already decided.
    NotPending,
    Session(SessionError),
}

impl From<SessionError> for DecideError {
    fn from(e: SessionError) -> Self {
        DecideError::Session(e)
    }
}

impl Sessions {
    pub fn open(home: &Path) -> io::Result<Self> {
        let root = home.join("sessions");
        fs::create_dir_all(&root)?;
        Ok(Self {
            key: load_or_create_key(&home.join("keys"))?,
            root,
            ids: StdMutex::new(ulid::Generator::new()),
            live: Mutex::new(HashMap::new()),
            pending: StdMutex::new(HashMap::new()),
            stopping: std::sync::atomic::AtomicBool::new(false),
            checkpointing: StdMutex::new(HashMap::new()),
            cancels: StdMutex::new(HashMap::new()),
            workspaces: Arc::default(),
            in_flight: Arc::default(),
            closing: std::sync::atomic::AtomicBool::new(false),
            effects_done: Arc::default(),
        })
    }

    fn dir(&self, id: &SessionId) -> PathBuf {
        self.root.join(id.as_str())
    }

    /// Creates a session whose budget starts at `limits` and approvals at `mode`.
    pub async fn create(
        &self,
        cwd: String,
        limits: Limits,
        mode: ApprovalMode,
        kind: Option<SessionKind>,
    ) -> Result<SessionInfo> {
        let id = {
            let mut g = crate::sync::lock(&self.ids);
            SessionId(g.generate().map_err(|e| io::Error::other(e.to_string()))?.to_string())
        };
        let ts = epoch_ms();
        let first = Event::SessionStarted {
            kind,
            format: FORMAT,
            cwd: cwd.clone(),
            strive_version: env!("CARGO_PKG_VERSION").into(),
        };
        let budget = Event::BudgetSet { usd_micros: limits.usd_micros, tokens: limits.tokens };
        let (dir, key, sid) = (self.dir(&id), self.key.clone(), id.clone());
        // Held until the writer is registered: the session is listable as soon
        // as its directory exists, and an attach in that window must find this
        // writer rather than open a second one.
        let mut live = self.live.lock().await;
        let (journal, entries) = tokio::task::spawn_blocking(move || {
            // Committed together: a session never exists without its budget
            // and approval mode.
            let first = [first, budget, Event::ApprovalModeSet { mode }];
            let j = Journal::create(&dir, sid.as_str(), &key, ts, &first)?;
            let entries = first.into_iter().zip(1..).map(|(event, seq)| Entry { seq, ts_ms: ts, event }).collect();
            io::Result::Ok((j, entries))
        })
        .await
        .map_err(|e| io::Error::other(format!("creating the journal failed: {e}")))??;
        let info = SessionInfo {
            id: id.as_str().to_string(),
            cwd,
            created_at_ms: ts,
            title: None,
            last_active_ms: Some(ts),
            kind,
        };
        let (tx, thread) = spawn_writer(journal, entries, self.verifier(&id));
        live.insert(id, Live { info: info.clone(), tx, thread });
        Ok(info)
    }

    /// Sessions of `kind` started in `cwd` (or all of them), newest first,
    /// and the ids of sessions whose first entry can't be read. Those have
    /// no known kind, so they're listed with work sessions, and only when
    /// not filtering by directory. Reads only each journal's first lines;
    /// verification happens on attach and read.
    pub fn list(&self, cwd: Option<&str>, kind: SessionKind) -> io::Result<(Vec<SessionInfo>, Vec<String>)> {
        let mut sessions = Vec::new();
        let mut unreadable = Vec::new();
        for dir in fs::read_dir(&self.root)? {
            let dir = dir?;
            let Some(id) = dir.file_name().to_str().and_then(SessionId::parse) else { continue };
            match peek_info(&id, &dir.path()) {
                Some(info) if cwd.is_none_or(|c| c == info.cwd) && info.kind.unwrap_or_default() == kind => {
                    sessions.push(info);
                }
                None if cwd.is_none() && kind == SessionKind::Work => unreadable.push(id.0),
                _ => {}
            }
        }
        sessions.sort_by(|a, b| b.id.cmp(&a.id));
        unreadable.sort_by(|a, b| b.cmp(a));
        Ok((sessions, unreadable))
    }

    /// The session's history after `after_seq`, and a stream of later entries.
    /// `person` is false for an agent host: it sees everything, but can't
    /// answer approvals.
    pub async fn attach(
        &self,
        id: &SessionId,
        after_seq: u64,
        person: bool,
    ) -> Result<(SessionInfo, Vec<Entry>, mpsc::UnboundedReceiver<Push>)> {
        let (info, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Attach { after_seq, person, reply }).map_err(|_| writer_gone())?;
        let (entries, stream) = rx.await.map_err(|_| writer_gone())??;
        Ok((info, entries, stream))
    }

    pub async fn set_budget(&self, id: &SessionId, limits: Limits) -> Result<Vec<Entry>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::SetBudget { limits, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    pub async fn append(&self, id: &SessionId, events: Vec<Event>) -> Result<Vec<Entry>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Append { events, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    /// Sends a delta or an interrupt to the session's subscribers.
    pub async fn push(&self, id: &SessionId, push: Push) -> Result<()> {
        let (_, tx) = self.writer(id).await?;
        tx.send(Cmd::Push { push }).map_err(|_| writer_gone())
    }

    /// The session's directory in strive's home.
    pub fn session_dir(&self, id: &SessionId) -> PathBuf {
        self.dir(id)
    }

    /// The session's shadow repository for checkpoints.
    pub fn checkpoint_dir(&self, id: &SessionId) -> PathBuf {
        self.dir(id).join("checkpoints.git")
    }

    /// Serializes checkpoint work for one session.
    pub fn checkpoint_lock(&self, id: &SessionId) -> Arc<Mutex<()>> {
        crate::sync::lock(&self.checkpointing).entry(id.clone()).or_default().clone()
    }

    /// Journals a prompt after the checkpoint taken for it.
    pub async fn prompt(
        &self,
        id: &SessionId,
        text: String,
        command: Option<strive_proto::CommandUse>,
        commit: Option<String>,
    ) -> Result<Vec<Entry>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Prompt { text, command, commit, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    pub async fn checkpoint_commit(&self, id: &SessionId, checkpoint: u64) -> Result<Option<String>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::CheckpointCommit { checkpoint, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())
    }

    /// Journals a checkpoint of the files; returns its number.
    pub async fn record_checkpoint(&self, id: &SessionId, commit: String) -> Result<u64> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Checkpoint { commit, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    /// Journals a completed rewind.
    pub async fn record_rewind(&self, id: &SessionId, to: u64, saved_as: u64) -> Result<()> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Rewound { to, saved_as, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())??;
        Ok(())
    }

    /// Counts an effect (or rewind) as running until the returned guard
    /// drops; `None` once shutdown has begun. Counted before the check, so
    /// shutdown either sees it running or it sees shutdown.
    pub fn begin_effect(&self) -> Option<InFlight> {
        self.in_flight.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let guard = InFlight { count: self.in_flight.clone(), done: self.effects_done.clone() };
        (!self.closing.load(std::sync::atomic::Ordering::SeqCst)).then_some(guard)
    }

    /// Stops new effects and rewinds, cancels running effects, and waits (up
    /// to `wait`) for everything to finish and be journaled. Shutdown does
    /// this before stopping writers, so no command outlives the daemon that
    /// started it. False if something is still running.
    pub async fn cancel_effects(&self, wait: std::time::Duration) -> bool {
        use std::sync::atomic::Ordering::SeqCst;
        self.closing.store(true, SeqCst);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            // Again each round: an effect admitted just before `closing` may
            // create its cancel flag after an earlier sweep.
            for flag in crate::sync::lock(&self.cancels).values() {
                flag.store(true, SeqCst);
            }
            if self.in_flight.load(SeqCst) == 0 {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            let done = self.effects_done.notified();
            let _ = tokio::time::timeout(std::time::Duration::from_millis(100), done).await;
        }
    }

    /// Whether a call with this reservation would fit the budget now.
    pub async fn check_budget(&self, id: &SessionId, reservation: Reservation) -> std::result::Result<(), CallError> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::CheckBudget { reservation, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())?.map_err(CallError::Refused)
    }

    /// Reserves the call against the budget and journals it as started.
    /// Returns the call's number within the session.
    pub async fn start_call(&self, id: &SessionId, start: CallStart) -> std::result::Result<u64, CallError> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::StartCall { start, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())?
    }

    /// Settles the call against the budget and journals how it ended.
    pub async fn finish_call(
        &self,
        id: &SessionId,
        call: u64,
        outcome: CallOutcome,
        response: Option<Digest>,
        duration_ms: u64,
    ) -> Result<()> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::FinishCall { call, outcome, response, duration_ms, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())??;
        Ok(())
    }

    /// Whether the session exists and its journal opens.
    pub async fn check(&self, id: &SessionId) -> Result<()> {
        self.writer(id).await.map(|_| ())
    }

    pub async fn info(&self, id: &SessionId) -> Result<SessionInfo> {
        Ok(self.writer(id).await?.0)
    }

    pub async fn set_mode(&self, id: &SessionId, mode: ApprovalMode) -> Result<Vec<Entry>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::SetMode { mode, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    /// Journals the model the session's agent starts with, or says why it can't.
    pub async fn set_model(&self, id: &SessionId, model: String) -> Result<std::result::Result<Vec<Entry>, String>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::SetModel { model, reply }).map_err(|_| writer_gone())?;
        match rx.await.map_err(|_| writer_gone())? {
            Ok(written) => Ok(Ok(written?)),
            Err(why) => Ok(Err(why)),
        }
    }

    /// The model chosen for the session; `None` means the one in settings.
    pub async fn model(&self, id: &SessionId) -> Result<Option<String>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::GetModel { reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())
    }

    /// What the agent may do without asking: the mode, and the files a
    /// person allowed changes to for the rest of the session.
    pub async fn approvals(&self, id: &SessionId) -> Result<(ApprovalMode, Vec<PathBuf>)> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::GetMode { reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())
    }

    /// Asks attached clients to decide on an effect and waits for the answer.
    /// `None` when no client is attached to answer.
    /// `NoOne` too once no person is left to answer, or the daemon is stopping.
    pub async fn ask(
        &self,
        id: &SessionId,
        effect: u64,
        description: String,
        session_file: Option<String>,
        cancelled: &std::sync::atomic::AtomicBool,
    ) -> Result<Answer> {
        let key = (id.clone(), effect);
        let (decided, mut answer) = oneshot::channel();
        crate::sync::lock(&self.pending).insert(key.clone(), decided);
        let delivered = self.request_approval(id, Event::ApprovalRequested { effect, description, session_file }).await;
        if !matches!(delivered, Ok(n) if n > 0) {
            crate::sync::lock(&self.pending).remove(&key);
            return delivered.map(|_| Answer::NoOne);
        }
        let mut check = tokio::time::interval(std::time::Duration::from_millis(250));
        loop {
            tokio::select! {
                                decision = &mut answer => return Ok(Answer::Decided(decision.unwrap_or(Decision::Deny))),
                _ = check.tick() => {
                    let gave_up = if cancelled.load(std::sync::atomic::Ordering::SeqCst) {
                        Answer::Cancelled
                    } else if self.people(id).await.unwrap_or(0) == 0 {
                        Answer::NoOne
                    } else {
                        continue;
                    };
                    // Removing the entry settles a race with `decide`: whoever
                    // removes it owns the outcome.
                    if crate::sync::lock(&self.pending).remove(&key).is_some() {
                        return Ok(gave_up);
                    }
                }
            }
        }
    }

    /// The cancel flag for an effect, created if this is the first to ask.
    pub fn cancel_flag(&self, id: &SessionId, call_id: &str) -> Arc<std::sync::atomic::AtomicBool> {
        crate::sync::lock(&self.cancels).entry((id.clone(), call_id.to_string())).or_default().clone()
    }

    /// Forgets an effect's cancel flag once it has finished.
    pub fn forget_cancel(&self, id: &SessionId, call_id: &str) {
        crate::sync::lock(&self.cancels).remove(&(id.clone(), call_id.to_string()));
    }

    /// Journals the request; how many people it reached. The writer's sender
    /// is dropped before returning, so a long wait doesn't keep the writer up.
    async fn request_approval(&self, id: &SessionId, request: Event) -> Result<usize> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Ask { request, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    /// Ends the session's open turn, if any, as failed for `error`.
    /// Ends `turn` as failed if it is still open; whether it was.
    pub async fn end_open_turn(&self, id: &SessionId, turn: u64, error: &str) -> Result<bool> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        let reason = strive_proto::TurnEnd::Failed { error: error.to_string() };
        tx.send(Cmd::EndOpenTurn { turn, reason, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    /// Journals a proposal followed by its gates' outcomes, in one commit.
    pub async fn propose(
        &self,
        id: &SessionId,
        made: Event,
        gates: Vec<(Gate, Verdict, String)>,
    ) -> Result<Vec<Entry>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Propose { made, gates, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    /// A session's info from its journal's first lines, unverified; `None`
    /// if there's no such session or its start can't be read.
    pub fn peek(&self, id: &SessionId) -> Option<SessionInfo> {
        peek_info(id, &self.dir(id))
    }

    /// Journals a host's record, or says why it doesn't fit the journal.
    pub async fn host_record(&self, id: &SessionId, event: Event) -> Result<std::result::Result<Vec<Entry>, String>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::HostRecord { event, reply }).map_err(|_| writer_gone())?;
        match rx.await.map_err(|_| writer_gone())? {
            Ok(written) => Ok(Ok(written?)),
            Err(why) => Ok(Err(why)),
        }
    }

    /// People attached to the session; an error once the daemon is stopping.
    async fn people(&self, id: &SessionId) -> Result<usize> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::People { reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())
    }

    /// Records a person's decision and lets the waiting effect go on.
    pub async fn decide(
        &self,
        id: &SessionId,
        effect: u64,
        decision: Decision,
        by: String,
    ) -> std::result::Result<(), DecideError> {
        let waiting = crate::sync::lock(&self.pending).remove(&(id.clone(), effect)).ok_or(DecideError::NotPending)?;
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Decide { effect, decision, by, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())?.map_err(SessionError::Io)?;
        let _ = waiting.send(decision);
        Ok(())
    }

    /// Journals an effect as started and returns its number.
    pub async fn start_effect(&self, id: &SessionId, call_id: String, record: EffectRecord) -> Result<u64> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::StartEffect { call_id, record, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
    }

    pub async fn finish_effect(
        &self,
        id: &SessionId,
        effect: u64,
        outcome: EffectOutcome,
        duration_ms: u64,
    ) -> Result<()> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::FinishEffect { effect, outcome, duration_ms, reply }).map_err(|_| writer_gone())?;
        rx.await.map_err(|_| writer_gone())??;
        Ok(())
    }

    /// The journal as it is on disk, verified, without repairing anything.
    /// A journal too damaged to name its session is an error, not a report.
    pub fn read(&self, id: &SessionId) -> Result<(SessionInfo, Report)> {
        let dir = self.dir(id);
        if !dir.is_dir() {
            return Err(SessionError::NotFound);
        }
        let report = strive_journal::read(&dir, id.as_str(), &self.key)?;
        match peek_info(id, &dir) {
            Some(info) if !report.entries.is_empty() => Ok((info, report)),
            _ => Err(report.problem.map_or_else(
                || SessionError::Io(io::Error::other("the journal's first entry is unreadable")),
                SessionError::Invalid,
            )),
        }
    }

    /// The session's writer, opening (verifying, recovering) the journal if
    /// no writer is running. The map lock is held while opening, so two
    /// callers can never start two writers for one journal.
    async fn writer(&self, id: &SessionId) -> Result<(SessionInfo, mpsc::UnboundedSender<Cmd>)> {
        let mut live = self.live.lock().await;
        if self.stopping.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(SessionError::Io(io::Error::other("the daemon is stopping")));
        }
        if let Some(l) = live.get(id).filter(|l| !l.tx.is_closed()) {
            return Ok((l.info.clone(), l.tx.clone()));
        }
        let dir = self.dir(id);
        let info = peek_info(id, &dir).ok_or(SessionError::NotFound)?;
        let (key, sid) = (self.key.clone(), id.clone());
        let (journal, entries) =
            tokio::task::spawn_blocking(move || Journal::open(&dir, sid.as_str(), &key, epoch_ms()))
                .await
                .map_err(|e| io::Error::other(format!("opening the journal failed: {e}")))??;
        let (tx, thread) = spawn_writer(journal, entries, self.verifier(id));
        live.insert(id.clone(), Live { info: info.clone(), tx: tx.clone(), thread });
        Ok((info, tx))
    }

    /// Stops every writer after it finishes what is queued. The daemon calls
    /// this before releasing its ownership lock, so a successor never opens a
    /// journal an old writer is still writing.
    pub async fn shutdown(&self) {
        let live: Vec<Live> = {
            let mut map = self.live.lock().await;
            // Under the map lock, so no writer can start after the drain.
            self.stopping.store(true, std::sync::atomic::Ordering::SeqCst);
            map.drain().map(|(_, l)| l).collect()
        };
        for l in live {
            let _ = l.tx.send(Cmd::Stop); // fails only if the writer already stopped
            drop(l.tx);
            let _ = tokio::task::spawn_blocking(move || l.thread.join()).await;
        }
    }

    /// Reads and verifies the session's journal on disk.
    fn verifier(&self, id: &SessionId) -> Verifier {
        let (dir, id, key) = (self.dir(id), id.clone(), self.key.clone());
        Box::new(move || strive_journal::read(&dir, id.as_str(), &key))
    }
}

fn writer_gone() -> SessionError {
    SessionError::Io(io::Error::other("the session writer stopped after a failed write"))
}

type Verifier = Box<dyn Fn() -> io::Result<Report> + Send>;

/// Runs after the batch commits, with the entries its command appended.
/// Given the entries and how many attached clients received the last one.
type Done = Box<dyn FnOnce(io::Result<Vec<Entry>>, usize) + Send>;

/// What a command asks of the writer.
enum Staged {
    /// Entries to append, and what to do once they are committed.
    Events(Vec<Event>, Done),
    /// A new subscriber, answered after the batch commits.
    Attach(u64, bool, AttachReply),
    /// Answered already; nothing to append.
    Handled,
    Stop,
}

struct Writer {
    journal: Journal,
    entries: Vec<Entry>,
    ledger: Ledger,
    next_call: u64,
    next_effect: u64,
    /// Effects started and not yet finished.
    open_effects: std::collections::BTreeSet<u64>,
    /// Checkpoint commits; checkpoint n is `checkpoints[n - 1]`.
    checkpoints: Vec<String>,
    mode: ApprovalMode,
    /// Files a person allowed changes to for the rest of the session.
    allowed_files: std::collections::BTreeSet<String>,
    /// The model chosen for the agent, and whether a prompt is journaled
    /// (staged ones included), after which it can't change.
    model: Option<String>,
    prompted: bool,
    /// The last turn started, and the one still open (staged ones included).
    last_turn: u64,
    open_turn: Option<u64>,
    /// Attached clients, and whether each is a person (not an agent host):
    /// only people can answer approvals.
    subscribers: Vec<(mpsc::UnboundedSender<Push>, bool)>,
    verify: Verifier,
}

fn spawn_writer(
    journal: Journal,
    entries: Vec<Entry>,
    verify: Verifier,
) -> (mpsc::UnboundedSender<Cmd>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::unbounded_channel::<Cmd>();
    let events: Vec<Event> = entries.iter().map(|e| e.event.clone()).collect();
    let next_call = events
        .iter()
        .filter_map(|e| match e {
            Event::ModelCallStarted { call, .. } => Some(*call),
            _ => None,
        })
        .max()
        .unwrap_or(0)
        + 1;
    let next_effect = events
        .iter()
        .filter_map(|e| match e {
            Event::EffectStarted { effect, .. } => Some(*effect),
            _ => None,
        })
        .max()
        .unwrap_or(0)
        + 1;
    let mode = events
        .iter()
        .rev()
        .find_map(|e| match e {
            Event::ApprovalModeSet { mode } => Some(*mode),
            _ => None,
        })
        .unwrap_or(ApprovalMode::AutoEdit);
    let (mut last_turn, mut open_turn) = (0, None);
    for e in &events {
        match e {
            Event::TurnStarted { turn, .. } => (last_turn, open_turn) = (*turn, Some(*turn)),
            Event::TurnEnded { turn, .. } if open_turn == Some(*turn) => open_turn = None,
            _ => {}
        }
    }
    let w = Writer {
        journal,
        entries,
        last_turn,
        open_turn,
        ledger: Ledger::replay(&events),
        next_call,
        next_effect,
        open_effects: std::collections::BTreeSet::new(),
        checkpoints: events
            .iter()
            .filter_map(|e| match e {
                Event::Checkpointed { commit, .. } => Some(commit.clone()),
                _ => None,
            })
            .collect(),
        mode,
        allowed_files: events
            .iter()
            .filter_map(|e| match e {
                Event::ApprovalDecided { effect, decision: Decision::AllowSession, .. } => {
                    session_file(events.iter(), *effect)
                }
                _ => None,
            })
            .collect(),
        model: events.iter().rev().find_map(|e| match e {
            Event::ModelSet { model } => Some(model.clone()),
            _ => None,
        }),
        prompted: events.iter().any(|e| matches!(e, Event::UserMessage { .. })),
        subscribers: Vec::new(),
        verify,
    };
    (tx, std::thread::spawn(move || w.run(rx)))
}

/// The file an approval request for `effect` offered to allow for the
/// session, if it named one.
fn session_file<'a>(events: impl DoubleEndedIterator<Item = &'a Event>, effect: u64) -> Option<String> {
    events.rev().find_map(|e| match e {
        Event::ApprovalRequested { effect: asked, session_file, .. } if *asked == effect => session_file.clone(),
        _ => None,
    })
}

fn io_copy(e: &io::Error) -> io::Error {
    io::Error::new(e.kind(), e.to_string())
}

impl Writer {
    fn run(mut self, mut rx: mpsc::UnboundedReceiver<Cmd>) {
        if let Err(e) = self.close_abandoned_calls() {
            crate::log!("could not close calls left open by a crash, stopping this session's writer: {e}");
            rx.close();
            return;
        }
        while let Some(first) = rx.blocking_recv() {
            let mut batch = vec![first];
            while let Ok(c) = rx.try_recv() {
                batch.push(c);
            }
            let ts = epoch_ms();
            let mut staged: Vec<(Done, Vec<Entry>)> = Vec::new();
            let mut attaches = Vec::new();
            let mut failed = false;
            let mut stop = false;
            for cmd in batch {
                let (events, done) = match self.stage(cmd) {
                    Staged::Events(events, done) => {
                        self.track_turns(&events);
                        (events, done)
                    }
                    Staged::Attach(after_seq, person, reply) => {
                        attaches.push((after_seq, person, reply));
                        continue;
                    }
                    Staged::Handled => continue,
                    Staged::Stop => {
                        stop = true;
                        continue;
                    }
                };
                match self.journal.append(ts, &events) {
                    Ok(es) => staged.push((done, es)),
                    Err(e) => {
                        done(Err(e), 0);
                        failed = true;
                    }
                }
            }
            if (failed || !staged.is_empty()) && !self.commit(staged, failed, &mut rx) {
                return;
            }
            if !attaches.is_empty() && !self.attach(attaches, &mut rx) {
                return;
            }
            if stop {
                rx.close();
                return;
            }
        }
    }

    fn open_turn(&self) -> Option<u64> {
        self.open_turn
    }

    fn track_turns(&mut self, events: &[Event]) {
        for e in events {
            match e {
                Event::TurnStarted { turn, .. } => (self.last_turn, self.open_turn) = (*turn, Some(*turn)),
                Event::TurnEnded { turn, .. } if self.open_turn == Some(*turn) => self.open_turn = None,
                _ => {}
            }
        }
    }

    /// Whether a host's record fits the journal: turns start one at a time
    /// and in order, take only prompts already journaled, and end the open
    /// turn. A later host resumes from these, so one that lies would lose or
    /// repeat prompts.
    fn fits(&self, event: &Event) -> std::result::Result<(), String> {
        match event {
            Event::TurnStarted { turn, through_seq } => {
                if let Some(open) = self.open_turn {
                    return Err(format!("turn {open} is still open; end it before starting another"));
                }
                if *turn != self.last_turn + 1 {
                    return Err(format!("the next turn is {}, not {turn}", self.last_turn + 1));
                }
                if through_seq.is_some_and(|s| s >= self.journal.next_seq()) {
                    return Err("a turn can't take prompts past the end of the journal".into());
                }
                Ok(())
            }
            Event::TurnEnded { turn, .. } | Event::ChecksReported { turn, .. } if self.open_turn != Some(*turn) => {
                Err(format!("turn {turn} isn't the open turn"))
            }
            _ => Ok(()),
        }
    }

    /// Applies one command to the writer's state and returns what to append.
    #[expect(clippy::too_many_lines, reason = "one short arm per command")]
    fn stage(&mut self, cmd: Cmd) -> Staged {
        let (events, done): (Vec<Event>, Done) = match cmd {
            Cmd::Append { events, reply } => (events, Box::new(move |r, _| drop(reply.send(r)))),
            Cmd::Push { push } => {
                self.subscribers.retain(|(s, _)| s.send(push.clone()).is_ok());
                return Staged::Handled;
            }
            Cmd::SetMode { mode, reply } => {
                self.mode = mode;
                (vec![Event::ApprovalModeSet { mode }], Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::GetMode { reply } => {
                let _ = reply.send((self.mode, self.allowed_files.iter().map(PathBuf::from).collect()));
                return Staged::Handled;
            }
            Cmd::SetModel { model, reply } => {
                if self.prompted {
                    let why = "this session already has a prompt, so its agent may be running on its model; \
                               start a new session to use another";
                    let _ = reply.send(Err(why.into()));
                    return Staged::Handled;
                }
                self.model = Some(model.clone());
                (vec![Event::ModelSet { model }], Box::new(move |r, _| drop(reply.send(Ok(r)))))
            }
            Cmd::GetModel { reply } => {
                let _ = reply.send(self.model.clone());
                return Staged::Handled;
            }
            Cmd::EndOpenTurn { turn, reason, reply } => {
                if self.open_turn() != Some(turn) {
                    let _ = reply.send(Ok(false));
                    return Staged::Handled;
                }
                (
                    vec![Event::TurnEnded { turn, reason }],
                    Box::new(move |r: io::Result<Vec<Entry>>, _| drop(reply.send(r.map(|_| true)))),
                )
            }
            Cmd::Propose { made, gates, reply } => {
                // The proposal's id is the seq it's about to get.
                let proposal = self.journal.next_seq();
                let mut events = vec![made];
                events.extend(gates.into_iter().map(|(gate, verdict, detail)| Event::GateFinished {
                    proposal,
                    gate,
                    verdict,
                    detail,
                }));
                (events, Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::HostRecord { event, reply } => {
                if let Err(why) = self.fits(&event) {
                    let _ = reply.send(Err(why));
                    return Staged::Handled;
                }
                (vec![event], Box::new(move |r, _| drop(reply.send(Ok(r)))))
            }
            Cmd::People { reply } => {
                let _ = reply.send(self.subscribers.iter().filter(|(s, person)| *person && !s.is_closed()).count());
                return Staged::Handled;
            }
            Cmd::Stop => return Staged::Stop,
            Cmd::Ask { request, reply } => {
                let done: Done = Box::new(move |r: io::Result<Vec<Entry>>, delivered| {
                    let _ = reply.send(r.map(|_| delivered));
                });
                (vec![request], done)
            }
            Cmd::Decide { effect, decision, by, reply } => {
                let mut events = vec![Event::ApprovalDecided { effect, decision, by }];
                if decision == Decision::AllowSession {
                    // The request, journaled before anyone could answer it,
                    // says what the session-wide allowance covers.
                    if let Some(file) = session_file(self.entries.iter().map(|e| &e.event), effect) {
                        self.allowed_files.insert(file);
                    } else {
                        self.mode = ApprovalMode::FullAuto;
                        events.push(Event::ApprovalModeSet { mode: ApprovalMode::FullAuto });
                    }
                }
                (events, Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::SetBudget { limits, reply } => {
                self.ledger.set_limits(limits);
                let e = Event::BudgetSet { usd_micros: limits.usd_micros, tokens: limits.tokens };
                (vec![e], Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::StartCall { start, reply } => return self.start_call(start, reply),
            Cmd::FinishCall { call, outcome, response, duration_ms, reply } => {
                // Already closed (say, as broken when this writer restarted):
                // finishing it again would journal and charge it twice.
                if !self.ledger.is_open(call) {
                    let _ = reply.send(Ok(Vec::new()));
                    return Staged::Handled;
                }
                let (usd, tokens) = charge(&outcome);
                self.ledger.settle(call, usd, tokens);
                let e = Event::ModelCallFinished { call, outcome, response, duration_ms };
                (vec![e], Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::Prompt { text, command, commit, reply } => {
                let mut events = Vec::new();
                if let Some(commit) = commit {
                    self.checkpoints.push(commit.clone());
                    events.push(Event::Checkpointed { checkpoint: self.checkpoints.len() as u64, commit });
                }
                events.push(Event::UserMessage { text, command });
                self.prompted = true;
                (events, Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::CheckpointCommit { checkpoint, reply } => {
                let commit = usize::try_from(checkpoint)
                    .ok()
                    .and_then(|n| n.checked_sub(1))
                    .and_then(|i| self.checkpoints.get(i));
                let _ = reply.send(commit.cloned());
                return Staged::Handled;
            }
            Cmd::Checkpoint { commit, reply } => {
                self.checkpoints.push(commit.clone());
                let checkpoint = self.checkpoints.len() as u64;
                let events = vec![Event::Checkpointed { checkpoint, commit }];
                (events, Box::new(move |r: io::Result<Vec<Entry>>, _| drop(reply.send(r.map(|_| checkpoint)))))
            }
            Cmd::Rewound { to, saved_as, reply } => {
                (vec![Event::Rewound { to, saved_as }], Box::new(move |r, _| drop(reply.send(r))))
            }
            Cmd::CheckBudget { reservation, reply } => {
                let _ = reply.send(self.ledger.check(reservation));
                return Staged::Handled;
            }
            Cmd::StartEffect { call_id, record, reply } => {
                let effect = self.next_effect;
                self.next_effect += 1;
                self.open_effects.insert(effect);
                let done: Done = Box::new(move |r: io::Result<Vec<Entry>>, _| {
                    let _ = reply.send(r.map(|_| effect));
                });
                (vec![Event::EffectStarted { effect, call_id, record }], done)
            }
            Cmd::FinishEffect { effect, outcome, duration_ms, reply } => {
                if !self.open_effects.remove(&effect) {
                    let _ = reply.send(Ok(Vec::new()));
                    return Staged::Handled;
                }
                (
                    vec![Event::EffectFinished { effect, outcome, duration_ms }],
                    Box::new(move |r, _| drop(reply.send(r))),
                )
            }
            Cmd::Attach { after_seq, person, reply } => return Staged::Attach(after_seq, person, reply),
        };
        Staged::Events(events, done)
    }

    /// Reserves a model call against the budget and stages its start.
    fn start_call(&mut self, start: CallStart, reply: oneshot::Sender<std::result::Result<u64, CallError>>) -> Staged {
        let call = self.next_call;
        if let Err(refusal) = self.ledger.reserve(call, start.reservation) {
            let _ = reply.send(Err(CallError::Refused(refusal)));
            return Staged::Handled;
        }
        self.next_call += 1;
        let e = Event::ModelCallStarted {
            call,
            provider: start.provider,
            model: start.model,
            request: start.request,
            reserved_usd_micros: start.reservation.usd_micros,
            reserved_tokens: start.reservation.tokens,
        };
        let done: Done = Box::new(move |r: io::Result<Vec<Entry>>, _| {
            let _ = reply.send(r.map(|_| call).map_err(|e| CallError::Session(SessionError::Io(e))));
        });
        Staged::Events(vec![e], done)
    }

    /// Commits the batch and completes its commands. Returns false, having
    /// closed the queue, if the writer must stop: after any failed write the
    /// file's tail is unknown, and the next request reopens (verifying and
    /// repairing) the journal.
    fn commit(&mut self, staged: Vec<(Done, Vec<Entry>)>, failed: bool, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> bool {
        let commit = if failed {
            Err(io::Error::other("an earlier append in this batch failed"))
        } else {
            self.journal.commit()
        };
        if let Err(e) = commit {
            crate::log!("journal write failed, stopping this session's writer: {e}");
            rx.close();
            for (done, _) in staged {
                done(Err(io_copy(&e)), 0);
            }
            return false;
        }
        for (done, es) in staged {
            for e in &es {
                self.subscribers.retain(|(s, _)| s.send(Push::Entry(e.clone())).is_ok());
            }
            let delivered = self.subscribers.iter().filter(|(_, person)| *person).count();
            self.entries.extend(es.iter().cloned());
            done(Ok(es), delivered);
        }
        true
    }

    /// Resuming re-checks the file: it may have been edited while this
    /// writer held the session. A refused journal takes no more commands;
    /// closing first makes later callers reopen it (and be refused) instead
    /// of queueing behind this writer.
    fn attach(&mut self, attaches: Vec<(u64, bool, AttachReply)>, rx: &mut mpsc::UnboundedReceiver<Cmd>) -> bool {
        let problem = match (self.verify)() {
            Ok(r) => r.problem,
            Err(e) => {
                for (_, _, reply) in attaches {
                    let _ = reply.send(Err(SessionError::Io(io_copy(&e))));
                }
                return true;
            }
        };
        if let Some(p) = problem {
            rx.close();
            for (_, _, reply) in attaches {
                let _ = reply.send(Err(SessionError::Invalid(p.clone())));
            }
            return false;
        }
        for (after_seq, person, reply) in attaches {
            let (stx, srx) = mpsc::unbounded_channel();
            self.subscribers.push((stx, person));
            let history = self.entries.iter().filter(|e| e.seq > after_seq).cloned().collect();
            let _ = reply.send(Ok((history, srx)));
        }
        true
    }

    /// Calls that started but never finished were cut off by a crash. Close
    /// each explicitly, charged its full reservation, then rebuild the
    /// ledger from the journal so it matches exactly.
    fn close_abandoned_calls(&mut self) -> io::Result<()> {
        let events: Vec<Event> = self.entries.iter().map(|e| e.event.clone()).collect();
        let open = open_calls(&events);
        let mut effects_open = std::collections::BTreeSet::new();
        for e in &events {
            match e {
                Event::EffectStarted { effect, .. } => {
                    effects_open.insert(*effect);
                }
                Event::EffectFinished { effect, .. } => {
                    effects_open.remove(effect);
                }
                _ => {}
            }
        }
        if open.is_empty() && effects_open.is_empty() {
            return Ok(());
        }
        let interrupted = effects_open.into_iter().map(|effect| Event::EffectFinished {
            effect,
            outcome: EffectOutcome::Interrupted,
            duration_ms: 0,
        });
        let closing: Vec<Event> = open
            .into_iter()
            .map(|(call, r)| Event::ModelCallFinished {
                call,
                outcome: CallOutcome::Broken {
                    reason: "the daemon stopped during this call".into(),
                    cost_usd_micros: r.usd_micros,
                    tokens: r.tokens,
                },
                response: None,
                duration_ms: 0,
            })
            .chain(interrupted)
            .collect();
        let appended = self.journal.append(epoch_ms(), &closing)?;
        self.journal.commit()?;
        self.entries.extend(appended);
        let events: Vec<Event> = self.entries.iter().map(|e| e.event.clone()).collect();
        self.ledger = Ledger::replay(&events);
        Ok(())
    }
}

/// How far into a journal a list looks for its first prompt.
const PEEK_LINES: usize = 40;

/// The longest title a list shows.
const TITLE_CHARS: usize = 80;

/// Session info from the journal's first lines, without verifying them: the
/// start, and the first prompt as its title.
fn peek_info(id: &SessionId, dir: &Path) -> Option<SessionInfo> {
    let path = dir.join("journal.jsonl");
    let f = fs::File::open(&path).ok()?;
    let last_active_ms = f
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| u64::try_from(d.as_millis()).ok());
    let mut lines = io::BufReader::new(f).lines();
    let first: Entry = serde_json::from_str(lines.next()?.ok()?.trim_end()).ok()?;
    let Event::SessionStarted { cwd, kind, .. } = first.event else { return None };
    let title = lines.take(PEEK_LINES).map_while(std::result::Result::ok).find_map(
        |line| match serde_json::from_str::<Entry>(line.trim_end()).ok()?.event {
            Event::UserMessage { text, command: None } => Some(shorten(&text)),
            Event::UserMessage { command: Some(c), .. } => {
                Some(shorten(format!("/{} {}", c.name, c.arguments).trim_end()))
            }
            _ => None,
        },
    );
    Some(SessionInfo { id: id.as_str().to_string(), cwd, created_at_ms: first.ts_ms, title, last_active_ms, kind })
}

/// One line of at most `TITLE_CHARS`, cut at a word where it can be.
fn shorten(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= TITLE_CHARS {
        return line;
    }
    let cut: String = line.chars().take(TITLE_CHARS).collect();
    let at = cut.rfind(' ').filter(|&i| i > TITLE_CHARS / 2).unwrap_or(cut.len());
    format!("{}…", &cut[..at])
}

/// Loads the journal key, creating it on first start. The key is written to
/// a temp file, synced, then hard-linked into place, which fails rather than
/// replace an existing key; so a crash leaves either no key or a whole one.
fn load_or_create_key(dir: &Path) -> io::Result<Key> {
    let path = dir.join("journal.key");
    if !path.exists() {
        fs::create_dir_all(dir)?;
        let mut bytes = [0u8; 32];
        fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
        let tmp = dir.join(format!(".journal.key.{}", std::process::id()));
        let _ = fs::remove_file(&tmp);
        let mut f = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        // Only the daemon holding the ownership lock gets here, so nothing
        // else can create the key between the check and the link.
        let linked = fs::hard_link(&tmp, &path);
        fs::remove_file(&tmp)?;
        linked?;
        fs::File::open(dir)?.sync_all()?;
    }
    let bytes: [u8; 32] = fs::read(&path)?
        .try_into()
        .map_err(|_| io::Error::other(format!("{} is not a 32-byte key", path.display())))?;
    Ok(Key::from_bytes(bytes))
}
