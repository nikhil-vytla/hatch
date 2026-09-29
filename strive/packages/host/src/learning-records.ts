// How the learning session's own entries read to the learner, live and on
// resume. The journal is the conversation, so these texts are what makes a
// resumed learner see what a running one saw.
import type { Entry, LearnSignal, LearnTrigger, SignalKind, Verdict } from "@strive/protocol";
import type { ToolResultText } from "./transcript";

/** A time as the learner reads it, in list_sessions and in requests alike. */
export function when(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What the daemon's pre-filter calls each sign, as the learner reads it. */
const SIGNS: Record<SignalKind, string> = {
  correction: "the user corrected the agent",
  interrupted: "a turn was interrupted",
  declined: "the user declined an approval",
  failedThenPassed: "a command failed, then passed",
  turnFailed: "a turn failed",
};

/**
 * The prompt a `learnRequested` entry gives: which work sessions to study,
 * and the signs strive found in them (what started an automatic run, or
 * what a person was shown when they asked), so the learner reads those
 * entries first.
 */
export function requestText(
  sessions: string[],
  sinceMs: number | undefined,
  trigger?: LearnTrigger,
  signals?: LearnSignal[],
): string {
  const which =
    sessions.length > 0
      ? `Study these work sessions: ${sessions.join(", ")}.`
      : sinceMs === undefined
        ? "Study this project's work sessions. You haven't looked at this project before."
        : `Study this project's work sessions active since ${when(sinceMs)}, when you last looked.`;

  const ask = `${which} Propose what the next sessions here should know, or nothing if nothing is worth it.`;
  const listed = trigger?.signals ?? signals ?? [];

  if (listed.length === 0) return ask;

  const why = trigger
    ? "Nobody asked for this run: strive started it because these entries looked worth learning from."
    : "The user asked for this run after strive showed them these entries as worth learning from.";

  const signs = listed.map((s) => `- session ${s.session} entry ${s.seq}: ${SIGNS[s.kind]}: ${s.detail}`);

  return [ask, `${why} Read them first; they may hold no lesson.`, ...signs].join("\n");
}

/**
 * Reads turn prompts from journal entries, in journal order: a person's
 * message, or a learning request (whose text names the previous request's
 * time, so it depends on what came before).
 */
export class PromptReader {
  private lastRequestMs: number | undefined;

  read(entry: Entry): string | undefined {
    const e = entry.event;

    if (e.type === "userMessage") return e.text;

    if (e.type !== "learnRequested") return undefined;
    const text = requestText(e.sessions, this.lastRequestMs, e.trigger, e.signals);
    this.lastRequestMs = entry.tsMs;

    return text;
  }

  /** When the latest request was made: sessions active after it are new to the learner. */
  get sinceMs(): number | undefined {
    return this.lastRequestMs;
  }
}

/** The daemon's static check of a proposal, once it has journaled one. */
export type StaticGate = { verdict: Verdict; detail: string };

/** What propose_change tells the model: the proposal's id, and how its static check went. */
export function proposalResult(id: number, gate: StaticGate | undefined): ToolResultText {
  const review = `A person reviews it with \`strive review ${id}\`.`;

  if (gate === undefined)
    return { text: `Recorded as proposal ${id}. The daemon's checks are still running. ${review}`, isError: false };

  switch (gate.verdict) {
    case "pass":
      return { text: `Recorded as proposal ${id}. It passed the static check. ${review}`, isError: false };
    case "skipped":
      return {
        text: `Recorded as proposal ${id}. The static check was skipped: ${gate.detail} ${review}`,
        isError: false,
      };
    case "fail":
      return {
        text: [
          `Recorded as proposal ${id}, but it failed the daemon's static check, so it can't be accepted: ${gate.detail}`,
          "Propose again with that fixed if the change is still worth making; otherwise leave it.",
        ].join("\n"),
        isError: true,
      };
    default:
      return gate.verdict satisfies never;
  }
}

/** On resume, a propose_change call with no `proposalMade`: nothing was recorded for it. */
export const NOT_RECORDED: ToolResultText = {
  text: "No proposal was recorded for this call: the daemon refused it, or the turn ended first.",
  isError: true,
};

/** On resume, a read tool's call: its output isn't journaled. */
export function notKept(tool: string): ToolResultText {
  return {
    text: `This ${tool} output isn't kept in the journal. Call ${tool} again if you still need it.`,
    isError: false,
  };
}
