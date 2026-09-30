// What the Learned pane shows of the project's learning: proposals as
// people read them, and the state of the latest run, folded from the
// learning session's journal.
import type {
  Artifact,
  BulletEdit,
  Change,
  Entry,
  Gate,
  ProposalState,
  ProposalStatus,
  Verdict,
} from "@strive/protocol";

/**
 * A failed bridge call as a person reads it: the main process's message,
 * without the wrapping Electron adds ("Error invoking remote method …").
 */
export function errorText(e: Error): string {
  const text = e.message;

  return text.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}

/** Where an artifact lives in the project, as `strive review` names it. */
export function artifactPath(a: Artifact): string {
  return a.kind === "memory" ? ".strive/memory.md" : `.strive/skills/${a.name}/SKILL.md`;
}

/** An artifact in a list: "memory", or "skill release". */
export function artifactName(a: Artifact): string {
  return a.kind === "memory" ? "memory" : `skill ${a.name}`;
}

export const STATUS_NAMES: Record<ProposalStatus, string> = {
  checking: "checking",
  ready: "ready",
  failed: "failed",
  rejected: "rejected",
  applied: "applied",
  stale: "file changed",
  rolledBack: "rolled back",
};

/** A proposal's status as its badge says it: an applied one written over is "replaced by #N". */
export function statusName(p: ProposalState): string {
  return p.status === "applied" && p.replacedBy !== undefined ? `replaced by #${p.replacedBy}` : STATUS_NAMES[p.status];
}

/** The gates by what they do: the static gate checks safety, the judge is a second opinion. */
export const GATE_NAMES: Record<Gate, string> = { static: "Safety checks", judge: "Second opinion" };

export const VERDICT_NAMES: Record<Verdict, string> = { pass: "passed", fail: "failed", skipped: "skipped" };

/** What a proposal's status means for its file, and what a person can do next. */
export function statusNote(p: ProposalState, path: string): string {
  switch (p.status) {
    case "checking":
      return "Its checks haven't finished yet.";
    case "ready":
      return `Accepting writes ${path}. New sessions in this project read it.`;
    case "failed":
      return "It failed its safety checks, so it can't be accepted.";
    case "rejected":
      return "Rejected. Nothing was written.";
    case "applied":
      if (p.proposal.change.kind === "memory") {
        if (p.replacedBy !== undefined)
          return `Accepted, then #${p.replacedBy} changed or removed its bullet, so it can't be rolled back until #${p.replacedBy} is.`;

        return p.canRollBack
          ? `Accepted and written to ${path}.`
          : `Accepted and written to ${path}. Its bullet has changed since, so it can't be rolled back. Edit the file by hand instead.`;
      }

      if (p.replacedBy !== undefined)
        return `Accepted, then #${p.replacedBy} was accepted over it, so ${path} no longer has its content.`;

      return p.canRollBack
        ? `Accepted and written to ${path}.`
        : `Accepted and written to ${path}, which has changed since, so it can't be rolled back. Edit the file by hand instead.`;
    case "stale":
      if (p.proposal.change.kind === "memory")
        return "The bullet it changes was edited since this was proposed, so nothing was written. Learn again for a proposal against memory as it is now.";

      return `${path} changed since this was proposed, so nothing was written. Learn again for a proposal against the file as it is now.`;
    case "rolledBack":
      if (p.proposal.change.kind === "memory") return "Rolled back: its bullet is as it was before.";

      return p.before === undefined
        ? `Rolled back: ${path} was removed, as it didn't exist before.`
        : `Rolled back: ${path} is as it was before.`;
    default:
      return p.status satisfies never;
  }
}

/** What the learner's tools do, as the pane says it while a run goes on. */
const STEPS = new Map([
  ["list_sessions", "Looking at this project's sessions"],
  ["read_session", "Reading a session"],
  ["read_artifact", "Reading the memory and skills"],
  ["propose_change", "Writing a proposal"],
]);

export type Run = {
  /** The request's seq. */
  asked: number;
  askedMs: number;
  /** Until its turn ends. */
  running: boolean;
  /** What the learner did last, while it runs. */
  step?: string;
  /** Why the turn ended if not done. */
  stopped?: string;
  /** The ids of the proposals it made. */
  made: number[];
};

/** The latest run a person asked for, from the learning session's entries in order; none if nobody has. */
export function latestRun(entries: Entry[]): Run | undefined {
  const at = entries.findLastIndex((e) => e.event.type === "learnRequested");
  const request = entries[at];

  if (!request) return undefined;

  const after = entries.slice(at + 1);

  // The turn that takes the request: the first to start after it, or one that says it took it.
  const started = entries.find(
    (e) => e.event.type === "turnStarted" && (e.event.throughSeq ?? e.seq) >= request.seq,
  )?.event;

  const turn = started?.type === "turnStarted" ? started.turn : undefined;

  const ended = after.find((e) => e.event.type === "turnEnded" && e.event.turn === turn)?.event;
  const running = ended === undefined;
  let step: string | undefined;

  for (const e of after)
    if (e.event.type === "assistantMessage" && e.event.turn === turn) {
      const tool = e.event.toolCalls.at(-1)?.name;

      step = tool ? (STEPS.get(tool) ?? "Working") : "Writing up";
    }

  const stopped =
    ended?.type !== "turnEnded"
      ? undefined
      : ended.reason.kind === "failed"
        ? ended.reason.error
        : ended.reason.kind === "timedOut"
          ? `it ran out of time at ${ended.reason.seconds}s`
          : ended.reason.kind === "interrupted"
            ? "it was interrupted"
            : undefined;

  return {
    asked: request.seq,
    askedMs: request.tsMs,
    running,
    step: running ? step : undefined,
    stopped,
    made: after.flatMap((e) => (e.event.type === "proposalMade" ? [e.seq] : [])),
  };
}

/** Entries by seq, however they arrive: read whole, or one at a time as they're journaled. */
export class Journal {
  private readonly bySeq = new Map<number, Entry>();

  add(entries: Entry[]) {
    for (const e of entries) this.bySeq.set(e.seq, e);
  }

  get entries(): Entry[] {
    return [...this.bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
}

/** The judge's rubric (ADR-0017), in the order its detail lists it, each as a reviewer reads it. */
export const CRITERIA = [
  ["supported", "Supported by the cited evidence"],
  ["generalizes", "Holds for sessions it didn't cite"],
  ["novel", "Not already covered"],
  ["safe", "Can't mislead the agent or weaken a safeguard"],
  ["checkable", "Its prediction can be checked"],
] as const;

export type Criterion = { id: (typeof CRITERIA)[number][0]; name: string; pass: boolean; reason: string };

export type JudgeReading = {
  /** The outcome, the judge's model and what was held out. */
  head: string;
  summary?: string;
  criteria: Criterion[];
};

/**
 * A judge detail read by criterion, when it's in the daemon's shape
 * (`strive_learning::judge::detail`): the outcome, an optional summary, then
 * one `pass id: reason` or `FAIL id: reason` line per criterion in the
 * rubric's order. Anything else (a skipped judge, an unreadable answer)
 * isn't read, and is shown as it is.
 */
export function readJudge(detail: string): JudgeReading | undefined {
  const lines = detail.split("\n");

  if (lines.length < CRITERIA.length + 1 || lines.length > CRITERIA.length + 2) return undefined;

  const [head, summary] = lines.slice(0, -CRITERIA.length);
  const marks = lines.slice(-CRITERIA.length);
  const criteria: Criterion[] = [];

  for (const [i, [id, name]] of CRITERIA.entries()) {
    const m = new RegExp(`^(pass|FAIL) ${id}: (.*)$`).exec(marks[i] ?? "");

    if (!m) return undefined;
    criteria.push({ id, name, pass: m[1] === "pass", reason: m[2] ?? "" });
  }

  return head === undefined ? undefined : { head, summary, criteria };
}

/**
 * What the judge said against a proposal it failed: its reasons, one per
 * failed criterion (or the detail's first line when it can't be read by
 * criterion). None when it didn't fail it. Advice: a person may accept past it.
 */
export function judgeAdvice(p: ProposalState): string[] | undefined {
  const judge = p.gates.find((g) => g.gate === "judge" && g.verdict === "fail");

  if (judge === undefined) return undefined;

  const read = readJudge(judge.detail);

  if (read === undefined) return [judge.detail.split("\n")[0] ?? ""];

  return read.criteria.filter((c) => !c.pass).map((c) => `${c.name}: ${c.reason}`);
}

/** The file a change is to. */
export function artifactOf(c: Change): Artifact {
  return c.kind === "memory" ? { kind: "memory" } : { kind: "skill", name: c.name };
}

/** The proposals for the same file as `p`, newest first, `p` among them: the file's history as review sees it. */
export function fileHistory(proposals: readonly ProposalState[], p: ProposalState): ProposalState[] {
  const path = artifactPath(artifactOf(p.proposal.change));

  // An id is its entry's seq, so a higher one is newer.
  return proposals.filter((q) => artifactPath(artifactOf(q.proposal.change)) === path).sort((a, b) => b.id - a.id);
}

/** A diff's two sides, as `Diff` takes them. */
export type DiffSides = { before: string; after: string };

/** A memory proposal's one-bullet diff as the lines before and after it. */
export function bulletLines(edit: BulletEdit): DiffSides {
  switch (edit.op) {
    case "added":
      return { before: "", after: `${edit.line}\n` };
    case "changed":
      return { before: `${edit.old}\n`, after: `${edit.new}\n` };
    case "removed":
      return { before: `${edit.line}\n`, after: "" };
    default:
      return edit satisfies never;
  }
}
