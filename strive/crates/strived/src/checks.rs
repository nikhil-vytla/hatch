//! Which checks a person accepted (ADR-0023). A check runs without asking
//! only in a form a person accepted: the content of an applied check
//! proposal, or content a person allowed for the session when asked. The
//! sandbox keeps commands from writing `.strive/checks`, but on Linux only
//! where it already exists, so a check's file alone doesn't show a person
//! wrote it.

use std::path::PathBuf;

use strive_proto::{Change, Digest};

use crate::server::State;

/// A check proposal for `name` that is applied now, with this content.
pub fn proposed(state: &State, cwd: &str, name: &str, digest: &Digest) -> bool {
    let Ok(Some(sid)) = crate::learning::find(state, cwd) else { return false };
    let Ok(entries) = crate::learning::journal(state, &sid) else { return false };
    strive_learning::fold(&entries).iter().any(|f| {
        matches!(&f.state.proposal.change, Change::Check { name: n, .. } if n == name)
            && f.applied.as_ref().is_some_and(|a| a.after == *digest)
    })
}

/// What allowing the check `name`, with this content, for the session
/// grants: an entry in the session's allowances (journaled with the
/// request, so it outlives a restart) that no file's path can be.
pub fn allowance(name: &str, digest: &Digest) -> PathBuf {
    PathBuf::from(format!("check:{name}:{digest}"))
}
