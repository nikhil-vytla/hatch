// A session as the desktop app shows it, folded from its journal entries:
// the conversation, spend, checkpoints and recent activity.
import type { ApprovalMode, EffectRecord, Entry } from "@strive/protocol";
import { Spend } from "@strive/view";
import { Conversation, label } from "./conversation";

export type Activity = { effect: number; what: string; outcome?: "done" | "failed" | "refused" };

/** A layout change the agent proposed, as JSON to parse (it comes from the model). */
export type Proposal = { key: string; label: string; json: string };

export class SessionModel {
  readonly conversation: Conversation;
  /** The model the agent last called. */
  modelName?: string;
  /** The session's directory, which paths are shown from. */
  workspace?: string;
  /** Reply text still streaming in, not yet journaled. */
  live = "";
  readonly spend = new Spend();
  readonly checkpoints: { n: number; label: string }[] = [];
  readonly activity: Activity[] = [];
  readonly proposals: Proposal[] = [];
  mode: ApprovalMode = "autoEdit";
  working = false;
  private lastSeq = 0;
  private labelNext?: number;

  constructor(
    private readonly sessionId: string,
    home?: string,
  ) {
    this.conversation = new Conversation(home);
  }

  /** Folds an entry in; false for one already seen. */
  apply(entry: Entry): boolean {
    if (entry.seq <= this.lastSeq) return false;
    this.lastSeq = entry.seq;
    this.spend.apply(entry.event);
    const e = entry.event;

    this.conversation.apply(entry);

    switch (e.type) {
      case "approvalModeSet":
        this.mode = e.mode;
        break;
      case "layoutProposed":
        this.proposals.push({
          key: `${this.sessionId}:${entry.seq}`,
          label: e.label,
          json: JSON.stringify({ label: e.label, ops: e.ops }),
        });
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
      case "sessionStarted":
        this.workspace = e.cwd;
        break;
      case "effectStarted":
        this.activity.push({ effect: e.effect, what: activity(e.record, this.workspace) });
        break;
      case "modelCallStarted":
        this.modelName = e.model;
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

function activity(r: EffectRecord, workspace?: string): string {
  return r.kind === "bash" ? `$ ${label(r, workspace)}` : `${r.kind} ${label(r, workspace)}`;
}
