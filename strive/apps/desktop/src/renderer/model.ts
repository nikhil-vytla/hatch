// A session as the desktop app shows it, folded from its journal entries:
// the transcript, spend, approvals waiting, checkpoints and recent activity.
import type { ApprovalMode, Entry } from "@strive/protocol";
import { describe, type Line, Spend } from "@strive/view";

export type TranscriptLine = Line & { seq: number };

export type Activity = { effect: number; what: string; outcome?: "done" | "failed" | "refused" };

export class SessionModel {
  lines: TranscriptLine[] = [];
  /** Reply text still streaming in, not yet journaled. */
  live = "";
  readonly spend = new Spend();
  /** Effects waiting for a person, by effect number. */
  readonly pending = new Map<number, string>();
  readonly checkpoints: { n: number; label: string }[] = [];
  readonly activity: Activity[] = [];
  mode: ApprovalMode = "autoEdit";
  working = false;
  private lastSeq = 0;
  private labelNext?: number;

  constructor(private readonly home?: string) {}

  /** Folds an entry in; false for one already seen. */
  apply(entry: Entry): boolean {
    if (entry.seq <= this.lastSeq) return false;
    this.lastSeq = entry.seq;
    this.spend.apply(entry.event);
    const e = entry.event;

    for (const line of describe(entry, { home: this.home })) this.lines.push({ ...line, seq: entry.seq });

    switch (e.type) {
      case "approvalRequested":
        this.pending.set(e.effect, e.description);
        break;
      case "approvalDecided":
        this.pending.delete(e.effect);
        break;
      case "approvalModeSet":
        this.mode = e.mode;
        break;
      case "checkpointed":
        this.checkpoints.push({ n: e.checkpoint, label: "" });
        this.labelNext = e.checkpoint;
        break;
      case "userMessage":
        if (this.labelNext !== undefined) this.label(this.labelNext, `before “${e.text}”`);
        this.labelNext = undefined;
        break;
      case "rewound":
        this.label(e.savedAs, `before rewinding to ${e.to}`);
        break;
      case "turnStarted":
        this.working = true;
        break;
      case "turnEnded":
        this.working = false;
        this.live = "";
        break;
      case "assistantMessage":
        this.live = "";
        break;
      case "effectStarted":
        this.activity.push({ effect: e.effect, what: this.lines.at(-1)?.text ?? "" });
        break;
      case "effectFinished": {
        const a = this.activity.find((x) => x.effect === e.effect);

        if (a) a.outcome = e.outcome.kind === "done" ? "done" : e.outcome.kind === "refused" ? "refused" : "failed";
        break;
      }

      default:
        break;
    }

    return true;
  }

  private label(n: number, label: string) {
    const c = this.checkpoints.find((x) => x.n === n);

    if (c) c.label = label;
  }
}
