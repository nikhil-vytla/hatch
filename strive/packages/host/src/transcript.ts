// Rebuilds the agent's conversation from the session journal. The journal
// is the only source: prompts are the user's messages, replies are the
// messages the host recorded, and tool results come from the daemon's own
// effect records (what actually ran), never from the host.
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EffectOutcome, EffectRecord, Entry } from "@strive/protocol";

export type ToolResultText = { text: string; isError: boolean };

/** How an effect's outcome reads to the model. */
export function resultText(record: EffectRecord, outcome: EffectOutcome, output: string): ToolResultText {
  switch (outcome.kind) {
    case "done": {
      const exit = record.kind === "bash" && outcome.exitCode !== undefined && outcome.exitCode !== 0;
      const sep = output === "" || output.endsWith("\n") ? "" : "\n";

      return { text: exit ? `${output}${sep}[exit code ${outcome.exitCode}]` : output, isError: false };
    }

    case "refused":
      return { text: outcome.reason, isError: true };
    case "interrupted":
      return { text: "the daemon stopped while this ran; whatever it changed stays changed", isError: true };
    default:
      return outcome satisfies never;
  }
}

const NOT_RUN = "this tool call did not run: the turn ended first";

/** The user message that stands in for a summarized part of the conversation. */
export function summaryMessage(summary: string, timestamp: number): Message {
  return { role: "user", content: `[A summary of the conversation so far]\n\n${summary}`, timestamp };
}

export async function rebuild(all: Entry[], blob: (digest: string) => Promise<string>): Promise<Message[]> {
  // The latest summary replaces everything it covers.
  const compacted = all.findLast((e) => e.event.type === "compacted");
  const entries = compacted ? all.filter((e) => e.seq > compacted.seq) : all;
  const records = new Map<number, { callId: string; record: EffectRecord }>();
  const results = new Map<string, { text: string; isError: boolean; ts: number }>();

  for (const { event: e, tsMs } of entries) {
    if (e.type === "effectStarted") records.set(e.effect, { callId: e.callId, record: e.record });

    if (e.type === "effectFinished") {
      const started = records.get(e.effect);

      if (!started) continue;
      const output = e.outcome.kind === "done" ? await blob(e.outcome.output) : "";
      results.set(started.callId, { ...resultText(started.record, e.outcome, output), ts: tsMs });
    }
  }

  const messages: Message[] =
    compacted?.event.type === "compacted" ? [summaryMessage(compacted.event.summary, compacted.tsMs)] : [];

  let open: { id: string; name: string; ts: number }[] = [];

  const close = () => {
    for (const call of open) {
      const r = results.get(call.id) ?? { text: NOT_RUN, isError: true, ts: call.ts };

      const result: ToolResultMessage = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: r.text }],
        isError: r.isError,
        timestamp: r.ts,
      };

      messages.push(result);
    }

    open = [];
  };

  // Prompts are held until the turn that sends them starts: one sent while
  // a turn runs is journaled mid-turn but reaches the model with the next
  // turn, together with any sent after this one ends.
  let inTurn = false;
  let held: Message[] = [];

  const release = () => {
    close();
    messages.push(...held);
    held = [];
  };

  for (const { event: e, tsMs } of entries) {
    if (e.type === "turnStarted") {
      release();
      inTurn = true;
    } else if (e.type === "turnEnded") {
      inTurn = false;
    } else if (e.type === "userMessage") {
      held.push({ role: "user", content: e.text, timestamp: tsMs });
    } else if (e.type === "assistantMessage") {
      // Without turn markers, a reply answers the prompts before it.
      if (inTurn) close();
      else release();
      // SAFETY: only the host writes assistantMessage entries, and it records pi-ai's
      // AssistantMessage as is (Host.record in host.ts); the daemon stores it untouched.
      const reply = e.message as AssistantMessage;
      messages.push(reply);
      // Providers drop an aborted or failed reply when it is sent back, so
      // results for its calls would answer calls the model never sees.
      const sent = reply.stopReason !== "aborted" && reply.stopReason !== "error";
      open = sent ? e.toolCalls.map((c) => ({ ...c, ts: tsMs })) : [];
    }
  }

  release();

  return messages;
}
