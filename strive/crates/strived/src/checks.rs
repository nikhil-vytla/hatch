//! Which checks a person accepted (ADR-0023). A check runs without asking
//! only in a form a person accepted: the content of an applied check
//! proposal, or content a person allowed when asked. The sandbox keeps
//! commands from writing `.strive/checks`, but on Linux only where it
//! already exists, so a check's file alone doesn't show a person wrote it.

use std::fs;
use std::io::{self, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

use serde::{Deserialize, Serialize};
use strive_proto::{Change, Digest};

use crate::server::State;

/// Where allowed checks are remembered, in strive's home, which no effect
/// can write.
const ALLOWED: &str = "allowed-checks.jsonl";

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Allowed {
    cwd: String,
    name: String,
    digest: Digest,
}

/// Whether the check `name`, with this content, is one a person accepted in
/// the project at `cwd`.
pub fn accepted(state: &State, cwd: &str, name: &str, digest: &Digest) -> bool {
    proposed(state, cwd, name, digest) || allowed(&state.home.root, cwd, name, digest)
}

/// A check proposal for `name` that is applied now, with this content.
fn proposed(state: &State, cwd: &str, name: &str, digest: &Digest) -> bool {
    let Ok(Some(sid)) = crate::learning::find(state, cwd) else { return false };
    let Ok(entries) = crate::learning::journal(state, &sid) else { return false };
    strive_learning::fold(&entries).iter().any(|f| {
        matches!(&f.state.proposal.change, Change::Check { name: n, .. } if n == name)
            && f.applied.as_ref().is_some_and(|a| a.after == *digest)
    })
}

fn allowed(home: &Path, cwd: &str, name: &str, digest: &Digest) -> bool {
    let Ok(text) = fs::read_to_string(home.join(ALLOWED)) else { return false };
    text.lines()
        .filter_map(|l| serde_json::from_str::<Allowed>(l).ok())
        .any(|a| a.cwd == cwd && a.name == name && a.digest == *digest)
}

/// Remembers that a person allowed the check `name` with this content.
pub fn allow(home: &Path, cwd: &str, name: &str, digest: Digest) -> io::Result<()> {
    let line = serde_json::to_string(&Allowed { cwd: cwd.into(), name: name.into(), digest })?;
    let mut f = fs::OpenOptions::new().create(true).append(true).mode(0o600).open(home.join(ALLOWED))?;
    // One write of one line: concurrent appends don't interleave.
    f.write_all(format!("{line}\n").as_bytes())
}
