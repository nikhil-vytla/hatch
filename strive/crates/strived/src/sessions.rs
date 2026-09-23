//! Live sessions: one writer thread per open journal.
//!
//! The writer owns the journal and the list of subscribers. Appends queued
//! while it was busy are committed together (one fsync), then broadcast.
//! Attaches go through the same thread, after the commit, so a new
//! subscriber's history snapshot and its live stream never overlap or gap.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;

use strive_journal::{Journal, Key, OpenError, Problem, Report};
use strive_proto::{Entry, Event, SessionInfo};
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

enum Cmd {
    Append { events: Vec<Event>, reply: oneshot::Sender<io::Result<Vec<Entry>>> },
    Attach { after_seq: u64, reply: oneshot::Sender<Result<(Vec<Entry>, mpsc::UnboundedReceiver<Entry>)>> },
}

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
        })
    }

    fn dir(&self, id: &SessionId) -> PathBuf {
        self.root.join(id.as_str())
    }

    pub async fn create(&self, cwd: String) -> Result<SessionInfo> {
        let id = {
            let mut g = self.ids.lock().expect("id generator lock");
            SessionId(g.generate().map_err(|e| io::Error::other(e.to_string()))?.to_string())
        };
        let ts = epoch_ms();
        let first = Event::SessionStarted {
            format: FORMAT,
            cwd: cwd.clone(),
            strive_version: env!("CARGO_PKG_VERSION").into(),
        };
        let entries = vec![Entry { seq: 1, ts_ms: ts, event: first.clone() }];
        let (dir, key, sid) = (self.dir(&id), self.key.clone(), id.clone());
        // Held until the writer is registered: the session is listable as soon
        // as its directory exists, and an attach in that window must find this
        // writer rather than open a second one.
        let mut live = self.live.lock().await;
        let journal = tokio::task::spawn_blocking(move || Journal::create(&dir, sid.as_str(), &key, ts, first))
            .await
            .expect("journal create task")?;
        let info = SessionInfo { id: id.as_str().to_string(), cwd, created_at_ms: ts };
        let (tx, thread) = spawn_writer(journal, entries, self.verifier(&id));
        live.insert(id, Live { info: info.clone(), tx, thread });
        Ok(info)
    }

    /// Sessions started in `cwd` (or all of them), newest first, and the ids
    /// of sessions whose first entry can't be read. Reads only each
    /// journal's first line; verification happens on attach and read.
    pub fn list(&self, cwd: Option<&str>) -> io::Result<(Vec<SessionInfo>, Vec<String>)> {
        let mut sessions = Vec::new();
        let mut unreadable = Vec::new();
        for dir in fs::read_dir(&self.root)? {
            let dir = dir?;
            let Some(id) = dir.file_name().to_str().and_then(SessionId::parse) else { continue };
            match peek_info(&id, &dir.path()) {
                Some(info) if cwd.is_none_or(|c| c == info.cwd) => sessions.push(info),
                None if cwd.is_none() => unreadable.push(id.0),
                _ => {}
            }
        }
        sessions.sort_by(|a, b| b.id.cmp(&a.id));
        unreadable.sort_by(|a, b| b.cmp(a));
        Ok((sessions, unreadable))
    }

    /// The session's history after `after_seq`, and a stream of later entries.
    pub async fn attach(
        &self,
        id: &SessionId,
        after_seq: u64,
    ) -> Result<(SessionInfo, Vec<Entry>, mpsc::UnboundedReceiver<Entry>)> {
        let (info, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Attach { after_seq, reply }).map_err(|_| writer_gone())?;
        let (entries, stream) = rx.await.map_err(|_| writer_gone())??;
        Ok((info, entries, stream))
    }

    pub async fn append(&self, id: &SessionId, events: Vec<Event>) -> Result<Vec<Entry>> {
        let (_, tx) = self.writer(id).await?;
        let (reply, rx) = oneshot::channel();
        tx.send(Cmd::Append { events, reply }).map_err(|_| writer_gone())?;
        Ok(rx.await.map_err(|_| writer_gone())??)
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
        if let Some(l) = live.get(id).filter(|l| !l.tx.is_closed()) {
            return Ok((l.info.clone(), l.tx.clone()));
        }
        let dir = self.dir(id);
        let info = peek_info(id, &dir).ok_or(SessionError::NotFound)?;
        let (key, sid) = (self.key.clone(), id.clone());
        let (journal, entries) =
            tokio::task::spawn_blocking(move || Journal::open(&dir, sid.as_str(), &key, epoch_ms()))
                .await
                .expect("journal open task")?;
        let (tx, thread) = spawn_writer(journal, entries, self.verifier(id));
        live.insert(id.clone(), Live { info: info.clone(), tx: tx.clone(), thread });
        Ok((info, tx))
    }

    /// Stops every writer after it finishes what is queued. The daemon calls
    /// this before releasing its ownership lock, so a successor never opens a
    /// journal an old writer is still writing.
    pub async fn shutdown(&self) {
        let live: Vec<Live> = self.live.lock().await.drain().map(|(_, l)| l).collect();
        for l in live {
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
    SessionError::Io(io::Error::other("the session writer stopped after a failed commit"))
}

type Verifier = Box<dyn Fn() -> io::Result<Report> + Send>;

fn spawn_writer(
    mut journal: Journal,
    mut entries: Vec<Entry>,
    verify: Verifier,
) -> (mpsc::UnboundedSender<Cmd>, std::thread::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
    let thread = std::thread::spawn(move || {
        let mut subscribers: Vec<mpsc::UnboundedSender<Entry>> = Vec::new();
        while let Some(first) = rx.blocking_recv() {
            let mut batch = vec![first];
            while let Ok(c) = rx.try_recv() {
                batch.push(c);
            }
            let ts = epoch_ms();
            let mut appended = Vec::new();
            let mut attaches = Vec::new();
            let mut failed = false;
            for cmd in batch {
                match cmd {
                    Cmd::Append { events, reply } => match journal.append(ts, &events) {
                        Ok(es) => appended.push((reply, es)),
                        Err(e) => {
                            let _ = reply.send(Err(e));
                            failed = true;
                        }
                    },
                    Cmd::Attach { after_seq, reply } => attaches.push((after_seq, reply)),
                }
            }
            if failed || !appended.is_empty() {
                // After any failed write the file's tail is unknown. Stop, so
                // the next request reopens (verifying and repairing) the journal.
                let commit = if failed {
                    Err(io::Error::other("an earlier append in this batch failed"))
                } else {
                    journal.commit()
                };
                if let Err(e) = commit {
                    crate::log!("journal write failed, stopping this session's writer: {e}");
                    rx.close();
                    for (reply, _) in appended {
                        let _ = reply.send(Err(io::Error::new(e.kind(), e.to_string())));
                    }
                    return;
                }
                for (reply, es) in appended {
                    for e in &es {
                        subscribers.retain(|s| s.send(e.clone()).is_ok());
                    }
                    entries.extend(es.iter().cloned());
                    let _ = reply.send(Ok(es));
                }
            }
            if attaches.is_empty() {
                continue;
            }
            // Resuming re-checks the file: it may have been edited while this
            // writer held the session. A refused journal takes no more
            // commands; closing first makes later callers reopen it (and be
            // refused) instead of queueing behind this writer.
            let problem = match verify() {
                Ok(r) => r.problem,
                Err(e) => {
                    for (_, reply) in attaches {
                        let _ = reply.send(Err(SessionError::Io(io::Error::new(e.kind(), e.to_string()))));
                    }
                    continue;
                }
            };
            if let Some(p) = problem {
                rx.close();
                for (_, reply) in attaches {
                    let _ = reply.send(Err(SessionError::Invalid(p.clone())));
                }
                return;
            }
            for (after_seq, reply) in attaches {
                let (stx, srx) = mpsc::unbounded_channel();
                subscribers.push(stx);
                let history = entries.iter().filter(|e| e.seq > after_seq).cloned().collect();
                let _ = reply.send(Ok((history, srx)));
            }
        }
    });
    (tx, thread)
}

/// Session info from the journal's first line, without verifying it.
fn peek_info(id: &SessionId, dir: &Path) -> Option<SessionInfo> {
    let f = fs::File::open(dir.join("journal.jsonl")).ok()?;
    let mut line = String::new();
    io::BufReader::new(f).read_line(&mut line).ok()?;
    let entry: Entry = serde_json::from_str(line.trim_end()).ok()?;
    match entry.event {
        Event::SessionStarted { cwd, .. } => {
            Some(SessionInfo { id: id.as_str().to_string(), cwd, created_at_ms: entry.ts_ms })
        }
        _ => None,
    }
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
        let linked = fs::hard_link(&tmp, &path);
        fs::remove_file(&tmp)?;
        match linked {
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
            _ => fs::File::open(dir)?.sync_all()?,
        }
    }
    let bytes: [u8; 32] = fs::read(&path)?
        .try_into()
        .map_err(|_| io::Error::other(format!("{} is not a 32-byte key", path.display())))?;
    Ok(Key::from_bytes(bytes))
}
