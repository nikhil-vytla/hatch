//! Append-only, authenticated session journals, and the content store.
//!
//! A session directory holds `journal.jsonl`, one entry per line, and
//! `head.json`, the last committed entry. Each line ends with a MAC over the
//! previous entry's MAC and the line's own bytes, so an edit, deletion,
//! reordering or move to another session breaks the chain at the first
//! affected entry. The head is MAC'd too, which catches entries removed from
//! the end. The key lives with the daemon, outside the agent's sandbox.
//!
//! Durability comes from [`Journal::commit`]: it syncs the journal, then
//! replaces the head. A crash between the two leaves valid entries past the
//! head, which [`Journal::open`] adopts. A crash mid-line leaves a torn tail,
//! which `open` discards and records as an [`Event::Recovered`] entry.

pub mod cas;

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use strive_proto::{Entry, Event};

type HmacSha256 = Hmac<Sha256>;

const JOURNAL: &str = "journal.jsonl";
const HEAD: &str = "head.json";
const MAC_SUFFIX_LEN: usize = r#","mac":""}"#.len() + 64;

/// The daemon's journal key.
#[derive(Clone)]
pub struct Key([u8; 32]);

impl Key {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[expect(clippy::expect_used, reason = "HMAC accepts keys of any length, so new_from_slice cannot fail")]
    fn mac(&self, parts: &[&[u8]]) -> [u8; 32] {
        let mut m = <HmacSha256 as KeyInit>::new_from_slice(&self.0).expect("HMAC takes any key length");
        for p in parts {
            m.update(p);
        }
        m.finalize().into_bytes().into()
    }

    fn genesis(&self, session_id: &str) -> [u8; 32] {
        self.mac(&[b"strive-journal-v1:", session_id.as_bytes()])
    }

    fn head_mac(&self, seq: u64, mac: &str) -> String {
        hex::encode(self.mac(&[format!("head:{seq}:{mac}").as_bytes()]))
    }
}

/// Why a journal failed verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// The entry at `seq` (or the line where it should be) doesn't match the
    /// chain: edited, deleted, reordered, from another session or another key.
    Tampered { seq: u64 },
    /// The head records `committed` entries but only `found` are present.
    Truncated { committed: u64, found: u64 },
    /// The head file is missing, unreadable or not MAC'd by this key.
    BadHead,
}

impl std::fmt::Display for Problem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Problem::Tampered { seq } => write!(f, "entry {seq} was modified, removed or moved"),
            Problem::Truncated { committed, found } => {
                write!(f, "entries were removed from the end ({found} of {committed} committed entries remain)")
            }
            Problem::BadHead => write!(f, "the head record is missing or was modified"),
        }
    }
}

/// What reading a journal found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
    /// Every entry that verified, in order.
    pub entries: Vec<Entry>,
    /// The seq the head records as committed.
    pub committed: u64,
    /// Bytes of a partial last line left by a crash.
    pub torn_bytes: u64,
    pub problem: Option<Problem>,
}

#[derive(Debug)]
pub enum OpenError {
    Io(io::Error),
    Invalid(Problem),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Io(e) => write!(f, "{e}"),
            OpenError::Invalid(p) => write!(f, "{p}"),
        }
    }
}

impl std::error::Error for OpenError {}

impl From<io::Error> for OpenError {
    fn from(e: io::Error) -> Self {
        OpenError::Io(e)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Head {
    seq: u64,
    mac: String,
    /// MAC over `seq` and `mac`, so the head can't be pointed elsewhere.
    #[serde(rename = "headMac")]
    sig: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Body<'a> {
    seq: u64,
    ts_ms: u64,
    event: &'a Event,
}

/// An open journal with a single writer.
pub struct Journal {
    dir: PathBuf,
    key: Key,
    out: BufWriter<File>,
    next_seq: u64,
    last_mac: [u8; 32],
    /// Set by a failed write. The file's tail is then unknown (a partial line
    /// may be on disk), so nothing more is written until the journal is
    /// reopened, which verifies and repairs it.
    failed: bool,
}

impl Journal {
    /// Creates a new session journal starting with `first` (at least one
    /// event), all committed together. The
    /// directory (absent or empty beforehand) is filled only once the first
    /// entry and head are durable: it is built under a staging name and
    /// renamed into place, so a crash leaves at most a staging directory,
    /// which the next create replaces.
    pub fn create(dir: &Path, session_id: &str, key: &Key, ts_ms: u64, first: &[Event]) -> io::Result<Self> {
        if first.is_empty() {
            return Err(io::Error::other("a journal starts with at least one event"));
        }
        if fs::read_dir(dir).is_ok_and(|mut d| d.next().is_some()) {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("{} is not empty", dir.display())));
        }
        let parent = dir.parent().unwrap_or(Path::new("."));
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("session");
        let staging = parent.join(format!(".{name}.creating"));
        // A leftover from a crashed create. If it can't be removed, the
        // create_new below reports the real problem.
        let _ = fs::remove_dir_all(&staging);
        fs::create_dir_all(&staging)?;
        let file = OpenOptions::new().create_new(true).append(true).open(staging.join(JOURNAL))?;
        let mut j = Journal {
            dir: staging.clone(),
            key: key.clone(),
            out: BufWriter::new(file),
            next_seq: 1,
            last_mac: key.genesis(session_id),
            failed: false,
        };
        j.append(ts_ms, first)?;
        j.commit()?;
        fs::rename(&staging, dir)?;
        File::open(parent)?.sync_all()?;
        j.dir = dir.to_path_buf();
        Ok(j)
    }

    /// Opens an existing journal for appending. Verifies it first and refuses
    /// an invalid one without modifying it. Repairs what a crash can leave: a
    /// torn last line is truncated and recorded, and a head behind the synced
    /// entries catches up. Running it again changes nothing.
    pub fn open(dir: &Path, session_id: &str, key: &Key, ts_ms: u64) -> Result<(Self, Vec<Entry>), OpenError> {
        let scan = scan(dir, session_id, key)?;
        let report = scan.report;
        if let Some(p) = report.problem {
            return Err(OpenError::Invalid(p));
        }
        let file = OpenOptions::new().append(true).open(dir.join(JOURNAL))?;
        file.set_len(scan.valid_len)?;
        let mut j = Journal {
            dir: dir.to_path_buf(),
            key: key.clone(),
            out: BufWriter::new(file),
            next_seq: report.entries.len() as u64 + 1,
            last_mac: scan.last_mac,
            failed: false,
        };
        let mut entries = report.entries;
        if report.torn_bytes > 0 {
            entries.extend(j.append(ts_ms, &[Event::Recovered { discarded_bytes: report.torn_bytes }])?);
        }
        j.commit()?;
        Ok((j, entries))
    }

    /// The sequence number the next appended entry gets.
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    /// Buffers entries. They are durable only after [`Journal::commit`].
    pub fn append(&mut self, ts_ms: u64, events: &[Event]) -> io::Result<Vec<Entry>> {
        self.check()?;
        let r = self.write_entries(ts_ms, events);
        self.failed = r.is_err();
        r
    }

    fn write_entries(&mut self, ts_ms: u64, events: &[Event]) -> io::Result<Vec<Entry>> {
        let mut out = Vec::with_capacity(events.len());
        for event in events {
            let seq = self.next_seq;
            let body = serde_json::to_vec(&Body { seq, ts_ms, event }).map_err(io::Error::other)?;
            let mac = self.key.mac(&[&self.last_mac, &body]);
            self.out.write_all(&body[..body.len() - 1])?;
            write!(self.out, r#","mac":"{}"}}"#, hex::encode(mac))?;
            self.out.write_all(b"\n")?;
            self.last_mac = mac;
            self.next_seq += 1;
            out.push(Entry { seq, ts_ms, event: event.clone() });
        }
        Ok(out)
    }

    /// Makes every appended entry durable: syncs the journal, then atomically
    /// replaces the head.
    pub fn commit(&mut self) -> io::Result<()> {
        self.check()?;
        let r = self.write_head();
        self.failed = r.is_err();
        r
    }

    fn write_head(&mut self) -> io::Result<()> {
        self.out.flush()?;
        self.out.get_ref().sync_data()?;
        let seq = self.next_seq - 1;
        let mac = hex::encode(self.last_mac);
        let head = Head { seq, sig: self.key.head_mac(seq, &mac), mac };
        let tmp = self.dir.join("head.json.tmp");
        // create_new won't follow or reuse whatever is at the temp path, so a
        // planted symlink can't redirect this write.
        let _ = fs::remove_file(&tmp);
        let mut f = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(&serde_json::to_vec(&head).map_err(io::Error::other)?)?;
        f.sync_data()?;
        fs::rename(&tmp, self.dir.join(HEAD))?;
        File::open(&self.dir)?.sync_all()
    }

    fn check(&self) -> io::Result<()> {
        if self.failed {
            return Err(io::Error::other("an earlier write to this journal failed; reopen it to continue"));
        }
        Ok(())
    }
}

/// Verifies a journal without modifying it.
pub fn read(dir: &Path, session_id: &str, key: &Key) -> io::Result<Report> {
    Ok(scan(dir, session_id, key)?.report)
}

struct Scan {
    report: Report,
    /// Length of the journal up to the end of the last complete line.
    valid_len: u64,
    last_mac: [u8; 32],
}

fn scan(dir: &Path, session_id: &str, key: &Key) -> io::Result<Scan> {
    // Head first. A writer syncs the journal before it replaces the head, so
    // a journal read after the head holds at least the entries the head
    // names; read the other way round, a commit in between would look like
    // truncation.
    let head = read_head(dir, key);
    let bytes = fs::read(dir.join(JOURNAL))?;
    let complete = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    let mut entries = Vec::new();
    let mut prev = key.genesis(session_id);
    let mut head_matches = false;
    let mut problem = None;
    for (i, line) in bytes[..complete].split(|&b| b == b'\n').filter(|l| !l.is_empty()).enumerate() {
        let seq = i as u64 + 1;
        let Some((entry, mac)) = verify_line(key, &prev, line, seq) else {
            problem = Some(Problem::Tampered { seq });
            break;
        };
        if head.as_ref().is_some_and(|h| h.seq == seq) {
            head_matches = head.as_ref().is_some_and(|h| h.mac == hex::encode(mac));
        }
        entries.push(entry);
        prev = mac;
    }
    let found = entries.len() as u64;
    let committed = head.as_ref().map_or(0, |h| h.seq);
    problem = problem.or(match head {
        Some(h) if h.seq > found => Some(Problem::Truncated { committed: h.seq, found }),
        Some(_) if head_matches => None,
        _ => Some(Problem::BadHead),
    });
    Ok(Scan {
        report: Report { entries, committed, torn_bytes: (bytes.len() - complete) as u64, problem },
        valid_len: complete as u64,
        last_mac: prev,
    })
}

/// Returns the entry and its MAC if the line is the valid successor of `prev`.
fn verify_line(key: &Key, prev: &[u8; 32], line: &[u8], seq: u64) -> Option<(Entry, [u8; 32])> {
    let split = line.len().checked_sub(MAC_SUFFIX_LEN)?;
    let suffix = std::str::from_utf8(&line[split..]).ok()?;
    let mac_hex = suffix.strip_prefix(r#","mac":""#)?.strip_suffix(r#""}"#)?;
    let mut body = line[..split].to_vec();
    body.push(b'}');
    let mac = key.mac(&[prev, &body]);
    if hex::encode(mac) != mac_hex {
        return None;
    }
    let entry: Entry = serde_json::from_slice(&body).ok()?;
    (entry.seq == seq).then_some((entry, mac))
}

fn read_head(dir: &Path, key: &Key) -> Option<Head> {
    let h: Head = serde_json::from_slice(&fs::read(dir.join(HEAD)).ok()?).ok()?;
    (key.head_mac(h.seq, &h.mac) == h.sig).then_some(h)
}
