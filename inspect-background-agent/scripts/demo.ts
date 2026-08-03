import {
  brandString,
  createInspect,
  localPorts,
} from "../src/index.js";

async function main() {
  const ports = await localPorts({
    syncDelayMs: 40,
    repos: [{ owner: "acme", name: "billing" }],
  });
  const inspect = await createInspect(ports);
  const ws = await inspect.workspace({ owner: "acme", name: "billing" });
  const ana = {
    id: brandString<"ActorId">("ana"),
    display: "Ana",
    github: "ana",
  };
  ws.hint({ kind: "composing", actorId: ana.id });
  const session = await ws.start({
    opener: ana,
    conversation: { surface: "web", key: "cli-demo" },
    intent: "Fix the flaky invoice rounding test",
  });

  for await (const env of session.events()) {
    const e = env.event;
    if (e.kind === "agent.delta") process.stdout.write(e.text);
    else console.log(`[${env.seq}:${env.origin}] ${e.kind}`);
    if (e.kind === "turn.finished") break;
  }

  const pr = await session.publish({ by: ana.id });
  console.log("PR", pr.url);
  console.log("IDE", await session.ideUrl());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
