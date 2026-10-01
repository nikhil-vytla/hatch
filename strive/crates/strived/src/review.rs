//! `strive learn` and `strive review`: asking the project's learner to study
//! its sessions, and a person's review of what it proposes.
//!
//! What a person reads here names the gates by what they do: the static
//! gate is the "safety checks", the judge is the "second opinion".

use std::collections::HashMap;
use std::fmt::Write as _;
use std::process::ExitCode;

use anyhow::{Result, anyhow};
use strive_proto::{
    BlobGet, BlobGetParams, BulletEdit, Change, Event, Gate, GateOutcome, LearnSignal, LearnTrigger, LearningOpen,
    LearningRun, LearningRunParams, MemoryItem, ProjectRef, ProposalDecide, ProposalDecideParams, ProposalDecision,
    ProposalList, ProposalRef, ProposalRollback, ProposalState, ProposalStatus, SessionAttach, SessionAttachParams,
    SessionList, SessionListParams, TriggerKind, Verdict,
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
    let studying = match sessions.len() {
        0 => "studying the sessions since the learner last looked…".to_string(),
        1 => "studying 1 session…".to_string(),
        n => format!("studying {n} sessions…"),
    };
    let sessions = (!sessions.is_empty()).then_some(sessions);
    let asked = c.request::<LearningRun>(LearningRunParams { cwd: cwd.clone(), sessions, offer: None }).await?.seq;
    println!("{studying}");
    eprintln!("strive: `strive log {id}` shows the learner's steps");
    let follow =
        crate::run::Follow { home, id: &id, shown, prompt: asked, json: false, quiet: true, who: "the learner" };
    let (code, seen) = follow.until_turn_ends(c).await?;
    if code != ExitCode::SUCCESS
        && let Some(end) = seen.iter().rev().find(|e| matches!(e.event, Event::TurnEnded { .. }))
    {
        println!("{}", crate::terminal::visible(&crate::commands::describe(end)));
    }
    let made: Vec<u64> = seen.iter().filter(|e| matches!(e.event, Event::ProposalMade { .. })).map(|e| e.seq).collect();
    if made.is_empty() {
        println!("the learner proposed nothing");
        return Ok(code);
    }
    let mut all = c.request::<ProposalList>(ProjectRef { cwd: cwd.clone() }).await?.proposals;
    let checking =
        |all: &[ProposalState]| all.iter().any(|p| made.contains(&p.id) && p.status == ProposalStatus::Checking);
    if checking(&all) {
        println!("waiting for a second opinion on what it proposed…");
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

/// How long `strive learn` waits for the second opinion before listing
/// proposals still being checked.
const JUDGE_WAIT: std::time::Duration = std::time::Duration::from_secs(300);

/// One proposal in a list.
fn line(p: &ProposalState) -> String {
    let mut marks = Vec::new();
    if p.trigger.is_some() {
        marks.push("automatic run");
    }
    if advises_against(p).is_some() {
        marks.push("second opinion advises against it");
    }
    let marks = if marks.is_empty() { String::new() } else { format!("  [{}]", marks.join(", ")) };
    format!(
        "#{:<5} {:<16} {:<20} {}{marks}",
        p.id,
        short_status(p),
        strive_learning::describe(&p.proposal.change.artifact()),
        p.proposal.summary
    )
}

/// A proposal's status in a list's column.
fn short_status(p: &ProposalState) -> String {
    match (p.status, p.replaced_by) {
        (ProposalStatus::Applied, Some(by)) => format!("replaced by #{by}"),
        (ProposalStatus::Stale, _) => "file changed".into(),
        (status, _) => strive_learning::status_name(status).into(),
    }
}

/// A proposal's status in words, for its own page.
fn status_text(p: &ProposalState) -> String {
    match (p.status, p.replaced_by) {
        (ProposalStatus::Checking, _) => "being checked".into(),
        (ProposalStatus::Ready, _) => "ready to review".into(),
        (ProposalStatus::Failed, _) => "failed its safety checks".into(),
        (ProposalStatus::Rejected, _) => "rejected".into(),
        (ProposalStatus::Applied, Some(by)) => format!("replaced by #{by}"),
        (ProposalStatus::Applied, None) => "applied".into(),
        (ProposalStatus::Stale, _) => "not written: the file changed since this was proposed".into(),
        (ProposalStatus::RolledBack, _) => "rolled back".into(),
    }
}

/// What started an automatic run, in one line: "after a session went idle:
/// a correction in session X".
pub fn trigger_text(t: &LearnTrigger) -> String {
    let signs = strive_learning::signals::describe(&t.signals);
    match t.kind {
        TriggerKind::Idle => format!("after a session went idle: {signs}"),
        TriggerKind::Turns => format!("after a session's turns reached learning.everyTurns: {signs}"),
    }
}

/// The project's work sessions by id: what a person calls each.
struct Titles(HashMap<String, String>);

impl Titles {
    async fn of(c: &mut Client, cwd: &str) -> Result<Self> {
        let listed = c.request::<SessionList>(SessionListParams { cwd: Some(cwd.to_string()), kind: None }).await?;
        Ok(Self(
            listed
                .sessions
                .into_iter()
                .map(|s| (s.id, format!("\"{}\"", s.title.unwrap_or_else(|| "an untitled session".into()))))
                .collect(),
        ))
    }

    /// A session as a person knows it: its title, or its id if it isn't one of the project's.
    fn name<'a>(&'a self, id: &'a str) -> &'a str {
        self.0.get(id).map_or(id, String::as_str)
    }

    /// `text` with each of the project's session ids in it named by title.
    fn named(&self, text: &str) -> String {
        self.0.iter().fold(text.to_string(), |text, (id, title)| text.replace(id, title))
    }

    /// The sessions `signals` came from, by title: `"run the tests"` or `2 sessions`.
    fn sessions_of(&self, signals: &[LearnSignal]) -> String {
        let mut ids: Vec<&str> = signals.iter().map(|s| s.session.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        match ids.as_slice() {
            [one] => self.name(one).to_string(),
            many => format!("{} sessions", many.len()),
        }
    }
}

/// Where the run that made `p` came from, in plain words.
fn origin(p: &ProposalState, titles: &Titles) -> String {
    let signs = |s: &[LearnSignal]| {
        if s.is_empty() {
            String::new()
        } else {
            format!(": {} in {}", strive_learning::signals::summary(s), titles.sessions_of(s))
        }
    };
    match (&p.trigger, &p.offered) {
        (Some(t), _) => {
            let when = match t.kind {
                TriggerKind::Idle => "automatic, after a session went idle",
                TriggerKind::Turns => "automatic, after a session's turns reached learning.everyTurns",
            };
            format!("{when}{}", signs(&t.signals))
        }
        (None, Some(s)) => format!("you said yes to the end-of-session offer{}", signs(s)),
        (None, None) => "asked with `strive learn`".into(),
    }
}

pub async fn review(c: &mut Client, id: Option<u64>, action: Option<Action>, full: bool) -> Result<ExitCode> {
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
        for l in outside_review(&listed.changed_outside_review, &listed.memory) {
            println!("{l}");
        }
        for s in &listed.may_be_stale {
            println!(
                "{} line {} may be out of date: it names {}, which isn't in the project",
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
    let rel = strive_learning::relative_path(&p.proposal.change.artifact()).unwrap_or_else(|why| why);
    match action {
        None => {
            let titles = Titles::of(c, &cwd).await?;
            let old = match p.before {
                Some(digest) => c.request::<BlobGet>(BlobGetParams { digest }).await?.text,
                None => String::new(),
            };
            print!("{}", crate::terminal::visible(&page(p, &rel, &old, &titles, full)?));
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
                        "#{id} wasn't written: {rel} changed since this was proposed. \
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
        // The daemon decides (it also finishes a rollback a crash cut off);
        // when it refuses, the list's reason says it more plainly.
        Some(Action::Rollback) => {
            if let Err(e) = c.request::<ProposalRollback>(ProposalRef { cwd, proposal: id }).await {
                return Err(no_rollback(p, &rel).map_or(e, |why| anyhow!("nothing was rolled back: {why}")));
            }
            println!("{}", rolled_back(p, &rel));
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// What a rollback of `p` did, for a person.
fn rolled_back(p: &ProposalState, rel: &str) -> String {
    let id = p.id;
    match (&p.proposal.change, p.before) {
        (Change::Memory(_), _) => format!("rolled back #{id}: its bullet in {rel} is as it was before"),
        (
            Change::Skill { .. }
            | Change::Check { .. }
            | Change::Command { .. }
            | Change::Rule { .. }
            | Change::Extension { .. },
            Some(_),
        ) => {
            format!("rolled back #{id}: {rel} is as it was before")
        }
        (
            Change::Skill { .. }
            | Change::Check { .. }
            | Change::Command { .. }
            | Change::Rule { .. }
            | Change::Extension { .. },
            None,
        ) => {
            format!("rolled back #{id}: removed {rel}, which didn't exist before")
        }
    }
}

/// Why an applied proposal can't be rolled back now, if it can't; none for
/// any other status, which the daemon refuses with its own reason.
fn no_rollback(p: &ProposalState, rel: &str) -> Option<String> {
    let memory = matches!(p.proposal.change, Change::Memory(_));
    match (p.status, p.replaced_by, p.can_roll_back) {
        (ProposalStatus::Applied, Some(by), _) if memory => {
            Some(format!("#{by} changed or removed its bullet since; roll back #{by} first"))
        }
        (ProposalStatus::Applied, Some(by), _) => {
            Some(format!("#{by} was accepted over it, so {rel} no longer has its content"))
        }
        (ProposalStatus::Applied, None, false) if memory => {
            Some(format!("its bullet in {rel} changed since #{} was applied; edit it by hand instead", p.id))
        }
        (ProposalStatus::Applied, None, false) => {
            Some(format!("{rel} changed since #{} was applied; edit it by hand instead", p.id))
        }
        _ => None,
    }
}

/// What a proposal changes, for its page: a bullet's edit, or a file's (or
/// an extension's files') diff.
fn change_text(p: &ProposalState, rel: &str, old: &str) -> Result<String> {
    let mut out = String::new();
    match &p.proposal.change {
        Change::Memory(_) => match &p.bullet {
            Some(edit) => {
                writeln!(out, "\n{}", edit_text(edit))?;
                for l in bullet_diff(edit) {
                    writeln!(out, "{l}")?;
                }
            }
            None => writeln!(out, "\nit names a bullet the memory the learner saw doesn't have")?,
        },
        Change::Skill { content, .. }
        | Change::Check { content, .. }
        | Change::Command { content, .. }
        | Change::Rule { content, .. } => {
            if p.before.is_none() {
                writeln!(out, "\n{rel} is a new file")?;
            } else {
                writeln!(out)?;
            }
            for l in diff(old, content) {
                writeln!(out, "{l}")?;
            }
        }
        Change::Extension { files, .. } => {
            // Its files, each under its path, as they were and as they'd be.
            let before: Vec<strive_proto::ExtensionFile> = serde_json::from_str(old).unwrap_or_default();
            writeln!(
                out,
                "\n{}",
                if p.before.is_none() { format!("{rel} is a new extension") } else { String::new() }
            )?;
            for t in tools_text(files) {
                writeln!(out, "{t}")?;
            }
            let shown = strive_learning::extension_dir::shown;
            for l in diff(&shown(&before), &shown(files)) {
                writeln!(out, "{l}")?;
            }
        }
    }
    Ok(out)
}

/// `strive review ID`: the summary and status, the diff, the checks in one
/// line, and what to do next. `full` adds the reasons, the evidence, and
/// each check's detail.
fn page(p: &ProposalState, rel: &str, old: &str, titles: &Titles, full: bool) -> Result<String> {
    let id = p.id;
    let mut out = String::new();
    writeln!(out, "#{id} {} ({})", p.proposal.summary, status_text(p))?;
    writeln!(out, "changes {rel}; {} on {}", origin(p, titles), when(p.made_at_ms))?;
    out.push_str(&change_text(p, rel, old)?);
    writeln!(out, "\n{}", verdict(p))?;
    if full {
        writeln!(out, "\nwhy\n{}", indent(&p.proposal.rationale))?;
        writeln!(out, "\nprediction\n{}", indent(&p.proposal.prediction))?;
        writeln!(out, "\nevidence")?;
        for e in &p.proposal.evidence {
            let seqs = if e.seqs.is_empty() {
                String::new()
            } else {
                format!(" entries {}", e.seqs.iter().map(u64::to_string).collect::<Vec<_>>().join(", "))
            };
            writeln!(out, "  {}{seqs}: {}", titles.name(&e.session), e.note)?;
        }
        let given = p.trigger.as_ref().map(|t| t.signals.as_slice()).or(p.offered.as_deref()).unwrap_or_default();
        if !given.is_empty() {
            writeln!(out, "\nsigns the run was given")?;
            for s in given {
                writeln!(
                    out,
                    "  {} entry {}: {}: {}",
                    titles.name(&s.session),
                    s.seq,
                    strive_learning::signals::kind_name(s.kind),
                    s.detail
                )?;
            }
        }
        writeln!(out, "\nchecks")?;
        for g in &p.gates {
            let detail = titles.named(&g.detail);
            let mut lines = detail.lines();
            let first = lines.next().unwrap_or_default();
            writeln!(out, "  {:<15} {:<8} {first}", gate_name(g.gate), verdict_name(g.verdict))?;
            for l in lines {
                writeln!(out, "{:27}{l}", "")?;
            }
        }
    }
    let next = match (p.status, no_rollback(p, rel)) {
        (ProposalStatus::Ready, _) if advises_against(p).is_some() => {
            format!("`strive review {id} accept` writes {rel} anyway; `strive review {id} reject` turns it down")
        }
        (ProposalStatus::Ready, _) => {
            format!("`strive review {id} accept` writes {rel}; `strive review {id} reject` turns it down")
        }
        (ProposalStatus::Failed, _) => {
            format!("it failed its safety checks, so it can't be accepted; `strive review {id} reject` turns it down")
        }
        (ProposalStatus::Checking, _) => "its checks haven't finished; look again in a moment".to_string(),
        (ProposalStatus::Applied, Some(why)) => format!("it can't be rolled back: {why}"),
        (ProposalStatus::Applied, None) if matches!(p.proposal.change, Change::Memory(_)) => {
            format!("`strive review {id} rollback` puts its bullet back as it was")
        }
        (ProposalStatus::Applied, None) => format!("`strive review {id} rollback` puts {rel} back as it was"),
        (ProposalStatus::Stale, _) => {
            format!("{rel} changed since this was proposed; `strive learn` asks for one against it as it is now")
        }
        (ProposalStatus::Rejected | ProposalStatus::RolledBack, _) => String::new(),
    };
    if !next.is_empty() {
        writeln!(out, "\n{next}")?;
    }
    if !full {
        writeln!(out, "`strive review {id} --full` adds why, the evidence and each check in full")?;
    }
    Ok(out)
}

/// The checks in one line: "safety checks passed; second opinion: supports
/// it", or what the second opinion held against it first.
fn verdict(p: &ProposalState) -> String {
    let gate = |gate: Gate| p.gates.iter().find(|g| g.gate == gate);
    let first_line = |g: &GateOutcome| g.detail.lines().next().unwrap_or_default().to_string();
    let safety = match gate(Gate::Static) {
        None => return "safety checks: still running".into(),
        Some(g) if g.verdict == Verdict::Fail => return format!("safety checks failed: {}", first_line(g)),
        Some(_) => "safety checks passed",
    };
    let second = match gate(Gate::Judge) {
        None => "second opinion: still being asked".to_string(),
        Some(g) => match g.verdict {
            Verdict::Pass => "second opinion: supports it".to_string(),
            Verdict::Skipped => {
                let line = first_line(g);
                format!("second opinion: not asked ({})", line.strip_prefix("not run: ").unwrap_or(&line))
            }
            Verdict::Fail => format!("second opinion advises against it: {}", first_failed(g)),
        },
    };
    format!("{safety}; {second}")
}

/// The reason the second opinion gave for the first criterion it failed,
/// or its detail's first line when the detail isn't read by criterion.
fn first_failed(g: &GateOutcome) -> String {
    let criterion = g.detail.lines().find_map(|l| l.strip_prefix("FAIL ").and_then(|l| l.split_once(": ")));
    if let Some((_, reason)) = criterion {
        reason.to_string()
    } else {
        let line = g.detail.lines().next().unwrap_or_default();
        line.strip_prefix("failed: ").unwrap_or(line).to_string()
    }
}

/// The second opinion's outcome when it failed the proposal: advice a
/// person may accept past.
fn advises_against(p: &ProposalState) -> Option<&GateOutcome> {
    p.gates.iter().find(|g| g.gate == Gate::Judge && g.verdict == Verdict::Fail)
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
        Gate::Static => "safety checks",
        Gate::Judge => "second opinion",
        Gate::Tests => "its tests",
    }
}

/// An extension's tools in plain words, for a person deciding on it.
fn tools_text(files: &[strive_proto::ExtensionFile]) -> Vec<String> {
    let Some(manifest) = files.iter().find(|f| f.path == "extension.json") else { return Vec::new() };
    let Ok(m) = serde_json::from_str::<serde_json::Value>(&manifest.content) else { return Vec::new() };
    let mut out = vec![
        "each tool runs as a command in the sandbox: it can read and change files in the workspace, \
                        with no network and none of strive's state"
            .to_string(),
    ];
    for t in m["tools"].as_array().into_iter().flatten() {
        out.push(format!("  tool {}: {}", t["name"].as_str().unwrap_or("?"), t["description"].as_str().unwrap_or("")));
    }
    out
}

pub fn verdict_name(v: Verdict) -> &'static str {
    match v {
        Verdict::Pass => "passed",
        Verdict::Fail => "failed",
        Verdict::Skipped => "skipped",
    }
}

/// A line for each learned file changed outside review: for memory, one per
/// bullet that isn't what its source left there.
fn outside_review(files: &[String], memory: &[MemoryItem]) -> Vec<String> {
    let bullets: Vec<(&String, u64)> = memory
        .iter()
        .filter_map(|i| match i {
            MemoryItem::Bullet { text, source: Some(n), outside_review: true } => Some((text, *n)),
            MemoryItem::Bullet { .. } | MemoryItem::Line { .. } => None,
        })
        .collect();
    let mut out = Vec::new();
    for rel in files {
        if rel != strive_learning::MEMORY_PATH || bullets.is_empty() {
            out.push(format!("{rel} changed outside review: it isn't what an accepted proposal last left there"));
            continue;
        }
        for (text, n) in &bullets {
            out.push(format!(
                "{rel}: the bullet marked #{n} changed outside review: {} isn't what #{n} left there",
                crate::terminal::visible(&format!("{text:?}"))
            ));
        }
    }
    out
}

/// What a memory proposal does to its bullet, in words.
pub fn edit_text(edit: &BulletEdit) -> String {
    let source = |line: &str| match strive_learning::memory::source(line) {
        Some(n) => format!("#{n}'s bullet"),
        None => "a hand-written bullet".to_string(),
    };
    match edit {
        BulletEdit::Added { .. } => "adds a bullet".into(),
        BulletEdit::Changed { old, .. } => format!("changes {}", source(old)),
        BulletEdit::Removed { line, .. } => format!("removes {}", source(line)),
    }
}

/// A one-bullet diff: the line that goes, the line that comes.
fn bullet_diff(edit: &BulletEdit) -> Vec<String> {
    match edit {
        BulletEdit::Added { line } => vec![format!("+{line}")],
        BulletEdit::Changed { old, new } => vec![format!("-{old}"), format!("+{new}")],
        BulletEdit::Removed { line, .. } => vec![format!("-{line}")],
    }
}

/// `strive review --memory`: the memory as every session reads it now,
/// each bullet with the proposal that last wrote it, or "hand-written".
pub async fn memory(c: &mut Client) -> Result<ExitCode> {
    let cwd = cwd()?;
    let items = c.request::<ProposalList>(ProjectRef { cwd: cwd.clone() }).await?.memory;
    if items.is_empty() {
        println!("{} has nothing yet; an accepted memory proposal writes it", strive_learning::MEMORY_PATH);
        return Ok(ExitCode::SUCCESS);
    }
    let usage = c.request::<strive_proto::MemoryUsage>(ProjectRef { cwd }).await?;
    println!("{}, as every session reads it now:", strive_learning::MEMORY_PATH);
    for item in &items {
        let line = match item {
            MemoryItem::Bullet { text, source, outside_review } => {
                let who = source.map_or_else(|| "hand-written".to_string(), |n| format!("#{n}"));
                let mark = if *outside_review { "  [changed outside review]" } else { "" };
                let used = source.and_then(|n| usage.bullets.iter().find(|u| u.bullet == n));
                format!("  {who:<13} {text:?}{mark}{}", used.map(used_text).unwrap_or_default())
            }
            MemoryItem::Line { text } if text.trim().is_empty() => String::new(),
            MemoryItem::Line { text } => format!("  {:<13} {text}", ""),
        };
        println!("{}", crate::terminal::visible(line.trim_end()));
    }
    if usage.bullets.iter().any(|u| u.sessions > 0) {
        println!(
            "\nGiven and cited: in the latest {} work session(s). A cite is the agent's own word that a bullet \
             shaped what it did; trouble is what strive saw after: a correction, a rewind, a declined approval, a \
             failed check, or a turn that didn't finish.",
            usage.sessions
        );
    }
    Ok(ExitCode::SUCCESS)
}

/// How a bullet fared, after its line: given, cited, and the latest trouble.
fn used_text(u: &strive_proto::BulletUsage) -> String {
    let mut out = match (u.cited, u.trouble) {
        (0, _) => format!("\n                given {}, never cited", u.sessions),
        (c, 0) => format!("\n                given {}, cited {c}, no trouble after", u.sessions),
        (c, t) => format!("\n                given {}, cited {c}, trouble after {t}", u.sessions),
    };
    if let Some(n) = u.notes.last() {
        let _ = std::fmt::Write::write_fmt(
            &mut out,
            format_args!("\n                latest: {} (session {}, #{})", n.what, short(&n.session), n.seq),
        );
    }
    out
}

fn short(session: &str) -> &str {
    session.get(session.len().saturating_sub(6)..).unwrap_or(session)
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
