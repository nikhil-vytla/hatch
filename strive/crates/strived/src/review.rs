//! `strive learn` and `strive review`: asking the project's learner to study
//! its sessions, and a person's review of what it proposes.

use std::fmt::Write as _;
use std::process::ExitCode;

use anyhow::{Result, anyhow};
use strive_proto::{
    BlobGet, BlobGetParams, Event, Gate, LearnTrigger, LearningOpen, LearningRun, LearningRunParams, ProjectRef,
    ProposalDecide, ProposalDecideParams, ProposalDecision, ProposalList, ProposalRef, ProposalRollback, ProposalState,
    ProposalStatus, SessionAttach, SessionAttachParams, TriggerKind, Verdict, WatchOutcome,
};

use crate::client::Client;

fn cwd() -> Result<String> {
    Ok(std::env::current_dir()?.canonicalize()?.display().to_string())
}

/// What `strive review <id>` does to a proposal.
#[derive(Debug, Clone, Copy)]
pub enum Action {
    Accept,
    Reject,
    Rollback,
}

pub async fn learn(c: &mut Client, home: &std::path::Path, sessions: Vec<String>) -> Result<ExitCode> {
    let cwd = cwd()?;
    let learning = c.request::<LearningOpen>(ProjectRef { cwd: cwd.clone() }).await?;
    let id = learning.id;
    // An observer: nobody here decides anything the learner asks.
    let attached = c
        .request::<SessionAttach>(SessionAttachParams { id: id.clone(), after_seq: None, observer: Some(true) })
        .await?;
    let shown = attached.entries.last().map_or(0, |e| e.seq);
    let sessions = (!sessions.is_empty()).then_some(sessions);
    let asked = c.request::<LearningRun>(LearningRunParams { cwd: cwd.clone(), sessions }).await?.seq;
    eprintln!("strive: learning session {id} (strive log {id} shows it again)");
    let follow = crate::run::Follow { home, id: &id, shown, prompt: asked, json: false, who: "the learner" };
    let (code, seen) = follow.until_turn_ends(c).await?;
    let made: Vec<u64> = seen.iter().filter(|e| matches!(e.event, Event::ProposalMade { .. })).map(|e| e.seq).collect();
    if made.is_empty() {
        println!("the learner proposed nothing");
        return Ok(code);
    }
    let mut all = c.request::<ProposalList>(ProjectRef { cwd: cwd.clone() }).await?.proposals;
    let checking =
        |all: &[ProposalState]| all.iter().any(|p| made.contains(&p.id) && p.status == ProposalStatus::Checking);
    if checking(&all) {
        eprintln!("strive: waiting for the judge to check what the learner proposed");
        let deadline = std::time::Instant::now() + JUDGE_WAIT;
        while checking(&all) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            all = c.request::<ProposalList>(ProjectRef { cwd: cwd.clone() }).await?.proposals;
        }
    }
    let mine: Vec<&ProposalState> = all.iter().filter(|p| made.contains(&p.id)).collect();
    println!("{} proposal{}:", mine.len(), if mine.len() == 1 { "" } else { "s" });
    for p in &mine {
        println!("  {}", crate::terminal::visible(&line(p)));
    }
    println!("`strive review ID` shows one with its diff, and accepts or rejects it");
    Ok(code)
}

/// How long `strive learn` waits for the judge before listing proposals
/// still being checked.
const JUDGE_WAIT: std::time::Duration = std::time::Duration::from_secs(300);

/// One proposal in a list.
fn line(p: &ProposalState) -> String {
    let mut marks = Vec::new();
    if p.trigger.is_some() {
        marks.push("automatic run");
    }
    if p.automatic.is_some() {
        marks.push("accepted automatically");
    }
    let marks = if marks.is_empty() { String::new() } else { format!("  [{}]", marks.join(", ")) };
    format!(
        "#{:<5} {:<12} {:<20} {}{marks}",
        p.id,
        strive_learning::status_name(p.status),
        strive_learning::describe(&p.proposal.artifact),
        p.proposal.summary
    )
}

/// What started an automatic run, in one line: "after session X went idle:
/// a correction".
pub fn trigger_text(t: &LearnTrigger) -> String {
    let signs = strive_learning::signals::describe(&t.signals);
    match t.kind {
        TriggerKind::Idle => format!("after a session went idle: {signs}"),
        TriggerKind::Turns => format!("after a session's turns reached learning.everyTurns: {signs}"),
    }
}

pub async fn review(c: &mut Client, id: Option<u64>, action: Option<Action>) -> Result<ExitCode> {
    let cwd = cwd()?;
    let listed = c.request::<ProposalList>(ProjectRef { cwd: cwd.clone() }).await?;
    let proposals = listed.proposals;
    let Some(id) = id else {
        if proposals.is_empty() {
            println!("no proposals for {cwd}; `strive learn` asks the learner to study this project's sessions");
        }
        for p in &proposals {
            println!("{}", crate::terminal::visible(&line(p)));
        }
        for rel in &listed.changed_outside_review {
            println!("{rel} changed outside review: it isn't what an accepted proposal last left there");
        }
        for p in proposals.iter().filter(|p| suggest_rollback(p)) {
            println!("{}", rollback_line(p));
        }
        for s in &listed.may_be_stale {
            println!(
                "{} line {} may be stale: it names {}, which isn't in the project",
                s.file,
                s.line,
                crate::terminal::visible(&s.missing)
            );
        }
        if let Some(s) = &listed.skipped {
            println!(
                "an automatic learning run was skipped at {} ({}): {}",
                when(s.at_ms),
                trigger_text(&s.trigger),
                s.reason
            );
        }
        return Ok(ExitCode::SUCCESS);
    };
    let p = proposals
        .iter()
        .find(|p| p.id == id)
        .ok_or_else(|| anyhow!("there's no proposal #{id} for {cwd}; `strive review` lists them"))?;
    let rel = strive_learning::relative_path(&p.proposal.artifact).unwrap_or_else(|why| why);
    match action {
        None => {
            show(c, p, &rel).await?;
            Ok(ExitCode::SUCCESS)
        }
        Some(Action::Reject) => {
            let decision = ProposalDecision::Reject;
            c.request::<ProposalDecide>(ProposalDecideParams { cwd, proposal: id, decision }).await?;
            println!("rejected #{id}; nothing was written");
            Ok(ExitCode::SUCCESS)
        }
        Some(Action::Accept) => {
            let decision = ProposalDecision::Accept;
            c.request::<ProposalDecide>(ProposalDecideParams { cwd: cwd.clone(), proposal: id, decision }).await?;
            let now = c.request::<ProposalList>(ProjectRef { cwd }).await?.proposals;
            let status = now.iter().find(|p| p.id == id).map(|p| p.status);
            match status {
                Some(ProposalStatus::Applied) => {
                    println!("accepted #{id}: wrote {rel}; `strive review {id} rollback` undoes it");
                    Ok(ExitCode::SUCCESS)
                }
                Some(ProposalStatus::Stale) => {
                    println!(
                        "#{id} is stale: {rel} changed after the learner read it, so nothing was written. \
                         `strive learn` asks for a proposal against the file as it is now"
                    );
                    Ok(ExitCode::FAILURE)
                }
                Some(
                    s @ (ProposalStatus::Checking
                    | ProposalStatus::Ready
                    | ProposalStatus::Failed
                    | ProposalStatus::Rejected
                    | ProposalStatus::RolledBack),
                ) => Err(anyhow!(
                    "#{id} is {} after accepting it; `strive log` shows why",
                    strive_learning::status_name(s)
                )),
                None => Err(anyhow!("#{id} is gone from the list after accepting it")),
            }
        }
        Some(Action::Rollback) => {
            c.request::<ProposalRollback>(ProposalRef { cwd, proposal: id }).await?;
            match p.before {
                Some(_) => println!("rolled back #{id}: {rel} is as it was before"),
                None => println!("rolled back #{id}: removed {rel}, which didn't exist before"),
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

async fn show(c: &mut Client, p: &ProposalState, rel: &str) -> Result<()> {
    let id = p.id;
    let status = strive_learning::status_name(p.status);
    let mut out = String::new();
    writeln!(out, "#{id} {}", p.proposal.summary)?;
    writeln!(out, "status      {status}")?;
    writeln!(out, "changes     {} ({rel})", strive_learning::describe(&p.proposal.artifact))?;
    writeln!(out, "proposed    {}", when(p.made_at_ms))?;
    match &p.trigger {
        Some(t) => {
            writeln!(out, "run         automatic, {}", trigger_text(t))?;
            for s in &t.signals {
                writeln!(
                    out,
                    "              session {} entry {}: {}: {}",
                    s.session,
                    s.seq,
                    strive_learning::signals::kind_name(s.kind),
                    s.detail
                )?;
            }
        }
        None => writeln!(out, "run         asked for by a person")?,
    }
    if p.automatic.is_some() {
        writeln!(
            out,
            "decided     accepted automatically: every check passed (\"learning\": {{\"mode\": \"gated\"}})"
        )?;
    }
    writeln!(out, "\nwhy\n{}", indent(&p.proposal.rationale))?;
    writeln!(out, "\nprediction\n{}", indent(&p.proposal.prediction))?;
    match (&p.proposal.watch, &p.prediction) {
        (Some(w), Some(t)) => {
            writeln!(out, "  watch: {}", strive_learning::watch::describe(w))?;
            writeln!(out, "  so far: {}", strive_learning::watch::tally_text(t))?;
        }
        (Some(w), None) => writeln!(out, "  watch: {}", strive_learning::watch::describe(w))?,
        (None, _) => writeln!(out, "  prediction not machine-checked: it has no watch")?,
    }
    writeln!(out, "\nevidence")?;
    for e in &p.proposal.evidence {
        let seqs = if e.seqs.is_empty() {
            String::new()
        } else {
            format!(" entries {}", e.seqs.iter().map(u64::to_string).collect::<Vec<_>>().join(", "))
        };
        writeln!(out, "  session {}{seqs}: {}", e.session, e.note)?;
    }
    writeln!(out, "\nchecks")?;
    for g in &p.gates {
        let mut lines = g.detail.lines();
        let first = lines.next().unwrap_or_default();
        writeln!(out, "  {:<7} {:<8} {first}", gate_name(g.gate), verdict_name(g.verdict))?;
        for l in lines {
            writeln!(out, "{:19}{l}", "")?;
        }
    }
    let old = match p.before {
        Some(digest) => c.request::<BlobGet>(BlobGetParams { digest }).await?.text,
        None => String::new(),
    };
    let against = if p.before.is_some() { "the file as the learner saw it" } else { "no file: it's new" };
    writeln!(out, "\ndiff against {against}")?;
    for l in diff(&old, &p.proposal.content) {
        writeln!(out, "{l}")?;
    }
    let next = match p.status {
        ProposalStatus::Ready => {
            format!("`strive review {id} accept` writes {rel}; `strive review {id} reject` turns it down")
        }
        ProposalStatus::Failed => {
            format!("a failed proposal can't be accepted; `strive review {id} reject` turns it down")
        }
        ProposalStatus::Checking => "its checks haven't finished; look again in a moment".to_string(),
        ProposalStatus::Applied if suggest_rollback(p) => rollback_line(p),
        ProposalStatus::Applied => format!("`strive review {id} rollback` puts {rel} back as it was"),
        ProposalStatus::Stale => {
            format!(
                "{rel} changed after the learner read it; `strive learn` asks for a proposal against it as it is now"
            )
        }
        ProposalStatus::Rejected | ProposalStatus::RolledBack => String::new(),
    };
    if !next.is_empty() {
        writeln!(out, "\n{next}")?;
    }
    print!("{}", crate::terminal::visible(&out));
    Ok(())
}

/// An applied proposal whose prediction isn't holding: worth a person's look
/// at rolling it back. strive never does it on its own.
fn suggest_rollback(p: &ProposalState) -> bool {
    p.status == ProposalStatus::Applied && p.prediction.is_some_and(|t| t.not_holding)
}

fn rollback_line(p: &ProposalState) -> String {
    let t = p.prediction.unwrap_or_default();
    let rel = strive_learning::relative_path(&p.proposal.artifact).unwrap_or_else(|why| why);
    format!(
        "#{} may be hurting: its prediction was contradicted in {} of the last {} sessions it applied to; \
         `strive review {} rollback` puts {rel} back as it was",
        p.id,
        t.recent_contradicted,
        t.recent_confirmed + t.recent_contradicted,
        p.id
    )
}

pub fn outcome_name(o: WatchOutcome) -> &'static str {
    match o {
        WatchOutcome::Confirmed => "held",
        WatchOutcome::Contradicted => "was contradicted",
        WatchOutcome::NotApplicable => "didn't apply",
    }
}

fn indent(text: &str) -> String {
    text.trim_end().lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n")
}

fn when(ms: u64) -> String {
    i64::try_from(ms)
        .ok()
        .and_then(|ms| jiff::Timestamp::from_millisecond(ms).ok())
        .map_or_else(String::new, |t| t.to_zoned(jiff::tz::TimeZone::system()).strftime("%Y-%m-%d %H:%M").to_string())
}

pub fn gate_name(g: Gate) -> &'static str {
    match g {
        Gate::Static => "static",
        Gate::Judge => "judge",
        Gate::Replay => "replay",
    }
}

pub fn verdict_name(v: Verdict) -> &'static str {
    match v {
        Verdict::Pass => "passed",
        Verdict::Fail => "failed",
        Verdict::Skipped => "skipped",
    }
}

/// Lines around each change that a diff keeps.
const CONTEXT: usize = 3;

/// A unified diff of two texts' lines: `-` removed, `+` added, ` ` kept,
/// with `@@` before each group of changes.
pub fn diff(old: &str, new: &str) -> Vec<String> {
    let (a, b): (Vec<&str>, Vec<&str>) = (old.lines().collect(), new.lines().collect());
    // The longest common subsequence, from the end: lcs[i][j] is its length
    // for a[i..] and b[j..]. Memory and skills are small, so n·m is fine.
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            ops.push((' ', a[i]));
            (i, j) = (i + 1, j + 1);
        } else if i < a.len() && (j == b.len() || lcs[i + 1][j] >= lcs[i][j + 1]) {
            ops.push(('-', a[i]));
            i += 1;
        } else {
            ops.push(('+', b[j]));
            j += 1;
        }
    }
    // Within each run of changes, what goes comes before what replaces it.
    let mut start = 0;
    while start < ops.len() {
        let end = ops[start..].iter().position(|(k, _)| *k == ' ').map_or(ops.len(), |n| start + n);
        ops[start..end].sort_by_key(|(k, _)| *k == '+');
        start = end + 1;
    }
    // Lines shown: each change, and the lines around it.
    let mut keep = vec![false; ops.len()];
    for (n, (kind, _)) in ops.iter().enumerate() {
        if *kind != ' ' {
            let around = n.saturating_sub(CONTEXT)..(n + CONTEXT + 1).min(ops.len());
            keep[around].fill(true);
        }
    }
    let mut out = Vec::new();
    for (n, (kind, text)) in ops.iter().enumerate() {
        if !keep[n] {
            continue;
        }
        if n == 0 || !keep[n - 1] {
            out.push("@@".to_string());
        }
        out.push(format!("{kind}{text}"));
    }
    out
}
