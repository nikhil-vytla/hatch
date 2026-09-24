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
  /** The model a person chose for the session, before its first prompt. */
  chosenModel?: string;
  /** Whether the session has a prompt: from then on its model is fixed. */
  prompted = false;
  /** The session's directory, which paths are shown from. */
  workspace?: string;
  /** Counts events after which the files may differ: a finished effect, a rewind, a turn's end. */
  filesVersion = 0;
  /** Reply text still streaming in, not yet journaled. */
  live = "";
  readonly spend = new Spend();
  readonly checkpoints: { n: number; label: string }[] = [];
  /** The checkpoint taken just before each prompt, by the prompt's seq: what rewinding to it restores. */
  readonly before = new Map<number, number>();
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
      case "modelSet":
        this.chosenModel = e.model;
        break;
      case "userMessage":
        this.prompted = true;

        if (this.labelNext !== undefined) {
          this.label(this.labelNext, `before “${e.text}”`);
          this.before.set(entry.seq, this.labelNext);
        }

        this.labelNext = undefined;
        break;
      case "rewound":
        this.filesVersion++;
        this.label(e.savedAs, `before rewinding to ${e.to}`);
        break;
      case "turnStarted":
        this.working = true;
        break;
      case "turnEnded":
        this.filesVersion++;
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
        this.filesVersion++;
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
