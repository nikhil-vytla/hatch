# Inspect hatch — usage (synthesized)

Background coding agent from Ramp's [Inspect post](https://builders.ramp.com/post/why-we-built-our-background-agent).

You hold a **workspace** (repo + image + warm pool + branch namespace). A **session** is a short lease on one slot plus the conversation. You never boot, sync, snapshot, or reclaim sandboxes yourself.

## Quickstart (local, no cloud credentials)

```ts
import { createInspect, localPorts } from "@hatch/inspect";

const inspect = createInspect(await localPorts({ root: "./.inspect" }));

const ws = await inspect.workspace({ owner: "acme", name: "billing" });
ws.hint({ kind: "composing", actorId: "ana" });

const session = await ws.start({
  opener: { id: "ana", display: "Ana", github: "ana" },
  conversation: { surface: "web", key: "demo-1" },
  intent: "Fix the flaky invoice rounding test",
});

for await (const ev of session.events()) {
  if (ev.event.kind === "agent.delta") process.stdout.write(ev.event.text);
  if (ev.event.kind === "turn.finished") break;
}

const pr = await session.publish({ by: "ana", title: "Fix invoice rounding" });
console.log(pr.url);
```

## Call site — Slack

```ts
const result = await inspect.dispatch({
  surface: "slack",
  conversation: { surface: "slack", channel, thread },
  speaker: actor,
  text: event.text,
  hints: { channelName, recentText },
});
if (result.kind === "ambiguous") return askWhichRepo(result.candidates);
if (result.kind === "unknown") return askForRepo();
// result.kind === "started" | "continued"
```

## Call site — multiplayer web

```ts
const session = await hub.get(sessionId); // or ws.start with same conversation
await session.submit({
  author: { id: "bea", display: "Bea", github: "bea" },
  text: "Also update the OpenAPI spec.",
  clientToken: requestId,
});
await session.stop({ by: "bea", scope: "current-turn" });
```

Callers never see Modal, Durable Object, or OpenCode wire types.
