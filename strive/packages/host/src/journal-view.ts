// A work session's journal as the learner reads it: compact, one block per
// thing that happened, each under its entry's seq so a proposal can cite it.
// Pages stay within a token budget; long outputs are cut with a note.
import type { EffectOutcome, EffectRecord, Entry, Event, SessionInfo, SessionReadResult } from "@strive/protocol";
import { when } from "./learning-records";

export type Blob = (digest: string) => Promise<string>;

/** Rough tokens in text, as models count English and code. */
export const tokens = (text: string) => Math.ceil(text.length / 4);

/** How much of one output or message a page shows, in characters. */
const LIMITS = { prompt: 3000, reply: 2000, command: 2000, read: 300, change: 400 };

/**
 * `text` within `max` characters. What's cut is said, with how much; the
 * start and the end are kept, since a command's error is usually at its end.
 */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  const tail = max - head;

  return `${text.slice(0, head)}\n[... ${text.length - max} characters cut ...]\n${text.slice(-tail)}`;
}

const indent = (text: string) =>
  text
    .trimEnd()
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

function outcomeText(record: EffectRecord | undefined, outcome: EffectOutcome, output: string): string {
  switch (outcome.kind) {
    case "refused":
      return `refused: ${outcome.reason}`;
    case "interrupted":
      return "cut off: the daemon stopped while it ran";
    case "done": {
      const exit = outcome.exitCode === undefined ? "done" : `exit ${outcome.exitCode}`;
      const max = record?.kind === "read" ? LIMITS.read : LIMITS.command;
      const kept = outcome.truncated ? "\n[the daemon kept only part of this output]" : "";

      return output.trim() === "" ? `${exit}, no output` : `${exit}\n${indent(cut(output, max) + kept)}`;
    }

    default:
      return outcome satisfies never;
  }
}

async function recordText(record: EffectRecord, blob: Blob): Promise<string> {
  switch (record.kind) {
    case "bash":
      return `ran \`${record.command}\``;
    case "read":
      return `read ${record.path}${record.offset === undefined ? "" : ` from line ${record.offset}`}`;
    case "write":
      return `wrote ${record.path} (${record.bytes} bytes)`;
    case "edit": {
      const [before, after] = await Promise.all([blob(record.oldText), blob(record.newText)]);

      return `edited ${record.path}\n  - ${cut(before, LIMITS.change).replaceAll("\n", "\n    ")}\n  + ${cut(after, LIMITS.change).replaceAll("\n", "\n    ")}`;
    }

    case "mcp":
      return `called ${record.server}'s ${record.tool} ${cut(await blob(record.arguments), LIMITS.change)}`;
    default:
      return record satisfies never;
  }
}

const decided = { allow: "approved", allowSession: "approved for the session", deny: "declined" } as const;

/** An effect's start, by effect number, and whether the journal has its end. */
type Effect = { start: Entry; record: EffectRecord; finished: boolean };

/** One entry's block, or nothing for entries a reader learns nothing from. */
async function block(entry: Entry, effects: Map<number, Effect>, ran: Set<string>, blob: Blob): Promise<string> {
  const e: Event = entry.event;
  const at = `#${entry.seq}`;

  switch (e.type) {
    case "userMessage":
      return `${at} user: ${cut(e.text, LIMITS.prompt)}`;
    case "assistantMessage": {
      const notRun = e.toolCalls.filter((c) => !ran.has(c.id)).map((c) => c.name);
      const calls = notRun.length > 0 ? ` [called ${notRun.join(", ")}, with no effect run]` : "";

      if (e.text.trim() === "" && calls === "") return "";

      return `${at} agent: ${cut(e.text.trim(), LIMITS.reply)}${calls}`;
    }

    case "effectStarted": {
      const open =
        effects.get(e.effect)?.finished === false ? " (no result: the session ended or is still running)" : "";

      return `${at} ${await recordText(e.record, blob)}${open}`;
    }

    case "effectFinished": {
      // Its own block, apart from its start, so a page break between them shows each once.
      const effect = effects.get(e.effect);
      const output = e.outcome.kind === "done" ? await blob(e.outcome.output) : "";
      const of = effect === undefined ? `effect ${e.effect}` : `#${effect.start.seq}`;

      return `${at} result of ${of}: ${outcomeText(effect?.record, e.outcome, output)}`;
    }

    case "approvalRequested":
      return `${at} asked for approval: ${e.description}`;
    case "approvalDecided":
      return `${at} ${decided[e.decision]} by ${e.by}`;
    case "approvalModeSet":
      return `${at} approvals set to ${e.mode}`;
    case "turnStarted":
      return `${at} turn ${e.turn}`;
    case "turnEnded":
      switch (e.reason.kind) {
        case "done":
          return `${at} turn ${e.turn} done`;
        case "interrupted":
          return `${at} turn ${e.turn} interrupted by the user`;
        case "timedOut":
          return `${at} turn ${e.turn} stopped at its ${e.reason.seconds}s time limit`;
        case "failed":
          return `${at} turn ${e.turn} failed: ${e.reason.error}`;
        default:
          return e.reason satisfies never;
      }

    case "modelCallFinished":
      switch (e.outcome.kind) {
        case "complete":
          return "";
        case "rejected":
          return `${at} the model call was rejected (HTTP ${e.outcome.status})`;
        case "broken":
          return `${at} the model call broke: ${e.outcome.reason}`;
        default:
          return e.outcome satisfies never;
      }

    case "rewound":
      return `${at} rewound the files to checkpoint ${e.to} (the files before it saved as checkpoint ${e.savedAs})`;
    case "compacted":
      return `${at} the conversation up to #${e.uptoSeq} was summarized: ${cut(e.summary, LIMITS.reply)}`;
    case "recovered":
      return `${at} recovered after a crash (${e.discardedBytes} bytes of a torn entry discarded)`;
    case "contextLoaded": {
      const files = e.instructions.map((f) => f.path).join(", ") || "no instruction files";
      const failed = e.mcp.filter((m) => m.error !== undefined).map((m) => `${m.server} (${m.error})`);

      return `${at} loaded ${files}; skills: ${e.skills.join(", ") || "none"}${failed.length > 0 ? `; MCP servers that failed: ${failed.join(", ")}` : ""}`;
    }

    case "layoutProposed":
      return `${at} proposed a desktop layout: ${e.label}`;
    case "learnRequested":
      return `${at} ${e.trigger ? "automatic " : ""}learning requested`;
    case "learnSkipped":
      return `${at} an automatic learning run was skipped: ${e.reason}`;
    case "learnDismissed":
      return `${at} the user declined to learn from session ${e.session}`;
    case "proposalMade":
      return `${at} proposal: ${e.proposal.summary}`;
    case "gateFinished":
      return `${at} proposal #${e.proposal}'s ${e.gate} check: ${e.verdict}`;
    case "proposalDecided":
      return `${at} proposal #${e.proposal} ${e.decision === "accept" ? "accepted" : "rejected"} by ${e.by} (a client)`;
    case "proposalApplied":
      return `${at} proposal #${e.proposal} applied`;
    case "proposalRolledBack":
      return `${at} proposal #${e.proposal} rolled back by ${e.by} (a client)`;
    case "modelSet":
      return `${at} the session's model set to ${e.model}`;
    case "sessionStarted":
    case "budgetSet":
    case "modelCallStarted":
    case "checkpointed":
      return "";
    default:
      return e satisfies never;
  }
}

function header(s: SessionInfo, read: SessionReadResult): string {
  const title = s.title === undefined ? "" : ` "${s.title}"`;
  const active = s.lastActiveMs === undefined ? "" : `, last active ${when(s.lastActiveMs)}`;
  const lines = [`Session ${s.id}${title} in ${s.cwd}`, `Started ${when(s.createdAtMs)}${active}.`];

  if (read.problem !== undefined)
    lines.push(`Its journal fails verification (${read.problem}); only the entries before that are shown.`);

  return lines.join("\n");
}

export type RenderOptions = { fromSeq?: number; budgetTokens: number; signal?: AbortSignal };

/**
 * A page of a session's journal from `fromSeq`, within `budgetTokens`. It
 * ends by saying where the next page starts, or that the journal ends.
 */
export async function renderSession(read: SessionReadResult, blob: Blob, opts: RenderOptions): Promise<string> {
  const from = Math.max(1, opts.fromSeq ?? 1);
  const effects = new Map<number, Effect>();
  const ran = new Set<string>();

  for (const entry of read.entries) {
    const e = entry.event;

    if (e.type === "effectStarted") {
      effects.set(e.effect, { start: entry, record: e.record, finished: false });
      ran.add(e.callId);
    }

    const started = e.type === "effectFinished" ? effects.get(e.effect) : undefined;

    if (started) started.finished = true;
  }

  const last = read.entries.at(-1)?.seq ?? 0;
  const top = header(read.session, read);
  const blocks: string[] = [];
  // Room for the header and the closing line.
  let left = opts.budgetTokens - tokens(top) - 40;
  let next: number | undefined;

  for (const entry of read.entries) {
    if (entry.seq < from) continue;
    opts.signal?.throwIfAborted();
    const text = await block(entry, effects, ran, blob);

    if (text === "") continue;
    const cost = tokens(text) + 1;

    if (cost > left) {
      if (blocks.length > 0) {
        next = entry.seq;
        break;
      }

      // A page always shows something: a first block too large on its own is cut to fit.
      blocks.push(cut(text, Math.max(200, left * 4)));
      next = read.entries.find((x) => x.seq > entry.seq)?.seq;
      break;
    }

    blocks.push(text);
    left -= cost;
  }

  const shown = blocks.length === 0 ? "Nothing to show from there." : blocks.join("\n");

  const end =
    next !== undefined
      ? `[More: this page ends before #${next} of ${last}. Call read_session with fromSeq ${next} to read on.]`
      : `[End of the journal, at #${last}.]`;

  return `${top}\n\n${shown}\n\n${end}`;
}

/**
 * Work sessions as list_sessions shows them: the most recent, numbered in
 * the order they started. Read as a story (a mistake, then its correction),
 * the order matters, and a model reading "newest first" took the list for
 * that order anyway.
 */
export function renderSessions(cwd: string, sessions: SessionInfo[], sinceMs: number | undefined): string {
  if (sessions.length === 0) return `There are no work sessions in ${cwd} yet.`;
  const MAX = 50;
  const since = sinceMs === undefined ? "" : ` "new" marks those active since you last looked (${when(sinceMs)}).`;
  const recent = sessions.toSorted((a, b) => b.createdAtMs - a.createdAtMs).slice(0, MAX);

  const lines = recent.toReversed().map((s, i) => {
    const title = s.title === undefined ? "(no prompt yet)" : `"${s.title}"`;
    const active = s.lastActiveMs ?? s.createdAtMs;
    const isNew = sinceMs !== undefined && active > sinceMs ? " [new]" : "";

    return `${i + 1}. ${s.id} ${title}, started ${when(s.createdAtMs)}, last active ${when(active)}${isNew}`;
  });

  const more = sessions.length > MAX ? `(${sessions.length - MAX} older sessions not shown)\n` : "";

  return `Work sessions in ${cwd}, in the order they started: 1 is the earliest shown.${since}\n${more}${lines.join("\n")}`;
}
