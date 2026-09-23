#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, reason = "a test fails by panicking")]
use std::fs;
use std::io::Write;
use std::path::Path;

use strive_journal::{Journal, Key, OpenError, Problem, read};
use strive_proto::{Entry, Event};

const SESSION: &str = "01J8ZSESSIONAAAAAAAAAAAAAA";

fn key() -> Key {
    Key::from_bytes([7; 32])
}

fn started() -> Event {
    Event::SessionStarted { format: 1, cwd: "/r".into(), strive_version: "0.3.0".into() }
}

fn msg(text: &str) -> Event {
    Event::UserMessage { text: text.into() }
}

fn entry(seq: u64, ts_ms: u64, event: Event) -> Entry {
    Entry { seq, ts_ms, event }
}

/// A session with entries 1 (started), 2 ("a") and 3 ("b"), committed.
fn three(dir: &Path) {
    let mut j = Journal::create(dir, SESSION, &key(), 1000, &[started()]).unwrap();
    j.append(2000, &[msg("a"), msg("b")]).unwrap();
    j.commit().unwrap();
}

fn lines(dir: &Path) -> Vec<String> {
    fs::read_to_string(dir.join("journal.jsonl")).unwrap().lines().map(String::from).collect()
}

fn write_lines(dir: &Path, lines: &[String]) {
    fs::write(dir.join("journal.jsonl"), lines.iter().map(|l| l.clone() + "\n").collect::<String>()).unwrap();
}

#[test]
fn entries_round_trip_through_disk() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!(report.problem, None);
    assert_eq!(report.committed, 3);
    assert_eq!(report.torn_bytes, 0);
    assert_eq!(report.entries, vec![entry(1, 1000, started()), entry(2, 2000, msg("a")), entry(3, 2000, msg("b"))]);
}

/// The on-disk format is a contract: journals written by one release must
/// verify in the next. The MAC here was computed independently with openssl.
#[test]
fn first_line_matches_the_golden_format() {
    let dir = tempfile::tempdir().unwrap();
    Journal::create(dir.path(), SESSION, &key(), 1000, &[started()]).unwrap();
    assert_eq!(
        lines(dir.path())[0],
        concat!(
            r#"{"seq":1,"tsMs":1000,"event":{"type":"sessionStarted","format":1,"cwd":"/r","striveVersion":"0.3.0"},"#,
            r#""mac":"0482c975fb05650d3829e0213ae2a45260c96f527bb762d042e75d576522604d"}"#
        )
    );
}

#[test]
fn an_edited_entry_is_reported_by_seq() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let mut l = lines(dir.path());
    l[1] = l[1].replace(r#""text":"a""#, r#""text":"x""#);
    write_lines(dir.path(), &l);
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::Tampered { seq: 2 }));
}

#[test]
fn a_deleted_entry_is_reported_where_the_chain_breaks() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let l = lines(dir.path());
    write_lines(dir.path(), &[l[0].clone(), l[2].clone()]);
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::Tampered { seq: 2 }));
}

#[test]
fn a_journal_moved_to_another_session_does_not_verify() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let report = read(dir.path(), "01J8ZOTHERSESSIONBBBBBBBBB", &key()).unwrap();
    assert_eq!(report.problem, Some(Problem::Tampered { seq: 1 }));
}

#[test]
fn the_wrong_key_fails_at_the_first_entry() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let report = read(dir.path(), SESSION, &Key::from_bytes([8; 32])).unwrap();
    assert_eq!(report.problem, Some(Problem::Tampered { seq: 1 }));
}

#[test]
fn removing_committed_entries_from_the_end_is_truncation() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let l = lines(dir.path());
    write_lines(dir.path(), &l[..2]);
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::Truncated { committed: 3, found: 2 }));
}

#[test]
fn an_edited_head_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let head = fs::read_to_string(dir.path().join("head.json")).unwrap();
    fs::write(dir.path().join("head.json"), head.replacen(r#""seq":3"#, r#""seq":2"#, 1)).unwrap();
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::BadHead));
}

#[test]
fn a_missing_head_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    fs::remove_file(dir.path().join("head.json")).unwrap();
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::BadHead));
}

/// A crash mid-write leaves a partial last line. Reading reports it without
/// calling the journal invalid.
#[test]
fn a_torn_last_line_is_reported_not_rejected() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let mut f = fs::OpenOptions::new().append(true).open(dir.path().join("journal.jsonl")).unwrap();
    f.write_all(br#"{"seq":4,"tsMs":30"#).unwrap();
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!(report.problem, None);
    assert_eq!(report.torn_bytes, 18);
    assert_eq!(report.entries.len(), 3);
}

/// Opening discards the torn line, records that it did, and doing it again
/// changes nothing.
#[test]
fn opening_recovers_a_torn_line_once() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let mut f = fs::OpenOptions::new().append(true).open(dir.path().join("journal.jsonl")).unwrap();
    f.write_all(br#"{"seq":4,"tsMs":30"#).unwrap();

    let (_, entries) = Journal::open(dir.path(), SESSION, &key(), 5000).unwrap();
    assert_eq!(entries.last(), Some(&entry(4, 5000, Event::Recovered { discarded_bytes: 18 })));
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed, report.torn_bytes), (None, 4, 0), "recovery is committed");

    let (_, entries) = Journal::open(dir.path(), SESSION, &key(), 6000).unwrap();
    assert_eq!(entries.len(), 4);
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed, report.torn_bytes), (None, 4, 0));
}

/// A crash after the journal was synced but before the head was updated
/// leaves genuine entries past the head. They are kept and the head catches up.
#[test]
fn entries_written_after_the_last_head_update_are_adopted() {
    let dir = tempfile::tempdir().unwrap();
    let mut j = Journal::create(dir.path(), SESSION, &key(), 1000, &[started()]).unwrap();
    let old_head = fs::read(dir.path().join("head.json")).unwrap();
    j.append(2000, &[msg("a")]).unwrap();
    j.commit().unwrap();
    drop(j);
    fs::write(dir.path().join("head.json"), old_head).unwrap();

    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed, report.entries.len()), (None, 1, 2));

    Journal::open(dir.path(), SESSION, &key(), 3000).unwrap();
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed), (None, 2));
}

#[test]
fn appends_after_reopening_continue_the_sequence() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let (mut j, _) = Journal::open(dir.path(), SESSION, &key(), 4000).unwrap();
    let appended = j.append(4000, &[msg("c")]).unwrap();
    j.commit().unwrap();
    assert_eq!(appended, vec![entry(4, 4000, msg("c"))]);
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed, report.entries.len()), (None, 4, 4));
}

#[test]
fn opening_a_tampered_journal_fails_with_the_problem() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let mut l = lines(dir.path());
    l[2] = l[2].replace(r#""text":"b""#, r#""text":"y""#);
    write_lines(dir.path(), &l);
    match Journal::open(dir.path(), SESSION, &key(), 5000) {
        Err(OpenError::Invalid(p)) => assert_eq!(p, Problem::Tampered { seq: 3 }),
        other => panic!("expected an invalid journal, got {:?}", other.map(|(_, e)| e)),
    }
    assert_eq!(lines(dir.path())[2], l[2], "a tampered journal must not be modified by open");
}

/// Truncating the journal and pointing the head at the new last entry needs
/// the key: the head's own MAC covers its seq.
#[test]
fn a_forged_head_after_truncation_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    let l = lines(dir.path());
    write_lines(dir.path(), &l[..2]);
    let mac2 = &l[1][l[1].len() - 66..l[1].len() - 2];
    let head: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("head.json")).unwrap()).unwrap();
    let forged = serde_json::json!({"seq": 2, "mac": mac2, "headMac": head["headMac"]});
    fs::write(dir.path().join("head.json"), forged.to_string()).unwrap();
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::BadHead));
}

/// A genuine head from another history of the same session (same key, same
/// id) doesn't vouch for this one.
#[test]
fn a_head_from_a_different_history_is_rejected() {
    let other = tempfile::tempdir().unwrap();
    let mut j = Journal::create(other.path(), SESSION, &key(), 1000, &[started()]).unwrap();
    j.append(2000, &[msg("different")]).unwrap();
    j.commit().unwrap();

    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    fs::copy(other.path().join("head.json"), dir.path().join("head.json")).unwrap();
    assert_eq!(read(dir.path(), SESSION, &key()).unwrap().problem, Some(Problem::BadHead));
}

#[test]
fn problems_explain_themselves() {
    assert_eq!(Problem::Tampered { seq: 2 }.to_string(), "entry 2 was modified, removed or moved");
    assert_eq!(
        Problem::Truncated { committed: 3, found: 2 }.to_string(),
        "entries were removed from the end (2 of 3 committed entries remain)"
    );
    assert_eq!(Problem::BadHead.to_string(), "the head record is missing or was modified");
}

#[test]
fn opening_an_invalid_journal_says_why() {
    let dir = tempfile::tempdir().unwrap();
    three(dir.path());
    fs::remove_file(dir.path().join("head.json")).unwrap();
    let err = Journal::open(dir.path(), SESSION, &key(), 5000).err().unwrap();
    assert_eq!(err.to_string(), "the head record is missing or was modified");
}

/// A planted symlink at the head's temp path must not redirect the write.
#[test]
fn committing_does_not_follow_a_planted_temp_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let victim = dir.path().join("victim");
    fs::write(&victim, b"precious").unwrap();
    let mut j = Journal::create(&dir.path().join("s"), SESSION, &key(), 1000, &[started()]).unwrap();
    std::os::unix::fs::symlink(&victim, dir.path().join("s/head.json.tmp")).unwrap();
    j.append(2000, &[msg("a")]).unwrap();
    j.commit().unwrap();
    assert_eq!(fs::read(&victim).unwrap(), b"precious");
    assert_eq!(read(&dir.path().join("s"), SESSION, &key()).unwrap().committed, 2);
}

/// Creating a session is all or nothing: the directory appears only with a
/// committed head, and a leftover from a crashed create doesn't block a retry.
#[test]
fn create_leaves_no_half_made_session() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("s");
    let leftover = dir.path().join(".s.creating");
    fs::create_dir_all(&leftover).unwrap();
    fs::write(leftover.join("journal.jsonl"), b"{\"seq\":1}\n").unwrap();
    Journal::create(&target, SESSION, &key(), 1000, &[started()]).unwrap();
    let report = read(&target, SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed), (None, 1));
    let names: Vec<String> =
        fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(names, vec!["s".to_string()]);
}

/// After a failed write the journal's tail is unknown (a partial line may be
/// on disk), so it refuses further appends until reopened, and reopening
/// yields a valid journal.
#[test]
fn a_failed_commit_refuses_further_appends_until_reopened() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let s = dir.path().join("s");
    let mut j = Journal::create(&s, SESSION, &key(), 1000, &[started()]).unwrap();
    fs::set_permissions(&s, fs::Permissions::from_mode(0o500)).unwrap();
    j.append(2000, &[msg("a")]).unwrap();
    let failed = j.commit();
    fs::set_permissions(&s, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(failed.is_err(), "the head can't be written in a read-only directory");

    let err = j.append(3000, &[msg("b")]).unwrap_err();
    assert_eq!(err.to_string(), "an earlier write to this journal failed; reopen it to continue");
    assert!(j.commit().is_err());
    drop(j);

    let (_, entries) = Journal::open(&s, SESSION, &key(), 4000).unwrap();
    assert_eq!(entries.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![1, 2]);
    let report = read(&s, SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed), (None, 2));
}

#[test]
fn a_journal_can_start_with_several_entries_committed_together() {
    let dir = tempfile::tempdir().unwrap();
    Journal::create(dir.path(), SESSION, &key(), 1000, &[started(), msg("a"), msg("b")]).unwrap();
    let report = read(dir.path(), SESSION, &key()).unwrap();
    assert_eq!((report.problem, report.committed, report.entries.len()), (None, 3, 3));
    assert!(Journal::create(tempfile::tempdir().unwrap().path(), SESSION, &key(), 1000, &[]).is_err());
}
