// Cited journal entries as the Learned pane draws them under a piece of
// evidence: who did what, in a few words, and the text itself.
import type { Entry } from "@strive/protocol";
import { describe } from "@strive/view";
import type { Cited } from "../shared/cited";
import { label } from "./conversation";

export type Block = {
  seq: number;
  /** Whether the evidence names this entry, rather than it being the other half of an effect it names. */
  cited: boolean;
  /** Who did what: "You", "Agent", "Ran", "Result of #4". */
  who: string;
  /** The text: a prompt, a reply (markdown), a command or path, or a result's exit. */
  text: string;
  style: "prose" | "markdown" | "code";
  /** A finished effect's output, as the agent was shown it. */
  output?: string;
};

const DID: Record<Extract<Entry["event"], { type: "effectStarted" }>["record"]["kind"], string> = {
  bash: "Ran",
  check: "Checked",
  extension: "Called",
  read: "Read",
  edit: "Edited",
  write: "Wrote",
  mcp: "Called",
};

export type Shown = {
  blocks: Block[];
  /** Cited seqs the session's journal doesn't have. */
  missing: number[];
};

/** The picked entries as blocks, for evidence citing `seqs`. */
export function blocks({ entries, outputs }: Cited, seqs: readonly number[], cwd?: string): Shown {
  const cited = new Set(seqs);
  const started = new Map<number, number>();
  const out: Block[] = [];

  for (const entry of entries) {
    const e = entry.event;
    const at = { seq: entry.seq, cited: cited.has(entry.seq) };

    switch (e.type) {
      case "userMessage":
        out.push({ ...at, who: "You", text: e.text, style: "prose" });
        break;
      case "assistantMessage": {
        const tools = e.toolCalls.map((t) => t.name).join(", ");
        const text = e.text.trim() || (tools ? `Called ${tools}.` : "Replied with nothing.");
        out.push({ ...at, who: "Agent", text, style: "markdown" });
        break;
      }

      case "effectStarted":
        started.set(e.effect, entry.seq);
        out.push({ ...at, who: DID[e.record.kind], text: label(e.record, cwd), style: "code" });
        break;
      case "effectFinished": {
        const of = started.get(e.effect);
        const who = of === undefined ? "Result" : `Result of #${of}`;
        const o = e.outcome;

        if (o.kind === "done") {
          const exit = o.exitCode === undefined ? "Done" : `Exit ${o.exitCode}`;
          const output = outputs[o.output];
          const kept = o.truncated ? "\n[the daemon kept only part of this output]" : "";

          if (output === undefined) out.push({ ...at, who, text: `${exit}; its output isn't kept`, style: "prose" });
          else if (!output.trim()) out.push({ ...at, who, text: `${exit}, no output`, style: "prose" });
          else out.push({ ...at, who, text: exit, style: "prose", output: `${output.trimEnd()}${kept}` });
        } else {
          const text = o.kind === "refused" ? `Refused: ${o.reason}` : "Cut off: the daemon stopped while it ran";
          out.push({ ...at, who, text, style: "prose" });
        }

        break;
      }

      default: {
        const text = describe(entry)
          .map((l) => l.text)
          .join("\n");

        out.push({ ...at, who: "Note", text: text || `A ${e.type} entry, with nothing to show.`, style: "prose" });
      }
    }
  }

  const present = new Set(entries.map((e) => e.seq));

  return { blocks: out, missing: seqs.filter((s) => !present.has(s)) };
}
