// Rebuilds the agent's conversation from the session journal. The journal
// is the only source: prompts are the user's messages, replies are the
// messages the host recorded, and tool results come from the daemon's own
// effect records (what actually ran), never from the host.
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EffectOutcome, EffectRecord, Entry } from "@strive/protocol";

/** How an effect's outcome reads to the model. */
export function resultText(
  record: EffectRecord,
  outcome: EffectOutcome,
  output: string,
): { text: string; isError: boolean } {
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

export async function rebuild(entries: Entry[], blob: (digest: string) => Promise<string>): Promise<Message[]> {
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

  const messages: Message[] = [];
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
  for (const { event: e, tsMs } of entries) {
    if (e.type === "userMessage") {
      close();
      messages.push({ role: "user", content: e.text, timestamp: tsMs });
    } else if (e.type === "assistantMessage") {
      close();
      messages.push(e.message as AssistantMessage);
      open = e.toolCalls.map((c) => ({ ...c, ts: tsMs }));
    }
  }
  close();
  return messages;
}
