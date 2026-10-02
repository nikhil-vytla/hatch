// A scripted model for a free plumbing check of the Harbor adapter: it
// solves Harbor's hello-world task (one command, then a reply), so a run
// shows strive installs, runs, is scored and reports usage, with no
// provider called. Prints the port; the container reaches it through the
// container engine's host alias:
//
//   bun bench/harbor/smoke-model.ts &
//   STRIVE_UPSTREAM_ANTHROPIC=http://host.containers.internal:PORT ANTHROPIC_API_KEY=sk-smoke \
//     PYTHONPATH=bench/harbor harbor run -t hello-world/hello-world -a strive_agent:Strive
import { FakeAnthropic } from "../../packages/testkit/src/fake-anthropic";

const fake = new FakeAnthropic((request) =>
  JSON.stringify(request.messages.at(-1)?.content).includes("tool_result")
    ? { text: "Wrote hello.txt.", inputTokens: 1200, outputTokens: 8 }
    : {
        toolCalls: [{ id: "toolu_smoke", name: "bash", input: { command: "echo 'Hello, world!' > hello.txt" } }],
        inputTokens: 1000,
        outputTokens: 30,
      },
).start();

console.log(new URL(fake.url).port);
