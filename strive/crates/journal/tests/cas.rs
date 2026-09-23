#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]
use std::fs;
use std::io::ErrorKind;

use strive_journal::cas::{Cas, Digest};

/// The well-known SHA-256 of "hello".
const HELLO: &str = "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

fn files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() { stack.push(p) } else { out.push(p) }
        }
    }
    out
}

#[test]
fn content_is_addressed_by_its_sha256() {
    let dir = tempfile::tempdir().unwrap();
    let cas = Cas::open(dir.path()).unwrap();
    let d = cas.put(b"hello").unwrap();
    assert_eq!(d.to_string(), HELLO);
    assert_eq!(cas.get(&d).unwrap(), b"hello");
}

#[test]
fn blobs_live_at_a_stable_path() {
    let dir = tempfile::tempdir().unwrap();
    Cas::open(dir.path()).unwrap().put(b"hello").unwrap();
    assert_eq!(
        files(dir.path()),
        vec![dir.path().join("sha256/2c/f24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824")]
    );
}

#[test]
fn storing_the_same_bytes_twice_keeps_one_copy() {
    let dir = tempfile::tempdir().unwrap();
    let cas = Cas::open(dir.path()).unwrap();
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let cas = Cas::open(dir.path()).unwrap();
            std::thread::spawn(move || cas.put(b"same bytes").unwrap().to_string())
        })
        .collect();
    let digests: std::collections::BTreeSet<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(digests.len(), 1);
    assert_eq!(cas.put(b"same bytes").unwrap().to_string(), *digests.first().unwrap());
    assert_eq!(files(dir.path()).len(), 1, "no leftover temp files");
}

#[test]
fn a_corrupted_blob_is_refused_not_returned() {
    let dir = tempfile::tempdir().unwrap();
    let cas = Cas::open(dir.path()).unwrap();
    let d = cas.put(b"hello").unwrap();
    fs::write(&files(dir.path())[0], b"jello").unwrap();
    let err = cas.get(&d).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
    assert_eq!(err.to_string(), format!("blob {HELLO} does not match its digest"));
}

#[test]
fn a_missing_blob_is_not_found() {
    let dir = tempfile::tempdir().unwrap();
    let cas = Cas::open(dir.path()).unwrap();
    let d = Digest::parse(HELLO).unwrap();
    assert_eq!(cas.get(&d).unwrap_err().kind(), ErrorKind::NotFound);
}
