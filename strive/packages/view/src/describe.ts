// What each journal entry looks like in a transcript, for every client: the
// TUI and the desktop app render the same lines, each in its own way.
import type { Entry } from "@strive/protocol";
import { formatUsd } from "./format";

/** How a line reads: emphasis, not colour, so each client picks its own. */
export type Tone = "plain" | "accent" | "muted" | "faint" | "danger";

/** A prompt the user sent, the agent's reply, or anything else as a note. */
export type LineKind = "prompt" | "reply" | "note";

export type Line = { kind: LineKind; tone: Tone; text: string };

export const MODE_NAMES = { ask: "ask", autoEdit: "auto-edit", fullAuto: "full-auto" } as const;

export type DescribeOptions = {
  /** The user's home directory, shown as `~` in paths. */
  home?: string;
};

const note = (tone: Tone, text: string): Line[] => [{ kind: "note", tone, text }];

export function budgetText(usd?: number, tokens?: number): string {
  if (usd === undefined && tokens === undefined) return "unlimited";

  const parts: string[] = [];

  if (usd !== undefined) parts.push(formatUsd(usd));

  if (tokens !== undefined) parts.push(`${tokens} tokens`);

  return parts.join(" and ");
}

/** The lines an entry adds to a transcript; none for entries that add nothing. */
export function describe(entry: Entry, options: DescribeOptions = {}): Line[] {
  const e = entry.event;
  const home = options.home;
  const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);

  switch (e.type) {
    case "sessionStarted":
      return note("faint", `Session started in ${tilde(e.cwd)}`);
    case "userMessage":
      return [{ kind: "prompt", tone: "plain", text: e.text }];
    case "recovered":
      return note("danger", `Recovered after a crash: discarded a partial entry (${e.discardedBytes} bytes).`);
    case "budgetSet":
      return note("faint", `Budget: ${budgetText(e.usdMicros, e.tokens)}`);
    case "modelCallStarted":
      return [];
    case "modelCallFinished":
      switch (e.outcome.kind) {
        case "complete":
          return note(
            "faint",
            `${e.outcome.usage.input} in · ${e.outcome.usage.output} out · ${formatUsd(e.outcome.costUsdMicros)}`,
          );
        case "rejected":
          return note("danger", `The provider refused the call (HTTP ${e.outcome.status}).`);
        case "broken":
          return note(
            "danger",
            `The call broke (${e.outcome.reason}); charged its full hold of ${formatUsd(e.outcome.costUsdMicros)}.`,
          );
        default:
          return e.outcome satisfies never;
      }

    case "effectStarted": {
      const r = e.record;

      switch (r.kind) {
        case "bash":
          return note("muted", `$ ${r.command}`);
        case "write":
          return note("muted", `write ${r.path} (${r.bytes} bytes)`);
        case "read":
        case "edit":
          return note("muted", `${r.kind} ${r.path}`);
        case "mcp":
          return note("muted", `${r.server}: ${r.tool}`);
        default:
          return r satisfies never;
      }
    }

    case "effectFinished":
      switch (e.outcome.kind) {
        case "done":
          return e.outcome.exitCode === undefined || e.outcome.exitCode === 0
            ? []
            : note("faint", `exit ${e.outcome.exitCode}`);
        case "refused":
          return note("danger", `Refused: ${e.outcome.reason}`);
        case "interrupted":
          return note("danger", "Interrupted: the daemon stopped while this ran.");
        default:
          return e.outcome satisfies never;
      }

    case "approvalModeSet":
      return note("faint", `Approvals: ${MODE_NAMES[e.mode]}`);
    case "checkpointed":
      return note("faint", `Checkpoint ${e.checkpoint}`);
    case "rewound":
      return note("accent", `Rewound to checkpoint ${e.to}. Undo with /rewind ${e.savedAs}.`);
    case "turnStarted":
      return [];
    case "contextLoaded":
      // Only trouble is worth a line: a server that didn't start takes its tools with it.
      return e.mcp.flatMap((s) =>
        s.error === undefined ? [] : note("danger", `MCP server ${s.server} didn't start: ${s.error}`),
      );
    case "modelSet":
      return note("faint", `Model: ${e.model}`);
    case "compacted":
      return note("faint", "Summarized the conversation so far to keep it within the model's context.");
    case "layoutProposed":
      return note(
        "accent",
        `The agent proposed a layout change: ${e.label}. Review it in the desktop app (strive app).`,
      );
    case "assistantMessage": {
      const text = e.text.trim();

      return text ? [{ kind: "reply", tone: "plain", text }] : [];
    }

    case "turnEnded":
      switch (e.reason.kind) {
        case "done":
          return [];
        case "interrupted":
          return note("muted", "Interrupted.");
        case "timedOut":
          return note("danger", `Stopped: the turn reached its ${e.reason.seconds}s limit.`);
        case "failed":
          return note("danger", `The agent stopped: ${e.reason.error}`);
        default:
          return e.reason satisfies never;
      }

    case "approvalRequested":
      return note("muted", `The agent asked to ${e.description}`);
    case "approvalDecided": {
      const verb =
        e.decision === "deny"
          ? "Declined"
          : e.decision === "allowSession"
            ? "Allowed, and full-auto from here"
            : "Allowed";

      return note("faint", `${verb} by ${e.by}`);
    }

    // The learning session's own events: what the learner was asked, what it
    // proposed, and what became of each proposal.
    case "learnRequested":
      return note(
        "muted",
        e.sessions.length === 0
          ? "Asked to learn from recent sessions"
          : `Asked to learn from ${e.sessions.join(", ")}`,
      );
    case "proposalMade":
      return note("accent", `Proposed #${entry.seq}: ${e.proposal.summary}`);
    case "gateFinished":
      return note(
        e.verdict === "fail" ? "danger" : "faint",
        `#${e.proposal} ${e.gate} check: ${e.verdict}. ${e.detail}`,
      );
    case "proposalDecided":
      return note("muted", `#${e.proposal} ${e.decision === "accept" ? "accepted" : "rejected"} by ${e.by}`);
    case "proposalApplied":
      return note("accent", `#${e.proposal} applied`);
    case "proposalRolledBack":
      return note("muted", `#${e.proposal} rolled back by ${e.by}`);
    default:
      return e satisfies never;
  }
}
