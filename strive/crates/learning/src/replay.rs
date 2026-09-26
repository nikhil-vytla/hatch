//! The replay gate's pure parts (ADR-0018): finding tasks with an outcome a
//! machine can check in a work session's journal, and reading a verdict
//! from how the runs went.
//!
//! A task is a turn whose command failed and which the same session later
//! ran again with exit 0: a test going red to green, say. Replaying it
//! means starting from the files as they were before the turn's prompt,
//! giving the agent the same prompt, and running the command afterwards.

use strive_proto::{EffectOutcome, EffectRecord, Entry, Event, Verdict};

/// The most tasks a replay runs.
pub const TASKS: usize = 3;
/// The longest check command a task keeps: longer ones are rarely a plain
/// check someone would rerun.
pub const CHECK_LIMIT: usize = 300;

/// A past task to run again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    /// The work session it came from.
    pub session: String,
    /// The seq of the turn's first prompt.
    pub prompt_seq: u64,
    /// What the user asked: the turn's prompts, in order.
    pub prompt: String,
    /// The checkpoint (a commit in the session's shadow repository) saved
    /// just before the prompt.
    pub commit: String,
    /// The command whose exit decides whether the task passed.
    pub check: String,
    /// The seqs of the run that failed in this turn and of the later run
    /// that passed.
    pub failed_seq: u64,
    pub passed_seq: u64,
}

struct Turn {
    prompt_seq: u64,
    prompt: String,
    commit: Option<String>,
}

struct Run {
    turn: usize,
    command: String,
    exit: i32,
    seq: u64,
}

/// The tasks in one work session's journal, in the order their turns ran:
/// at most one per turn, its first command that failed and later passed.
pub fn mine(session: &str, entries: &[Entry]) -> Vec<Task> {
    let (turns, runs) = read(entries);
    let mut tasks = Vec::new();
    for (i, turn) in turns.iter().enumerate() {
        let Some(commit) = &turn.commit else { continue };
        if turn.prompt.is_empty() {
            continue;
        }
        if let Some((failed, passed)) = first_fixed(&runs, i) {
            tasks.push(Task {
                session: session.to_string(),
                prompt_seq: turn.prompt_seq,
                prompt: turn.prompt.clone(),
                commit: commit.clone(),
                check: failed.command.clone(),
                failed_seq: failed.seq,
                passed_seq: passed.seq,
            });
        }
    }
    tasks
}

/// A command a turn ran that failed, and the same command's later run with
/// exit 0 in the same session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fixed {
    pub command: String,
    pub failed_seq: u64,
    pub passed_seq: u64,
}

/// Each turn's first command that failed and later passed, as `mine` finds
/// them, whether or not the turn could be replayed (a checkpoint, a prompt).
pub fn fixed(entries: &[Entry]) -> Vec<Fixed> {
    let (turns, runs) = read(entries);
    (0..turns.len())
        .filter_map(|i| first_fixed(&runs, i))
        .map(|(failed, passed)| Fixed {
            command: failed.command.clone(),
            failed_seq: failed.seq,
            passed_seq: passed.seq,
        })
        .collect()
}

/// Turn `turn`'s first command that failed and that a later run passed.
fn first_fixed(runs: &[Run], turn: usize) -> Option<(&Run, &Run)> {
    runs.iter().filter(|r| r.turn == turn && r.exit != 0).find_map(|failed| {
        let usable = !failed.command.is_empty() && failed.command.len() <= CHECK_LIMIT;
        let passed = runs.iter().find(|r| r.seq > failed.seq && r.exit == 0 && r.command == failed.command);
        passed.filter(|_| usable).map(|passed| (failed, passed))
    })
}

/// A journal's turns, with their prompts and checkpoints, and the commands
/// that ran to an exit, each with its turn.
fn read(entries: &[Entry]) -> (Vec<Turn>, Vec<Run>) {
    // Prompts not yet taken by a turn: (seq, text, checkpoint before it).
    let mut waiting: Vec<(u64, String, Option<String>)> = Vec::new();
    let mut checkpoint: Option<(u64, String)> = None;
    let mut turns: Vec<Turn> = Vec::new();
    let mut effects: Vec<(u64, String, usize)> = Vec::new();
    let mut runs: Vec<Run> = Vec::new();
    for e in entries {
        match &e.event {
            Event::Checkpointed { commit, .. } => checkpoint = Some((e.seq, commit.clone())),
            Event::UserMessage { text } => {
                // A prompt's checkpoint is journaled with it, just before it.
                let commit = checkpoint.take().filter(|(seq, _)| seq + 1 == e.seq).map(|(_, c)| c);
                waiting.push((e.seq, text.clone(), commit));
            }
            Event::TurnStarted { through_seq, .. } => {
                let upto = through_seq.unwrap_or(e.seq);
                let taken: Vec<_> = waiting.iter().filter(|(seq, ..)| *seq <= upto).cloned().collect();
                waiting.retain(|(seq, ..)| *seq > upto);
                if let Some((first, _, commit)) = taken.first() {
                    let prompt = taken.iter().map(|(_, t, _)| t.trim()).collect::<Vec<_>>().join("\n\n");
                    turns.push(Turn { prompt_seq: *first, prompt, commit: commit.clone() });
                }
            }
            Event::EffectStarted { effect, record: EffectRecord::Bash { command, .. }, .. } => {
                if let Some(turn) = turns.len().checked_sub(1) {
                    effects.push((*effect, command.trim().to_string(), turn));
                }
            }
            Event::EffectFinished { effect, outcome: EffectOutcome::Done { exit_code: Some(exit), .. }, .. } => {
                if let Some((_, command, turn)) = effects.iter().find(|(id, ..)| id == effect) {
                    runs.push(Run { turn: *turn, command: command.clone(), exit: *exit, seq: e.seq });
                }
            }
            _ => {}
        }
    }
    (turns, runs)
}

/// `text` with the project's directory `from` replaced by `to` wherever it
/// appears as a whole path: followed by `/`, the end, or a character that
/// can't continue a directory name. Agents often write
/// `cd /the/project && make`; replayed as written, that would run in the
/// project rather than in its scratch copy.
pub fn relocate(text: &str, from: &str, to: &str) -> String {
    if from.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(from) {
        let after = &rest[i + from.len()..];
        let whole = after.chars().next().is_none_or(|c| !(c.is_alphanumeric() || "._-~".contains(c)));
        out.push_str(&rest[..i]);
        out.push_str(if whole { to } else { from });
        rest = after;
    }
    out.push_str(rest);
    out
}

/// How one task's runs went, on each side.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskTally {
    /// How a person finds it: the session and prompt seq.
    pub session: String,
    pub prompt_seq: u64,
    pub check: String,
    pub with_passed: u32,
    pub with_runs: u32,
    pub without_passed: u32,
    pub without_runs: u32,
}

/// The replay gate's verdict and the detail a reviewer reads.
/// - pass: with the change, runs passed at least as often as without it;
/// - fail: they passed less often;
/// - skipped (inconclusive): every run failed on both sides, so the replay
///   can't tell whether the change helps.
pub fn verdict(tasks: &[TaskTally], model: &str, cost: &str) -> (Verdict, String) {
    let sum = |f: fn(&TaskTally) -> u32| tasks.iter().map(f).sum::<u32>();
    let (wp, wr) = (sum(|t| t.with_passed), sum(|t| t.with_runs));
    let (op, or) = (sum(|t| t.without_passed), sum(|t| t.without_runs));
    let counts = format!(
        "with the change {wp}/{wr} passed, without {op}/{or}; {} task{}",
        tasks.len(),
        if tasks.len() == 1 { "" } else { "s" }
    );
    // Rates compared without division: wp/wr < op/or.
    let worse = u64::from(wp) * u64::from(or) < u64::from(op) * u64::from(wr);
    let (verdict, head) = if wp == 0 && op == 0 {
        (Verdict::Skipped, format!("inconclusive: every run failed, {counts}, so replay can't tell whether it helps"))
    } else if worse {
        (Verdict::Fail, format!("failed: {counts}"))
    } else {
        (Verdict::Pass, counts)
    };
    let mut lines = vec![head, format!("{model}, {cost}")];
    for t in tasks {
        lines.push(format!(
            "session {} #{} `{}`: with {}/{}, without {}/{}",
            t.session, t.prompt_seq, t.check, t.with_passed, t.with_runs, t.without_passed, t.without_runs
        ));
    }
    (verdict, lines.join("\n"))
}
