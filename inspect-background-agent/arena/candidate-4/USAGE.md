# `@hatch/inspect` — usage

A background coding agent you talk to from Slack, the web app, or anywhere else. You name a
repo and a task; you get a stream of progress and, eventually, a pull request authored by you.

The thing you hold is a **workspace**. A workspace is a repo plus everything expensive that
belongs to that repo: the image lineage, the warm pool of booted sandboxes, the snapshot store,
the GitHub App installation, the branch namespace, the webhook feed. Workspaces are long-lived
and shared.

A **session** is a short-lived lease on one slot in that workspace. Sessions are cheap, there
are many of them, and they end. Nothing a session does changes the workspace's supply of
compute — it only borrows from it.

You never boot a sandbox, never wait for a git sync, never take a snapshot, and never decide
whether a resume should come from the pool or from disk. Those are supply decisions and the
workspace owns them.

## Install and bootstrap

```ts
import { createInspect } from "@hatch/inspect";
import { localPorts } from "@hatch/inspect/adapters/local";

// Runs on a laptop with no Modal, no Cloudflare, no Slack, no GitHub App.
// Sandboxes are directories, snapshots are tarballs, the event bus is an EventTarget,
// and the agent is whatever you script.
const inspect = createInspect({ ports: await localPorts({ root: "./.inspect" }) });
```

The deployed wiring swaps adapters and nothing else:

```ts
import { createInspect } from "@hatch/inspect";
import { modalCompute, modalImages } from "@hatch/inspect/adapters/modal";
import { durableObjectStore, durableObjectBus } from "@hatch/inspect/adapters/cloudflare";
import { githubAppForge, githubIdentities } from "@hatch/inspect/adapters/github";
import { openCodeRuntime } from "@hatch/inspect/adapters/opencode";
import { llmRepoClassifier } from "@hatch/inspect/adapters/classifier";

const inspect = createInspect({
  ports: {
    compute: modalCompute(env),
    images: modalImages(env),
    store: durableObjectStore(env),
    bus: durableObjectBus(env),
    forge: githubAppForge(env),
    identities: githubIdentities(env),
    agent: openCodeRuntime({ serverUrl: env.OPENCODE_URL }),
    classifier: llmRepoClassifier({ model: "haiku" }),
    clock: systemClock(),
  },
});
```

`Inspect` is the only thing you construct. Everything else you get by asking it for a
workspace, and everything after that you get by asking the workspace for a session.

---

## Call site 1 — Slack

The whole Slack integration is one call. `dispatch` figures out which repo the message is
about, opens that workspace, finds or starts the session that belongs to this thread, adds
the speaker as a participant, and queues the prompt.

```ts
import { inspect } from "./inspect";
import { renderTurnCard, renderRepoPicker, renderNoRepo, renderPullRequest } from "./blocks";

slack.event("app_mention", async ({ event, client }) => {
  const dispatch = await inspect.dispatch({
    surface: "slack",
    conversation: { surface: "slack", channel: event.channel, thread: event.thread_ts ?? event.ts },
    speaker: await identityOf(event.user),
    text: event.text,
    hints: { channelName: channelNameOf(event.channel), recentText: await lastFewMessages(event) },
  });

  // The classifier is allowed to be unsure. That is a first-class answer, not an exception.
  if (dispatch.kind === "ambiguous") {
    await client.chat.postMessage(renderRepoPicker(event, dispatch.candidates));
    return;
  }
  if (dispatch.kind === "unroutable") {
    await client.chat.postMessage(renderNoRepo(event, dispatch.reason));
    return;
  }

  const { session, turn } = dispatch;
  const card = await client.chat.postMessage(renderTurnCard(event, turn));

  // Resumable stream. `from` is the only reconnect state a client keeps.
  for await (const ev of session.events({ from: turn.queuedSeq })) {
    switch (ev.type) {
      case "status":
        // The agent's own status tool. Free-form text it chose to surface to humans.
        await client.chat.update(renderTurnCard(event, turn, { status: ev.text, emoji: ev.emoji }));
        break;
      case "turn.finished":
        if (ev.turnId === turn.id) await client.chat.update(renderTurnCard(event, turn, { done: ev.status }));
        break;
      case "pull_request":
        await client.chat.postMessage(renderPullRequest(event, ev.pullRequest));
        return;
    }
  }
});
```

Notes on what is *not* in that snippet: no repo id, no workspace id, no sandbox handle, no
sync state, no "is the pool warm" check, no session id bookkeeping. A second engineer replying
in the same thread hits the same `dispatch` call, is added to the participant roster, and
their prompt is appended to the same queue behind whatever is running.

Stopping is the same shape:

```ts
slack.action("stop", async ({ body, ack }) => {
  await ack();
  const session = await inspect.locate({ by: "conversation", ref: conversationOf(body) });
  await session?.stop({ by: await identityOf(body.user.id), scope: "current-turn" });
});
```

`stop` is idempotent. Pressing it twice, or pressing it after the turn already finished, is a
no-op that resolves.

---

## Call site 2 — web app server

The web app is a second, equally thin client. It differs from Slack only in what it renders.

```ts
import { inspect } from "./inspect";

// The composer fires this on the first keystroke, before the user has finished typing.
// It is advisory: the workspace decides whether that justifies pre-booting a slot.
app.post("/api/repos/:owner/:name/warm", async (req, res) => {
  const ws = await inspect.workspace({ owner: req.params.owner, name: req.params.name });
  ws.hint({ kind: "composing", actor: req.actor });
  res.status(202).end(); // nothing to await; warming is supply-side, not request-side
});

app.post("/api/repos/:owner/:name/sessions", async (req, res) => {
  const ws = await inspect.workspace({ owner: req.params.owner, name: req.params.name });
  const session = await ws.start({
    opener: req.actor,
    intent: req.body.prompt,
    conversation: { surface: "web", key: req.body.clientSessionKey },
    base: req.body.base ?? undefined, // defaults to the workspace's default branch
  });
  res.json({ sessionId: session.id, view: await session.view() });
});

app.post("/api/sessions/:id/prompts", async (req, res) => {
  const session = await inspect.locate({ by: "id", id: req.params.id as SessionId });
  if (!session) return res.status(404).end();
  const turn = await session.submit({
    author: req.actor,
    text: req.body.text,
    clientToken: req.body.clientToken, // retries return the same turn instead of double-queueing
  });
  res.json(turn);
});
```

Streaming and reconnect. `view()` is the cold render for a page load; `events({ from })` is
the warm tail. Together they are the entire sync protocol a client needs — there is no
separate "catch me up" endpoint and no per-client replay buffer to manage.

```ts
app.get("/api/sessions/:id/stream", async (req, res) => {
  const session = await inspect.locate({ by: "id", id: req.params.id as SessionId });
  if (!session) return res.status(404).end();

  const from = req.query.from ? (Number(req.query.from) as EventSeq) : undefined;
  if (from === undefined) sse(res, { type: "view", view: await session.view() });
  for await (const ev of session.events({ from, signal: req.signal })) sse(res, ev);
});
```

Opening the PR is one call, and the PR belongs to the human:

```ts
app.post("/api/sessions/:id/pull-request", async (req, res) => {
  const session = await inspect.locate({ by: "id", id: req.params.id as SessionId });
  const pr = await session!.publish({ opener: req.actor, draft: req.body.draft ?? false });
  res.json(pr);
});
```

`publish` commits anything uncommitted under the correct git identity, pushes the session
branch with the App installation token, opens the PR with **`req.actor`'s** OAuth token, and
credits every participant whose turn produced a commit. Calling it twice returns the same PR.

Webhooks come back the other way and need no routing table on your side — the session branch
name is derived from the session id, so the workspace resolves the delivery itself:

```ts
app.post("/webhooks/github", async (req, res) => {
  await inspect.webhooks.deliver({
    signature: req.header("x-hub-signature-256") ?? "",
    event: req.header("x-github-event") ?? "",
    body: req.rawBody,
  });
  res.status(204).end();
});
```

Org stats for the dashboard read off the workspace, not off a session:

```ts
app.get("/api/stats", async (_req, res) => {
  res.json(await inspect.stats({ windowMs: 7 * 24 * 3600_000 }));
});
```

---

## Call site 3 — local test harness

The point of this one is that it needs no credentials and no network, and that the write gate
is observable rather than a comment in a doc.

```ts
import { createInspect } from "@hatch/inspect";
import { localPorts, fakeClock, scriptedAgent, gitFixture } from "@hatch/inspect/testing";

test("edits are blocked until the slot catches up with origin", async () => {
  const clock = fakeClock(0);
  const origin = await gitFixture({ files: { "src/a.ts": "export const a = 1;\n" } });

  const inspect = createInspect({
    ports: await localPorts({
      clock,
      origin,
      // The fake compute boots "stale" slots on purpose: their baked-in commit is 30 minutes
      // behind origin and the delta takes 500ms of fake time to apply.
      compute: { syncDelayMs: 500, staleBy: 30 * 60_000 },
      agent: scriptedAgent([
        { tool: "read", path: "src/a.ts" },                       // allowed immediately
        { tool: "edit", path: "src/a.ts", to: "export const a = 2;\n" }, // parks until sync lands
        { tool: "status", text: "patched, running tests" },
        { tool: "finish", summary: "bumped a" },
      ]),
    }),
  });

  const ws = await inspect.workspace(origin.repo);
  const session = await ws.start({ opener: alice, intent: "bump a to 2" });

  const seen: string[] = [];
  const done = (async () => {
    for await (const ev of session.events()) {
      if (ev.type === "slot.freshness") seen.push(ev.freshness.kind);
      if (ev.type === "turn.finished") break;
    }
  })();

  await clock.advance(1_000);
  await done;

  expect(seen).toEqual(["stale", "syncing", "fresh"]);
  expect(await origin.readAtHead("src/a.ts")).toContain("2"); // after publish
});
```

Child sessions, which the agent spawns from inside a turn, are ordinary sessions and show up
the same way — a client that renders `turn.delta` of kind `child` gets fan-out for free:

```ts
for await (const ev of parent.events()) {
  if (ev.type === "turn.delta" && ev.delta.kind === "child") {
    const child = await inspect.locate({ by: "id", id: ev.delta.sessionId });
    renderNestedPanel(child!); // same Session interface, same event stream
  }
}
```

---

## What the caller never sees

| Concern | Who handles it |
| --- | --- |
| Warm pool sizing, pre-boot on keystroke | workspace |
| Cold boot vs. pool hit vs. snapshot resume | workspace (lease acquisition) |
| Image rebuild cadence, pool expiry on new image | workspace |
| Git delta sync, read-early / write-block gate | slot |
| Snapshot on idle, resume on reply | workspace (lease release / re-acquire) |
| Leaked sandbox reclamation after a crash | workspace (lease TTL + reaper) |
| Which token clones vs. which token opens the PR | authorship |
| OpenCode plugins, tool interception, wire frames | agent adapter |

None of those appear as a parameter, a method, or a type on anything shown above.
