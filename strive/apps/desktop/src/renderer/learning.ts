// What the Learned pane shows of the project's learning: proposals as
// people read them, and the state of the latest run, folded from the
// learning session's journal.
import type {
  Artifact,
  Entry,
  Gate,
  PredictionTally,
  ProposalState,
  ProposalStatus,
  StepMatch,
  Verdict,
  Watch,
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
  stale: "stale",
  rolledBack: "rolled back",
};

export const GATE_NAMES: Record<Gate, string> = { static: "Static", judge: "Judge", replay: "Replay" };

export const VERDICT_NAMES: Record<Verdict, string> = { pass: "passed", fail: "failed", skipped: "skipped" };

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

/** The proposals for the same file as `p`, newest first, `p` among them: the file's history as review sees it. */
export function fileHistory(proposals: readonly ProposalState[], p: ProposalState): ProposalState[] {
  const path = artifactPath(p.proposal.artifact);

  return proposals.filter((q) => artifactPath(q.proposal.artifact) === path);
}

function stepText(m: StepMatch): string {
  if (m.prompt !== undefined) return `a prompt containing "${m.prompt.trim()}"`;

  const parts = ["a command"];

  if (m.command !== undefined) parts.push(`containing "${m.command.trim()}"`);

  if (m.output !== undefined) parts.push(`whose output contains "${m.output.trim()}"`);

  if (m.exit === "zero") parts.push("that exited 0");

  if (m.exit === "nonZero") parts.push("that failed");

  return parts.join(" ");
}

/** A watch as `strive review` reads it (`strive_learning::watch::describe`). */
export function watchText(w: Watch): string {
  const e = w.expect;

  const expect =
    e.kind === "never"
      ? `never ${stepText(e.step)}`
      : e.kind === "any"
        ? `at least once, ${stepText(e.step)}`
        : `the first step that is ${stepText(e.of)} is also ${stepText(e.is)}`;

  return w.when === undefined ? `in every session: ${expect}` : `in sessions with ${stepText(w.when)}: ${expect}`;
}

/** How a watch has fared, as counts a person reads. */
export function tallyText(t: PredictionTally | undefined): string {
  const checked = (t?.confirmed ?? 0) + (t?.contradicted ?? 0);

  if (t === undefined || checked === 0)
    return t === undefined || t.notApplicable === 0
      ? "No session has been checked against it yet."
      : `It hasn't applied to any of the ${t.notApplicable} sessions checked.`;

  const others = t.notApplicable === 0 ? "" : ` (${t.notApplicable} more it didn't apply to)`;

  return `Confirmed in ${t.confirmed}, contradicted in ${t.contradicted} of ${checked} session${checked === 1 ? "" : "s"}${others}.`;
}
