// A scripted model for a free plumbing check of the Harbor adapter: it
// solves Harbor's hello-world task (one command, then a reply), so a run
// shows strive installs, runs, is scored and reports usage, with no
// provider called. Prints the port; the container reaches it through the
// container engine's host alias:
//
//   bun bench/harbor/smoke-model.ts &
//   STRIVE_UPSTREAM_ANTHROPIC=http://host.containers.internal:PORT ANTHROPIC_API_KEY=sk-smoke \
//     PYTHONPATH=bench/harbor harbor run -t hello-world/hello-world -a strive_agent:Strive
//
// SMOKE_DELAY_MS=N holds the agent's replies (not the learner's) N ms, to
// check that a task that runs out of time still saves what was learned.
import { FakeAnthropic } from "../../packages/testkit/src/fake-anthropic";

const delayMs = Number(process.env.SMOKE_DELAY_MS ?? 0);

const fake = new FakeAnthropic((request) => {
  const agent = JSON.stringify(request.system ?? "").includes("a coding agent working in");
  const held = agent && delayMs > 0 ? { delayMs } : {};

  return JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
    ? { text: "Wrote hello.txt.", inputTokens: 1200, outputTokens: 8, ...held }
    : {
        toolCalls: [{ id: "toolu_smoke", name: "bash", input: { command: "echo 'Hello, world!' > hello.txt" } }],
        inputTokens: 1000,
        outputTokens: 30,
        ...held,
      };
}).start();

console.log(new URL(fake.url).port);
