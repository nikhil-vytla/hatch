// A scripted model for the eval's plumbing test (selfcheck.py --e2e): strive's
// FakeAnthropic, answering by what each request is. It prints its URL on the
// first line and serves until killed. No key, no network, no spend.
//
// - a work session (it has the bash tool): runs `./dev test`, then says done;
// - the learner (it has propose_change): proposes one memory bullet citing
//   the session it was asked to study, then reports;
// - the judge (it must call record_verdict): passes every criterion;
// - anything else (a summary): a short text.
//
// The learner's proposal is the whole-file form of today's protocol; when
// ADR-0022 makes memory proposals per bullet, only this script changes.
import { FakeAnthropic, type ModelRequest, type ScriptedReply } from "../../packages/testkit/src/fake-anthropic";

const tools = (req: ModelRequest): string[] => {
  const raw: unknown = (req as { tools?: unknown }).tools;

  return Array.isArray(raw) ? raw.map((t) => (typeof t === "object" && t && "name" in t ? String(t.name) : "")) : [];
};

/** Whether the request answers a tool call: the model's next step, not a new prompt. */
function afterToolResult(req: ModelRequest): boolean {
  const last = req.messages.at(-1)?.content;

  return (
    Array.isArray(last) && last.some((b) => typeof b === "object" && b !== null && "type" in b && b.type === "tool_result")
  );
}

function text(v: unknown): string {
  if (typeof v === "string") return v;

  if (Array.isArray(v)) return v.map(text).join("\n");

  if (typeof v === "object" && v !== null) {
    if ("text" in v && typeof v.text === "string") return v.text;

    if ("content" in v) return text(v.content);
  }

  return "";
}

/** The memory file as the learner's system prompt shows it; empty when there is none. */
function currentMemory(system: string): string {
  const m = system.match(/# Current memory \(\.strive\/memory\.md\)\n\n([\s\S]*?)\n\n# Project instructions/);

  if (!m?.[1] || m[1].startsWith("There is none yet.")) return "";

  return `${m[1].trim()}\n`;
}

function reply(req: ModelRequest): ScriptedReply {
  const names = tools(req);
  const answered = afterToolResult(req);

  if (req.tool_choice?.name === "record_verdict") {
    const pass = { pass: true, reason: "The cited entries show it." };

    return {
      toolCalls: [
        {
          id: "judge1",
          name: "record_verdict",
          input: {
            criteria: { supported: pass, generalizes: pass, novel: pass, safe: pass, checkable: pass },
            verdict: "pass",
            summary: "Supported by the cited session.",
          },
        },
      ],
    };
  }

  if (names.includes("propose_change")) {
    if (answered) return { text: "Read the session; proposed one memory bullet." };
    const asked = text(req.messages.at(-1)?.content);
    const session = asked.match(/Study these work sessions: ([^,.\s]+)/)?.[1] ?? "unknown";
    const memory = currentMemory(text(req.system));

    return {
      toolCalls: [
        {
          id: `p-${session}`,
          name: "propose_change",
          input: {
            artifact: { kind: "memory" },
            content: `${memory}- Run the tests with \`./dev test\`: it also runs the doctests (seen in session ${session}).\n`,
            summary: "Say how to run the tests",
            rationale: "The session ran the tests with ./dev test.",
            evidence: [{ session, seqs: [1, 2], note: "the session's start and its prompt" }],
            prediction: "Later sessions run ./dev test before finishing.",
          },
        },
      ],
    };
  }

  if (names.includes("bash")) {
    if (answered) return { text: "Done." };
    // The isolation probe tells the agent exactly what to run.
    const told = text(req.messages.at(-1)?.content).match(/^Run exactly this command: ([\s\S]+)$/);

    if (told?.[1]) return { toolCalls: [{ id: "t1", name: "bash", input: { command: told[1].trim() } }] };

    return { toolCalls: [{ id: "t1", name: "bash", input: { command: "./dev test" } }] };
  }

  return { text: "ok" };
}

const fake = new FakeAnthropic(reply).start();

console.log(fake.url);

process.on("SIGTERM", () => {
  fake.stop();
  process.exit(0);
});
