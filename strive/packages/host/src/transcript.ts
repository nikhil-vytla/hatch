// Rebuilds the agent's conversation from the session journal. The journal
// is the only source: prompts are the user's messages, replies are the
// messages the host recorded, and tool results come from the daemon's own
// effect records (what actually ran), never from the host.
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EffectOutcome, EffectRecord, Entry } from "@strive/protocol";

/** What propose_layout tells the model, live and on resume. */
export const PROPOSED = "Proposed. The person will accept or reject it in the desktop app.";

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

/** An assistant message as pi-ai makes it, as far as replay relies on it. */
function isAssistantMessage(v: unknown): v is AssistantMessage {
  return (
    typeof v === "object" &&
    v !== null &&
    "role" in v &&
    v.role === "assistant" &&
    "content" in v &&
    Array.isArray(v.content)
  );
}

export async function rebuild(all: Entry[], blob: (digest: string) => Promise<string>): Promise<Message[]> {
  // The latest summary replaces everything it covers, except prompts no turn
  // had taken by then: those follow it, before the entries after it.
  const compacted = all.findLast((e) => e.event.type === "compacted");
  const upto = compacted?.event.type === "compacted" ? compacted.event.uptoSeq : 0;
  let taken = 0;

  for (const e of all) {
    if (e.seq <= upto && e.event.type === "turnStarted") taken = Math.max(taken, e.event.throughSeq ?? e.seq);
  }

  const entries = all.filter(
    (e) => e.seq > upto || (compacted !== undefined && e.seq > taken && e.event.type === "userMessage"),
  );

  const records = new Map<number, { callId: string; record: EffectRecord }>();
  const results = new Map<string, { text: string; isError: boolean; ts: number }>();

  for (const { event: e, tsMs } of entries) {
    if (e.type === "effectStarted") records.set(e.effect, { callId: e.callId, record: e.record });

    // A tool that runs no effect: its journaled entry is its result.
    if (e.type === "layoutProposed" && e.callId !== undefined)
      results.set(e.callId, { text: PROPOSED, isError: false, ts: tsMs });

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
  let held: { seq: number; message: Message }[] = [];

  /** Releases held prompts up to `through` (all of them without it). */
  const release = (through = Number.POSITIVE_INFINITY) => {
    close();
    messages.push(...held.filter((h) => h.seq <= through).map((h) => h.message));
    held = held.filter((h) => h.seq > through);
  };

  for (const { event: e, tsMs, seq } of entries) {
    if (e.type === "turnStarted") {
      release(e.throughSeq);
      inTurn = true;
    } else if (e.type === "turnEnded") {
      inTurn = false;
    } else if (e.type === "userMessage") {
      held.push({ seq, message: { role: "user", content: e.text, timestamp: tsMs } });
    } else if (e.type === "assistantMessage") {
      const reply = e.message;

      // A host wrote it, and a host can be wrong: what isn't a reply is left out.
      if (!isAssistantMessage(reply)) continue;

      // Without turn markers, a reply answers the prompts before it.
      if (inTurn) close();
      else release();
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
