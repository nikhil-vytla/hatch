// What the Learned pane shows of the project's learning: proposals as
// people read them, and the state of the latest run, folded from the
// learning session's journal.
import type { Artifact, Entry, Gate, ProposalStatus, Verdict } from "@strive/protocol";

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
