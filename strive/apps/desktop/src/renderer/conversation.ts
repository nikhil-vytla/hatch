// The transcript as the desktop app draws it, folded from journal entries:
// prompts, replies, the tools each step ran (with their approvals), a line
// for each finished turn, and notices for everything else.
import type { Decision, Digest, EffectRecord, Entry, TurnEnd } from "@strive/protocol";
import { describe, type Line, sessionAllowance } from "@strive/view";

export type ToolStatus = "running" | "waiting" | "done" | "failed" | "refused" | "interrupted";

export type Tool = {
  effect: number;
  record: EffectRecord;
  status: ToolStatus;
  exitCode?: number;
  /** What the agent was shown, in the content store. */
  output?: Digest;
  truncated?: boolean;
  /** Why it was refused. */
  reason?: string;
  /**
   * What the agent asked a person, while it waits or once decided; `oneFile`
   * when allowing for the session covers only one thing (`allowance`), not
   * full-auto.
   */
  approval?: { description: string; oneFile: boolean; allowance: string; decided?: Decision };
  durationMs?: number;
};

export type Item =
  | { kind: "user"; seq: number; text: string }
  | { kind: "reply"; seq: number; text: string }
  | { kind: "tools"; seq: number; tools: Tool[] }
  | { kind: "turn"; seq: number; reason: TurnEnd; durationMs: number; costUsdMicros: number }
  | { kind: "notice"; seq: number; tone: Line["tone"]; text: string };

/** Events drawn as items of their own, or folded into one; the rest become notices. */
const OWN = new Set([
  "userMessage",
  "assistantMessage",
  "effectStarted",
  "effectFinished",
  "approvalRequested",
  "approvalDecided",
  "turnStarted",
  "turnEnded",
  "modelCallStarted",
  "checkpointed",
  // The composer shows these as they stand.
  "approvalModeSet",
  "budgetSet",
  "modelSet",
]);

export class Conversation {
  readonly items: Item[] = [];
  private readonly tools = new Map<number, Tool>();
  private turn?: { startedMs: number; costUsdMicros: number };
  private readonly home?: string;

  constructor(home?: string) {
    this.home = home;
  }

  apply(entry: Entry): void {
    const e = entry.event;

    switch (e.type) {
      case "userMessage":
        this.items.push({ kind: "user", seq: entry.seq, text: e.text });

        return;
      case "assistantMessage": {
        const text = e.text.trim();

        if (text) this.items.push({ kind: "reply", seq: entry.seq, text });

        return;
      }

      case "effectStarted": {
        const tool: Tool = { effect: e.effect, record: e.record, status: "running" };
        this.tools.set(e.effect, tool);
        const last = this.items.at(-1);

        if (last?.kind === "tools") last.tools.push(tool);
        else this.items.push({ kind: "tools", seq: entry.seq, tools: [tool] });

        return;
      }

      case "effectFinished": {
        const tool = this.tools.get(e.effect);

        if (!tool) return;
        tool.durationMs = e.durationMs;
        const o = e.outcome;

        if (o.kind === "done") {
          tool.status = o.exitCode === undefined || o.exitCode === 0 ? "done" : "failed";
          tool.exitCode = o.exitCode;
          tool.output = o.output;
          tool.truncated = o.truncated;
        } else if (o.kind === "refused") {
          tool.status = "refused";
          tool.reason = o.reason;
        } else {
          tool.status = "interrupted";
        }

        return;
      }

      case "approvalRequested": {
        const tool = this.tools.get(e.effect);

        if (tool) {
          tool.status = "waiting";
          tool.approval = {
            description: e.description,
            oneFile: e.sessionFile !== undefined,
            allowance: sessionAllowance(e.sessionFile),
          };
        }

        return;
      }

      case "approvalDecided": {
        const tool = this.tools.get(e.effect);

        if (tool?.approval) {
          tool.approval.decided = e.decision;

          if (tool.status === "waiting") tool.status = "running";
        }

        return;
      }

      case "turnStarted":
        this.turn = { startedMs: entry.tsMs, costUsdMicros: 0 };

        return;
      case "modelCallFinished":
        if (this.turn && e.outcome.kind !== "rejected") this.turn.costUsdMicros += e.outcome.costUsdMicros;

        // Only a call that went wrong is worth a notice.
        if (e.outcome.kind !== "complete") this.notices(entry);

        return;
      case "turnEnded":
        this.notices(entry); // why it stopped, unless it finished
        this.items.push({
          kind: "turn",
          seq: entry.seq,
          reason: e.reason,
          durationMs: this.turn ? entry.tsMs - this.turn.startedMs : 0,
          costUsdMicros: this.turn?.costUsdMicros ?? 0,
        });
        this.turn = undefined;

        return;
      default:
        if (!OWN.has(e.type)) this.notices(entry);
    }
  }

  /** When the running turn started, while one runs. */
  get turnStartedMs(): number | undefined {
    return this.turn?.startedMs;
  }

  /** Waiting approvals, oldest first. */
  waiting(): Tool[] {
    return [...this.tools.values()].filter((t) => t.status === "waiting");
  }

  private notices(entry: Entry) {
    for (const line of describe(entry, { home: this.home }))
      this.items.push({ kind: "notice", seq: entry.seq, tone: line.tone, text: line.text });
  }
}

/** A step's tools in a few words: "Read 2 files · ran 1 command". */
export function summarize(tools: readonly Tool[]): string {
  const count = (kind: EffectRecord["kind"]) => tools.filter((t) => t.record.kind === kind).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  const parts = [
    count("bash") && `ran ${plural(count("bash"), "command", "commands")}`,
    count("edit") + count("write") && `edited ${plural(count("edit") + count("write"), "file", "files")}`,
    count("read") && `read ${plural(count("read"), "file", "files")}`,
    count("mcp") && `called ${plural(count("mcp"), "tool", "tools")}`,
  ].filter((p): p is string => typeof p === "string");

  const failed = tools.filter((t) => t.status === "failed" || t.status === "refused").length;

  if (failed > 0) parts.push(`${failed} failed`);
  const text = parts.join(" · ");

  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A path inside the workspace written from it; others as they are. */
export function relative(path: string, workspace?: string): string {
  if (!workspace) return path;

  const root = workspace.endsWith("/") ? workspace : `${workspace}/`;

  return path.startsWith(root) ? path.slice(root.length) : path === workspace ? "." : path;
}

/** One tool in a few words, for its row. Paths, and commands' mentions of the workspace, are relative to it. */
export function label(record: EffectRecord, workspace?: string): string {
  switch (record.kind) {
    case "bash":
      return workspace ? record.command.replaceAll(`${workspace}/`, "") : record.command;
    case "check":
      return `${record.name}: ${workspace ? record.command.replaceAll(`${workspace}/`, "") : record.command}`;
    case "read":
    case "edit":
    case "write":
      return relative(record.path, workspace);
    case "mcp":
      return `${record.server} · ${record.tool}`;
    default:
      return record satisfies never;
  }
}
