# Inspect (candidate 1) — usage

A background coding agent, shaped as one long-lived **session actor** per session. The
actor owns the prompt queue, the realtime event stream, the sandbox handle, and
authorship. Clients — web, Slack, a future extension — are thin translation layers:
they turn their transport into commands and render the event stream back out. No
client ever coordinates warming, git sync, or snapshots.

Public surface, in full: `SessionHub` (create / get / warmHint / routeWebhook) and
`SessionHandle` (view / enqueue / stop / resumeQueue / events / openPullRequest /
close). Everything else is an internal port.

## Quickstart (local, no credentials)

```ts
import { createLocalInspect } from "inspect/local";
import { authorId } from "inspect/core";

// Fake fleet (temp dirs + real git), scripted agent, in-memory GitHub. Same hub API
// as production; only the adapters differ.
const { hub } = createLocalInspect();

const session = await hub.create({
  repo: { owner: "acme", name: "billing" },
  author: { id: authorId("u_ana"), ghLogin: "ana", display: "Ana" },
  source: "web",
  firstPrompt: "Fix the flaky invoice rounding test",
});

// One stream carries everything: gate transitions, agent deltas, pushes, PR lifecycle.
for await (const { seq, event } of session.events()) {
  console.log(seq, event.kind);
  if (event.kind === "prompt.finished") break;
}

// Branch was already pushed from the sandbox; the PR opens with Ana's token, not the
// app's. Idempotent: calling twice returns the same PR.
const pr = await session.openPullRequest({ requestedBy: authorId("u_ana") });
console.log(pr.url);
```

Things the caller did **not** do: pick a warm sandbox vs. snapshot boot, wait for git
sync, block the agent's write tools until sync finished, snapshot on idle, or map a
webhook to this session. The actor and its ports own all of that.

## Call site 1 — web client routes

The web client is ~40 lines of translation. Note `warmHint` fired on keystroke (before
the user even submits) and `idempotencyKey`/`dedupeKey` so retried HTTP requests don't
double-create or double-enqueue.

```ts
// clients/web/routes.ts
app.post("/api/repos/:owner/:name/warm", (req, res) => {
  hub.warmHint({ owner: req.params.owner, name: req.params.name }); // fire-and-forget
  res.status(202).end();
});

app.post("/api/sessions", async (req, res) => {
  const session = await hub.create({
    repo: parseRepo(req.body.repo),
    author: authorFromCookie(req),
    source: "web",
    firstPrompt: req.body.prompt,
    idempotencyKey: req.body.requestId,
  });
  res.json({ id: session.id });
});

app.post("/api/sessions/:id/prompts", async (req, res) => {
  const session = mustGet(await hub.get(sessionId(req.params.id)));
  const promptId = await session.enqueue({
    author: authorFromCookie(req),
    source: "web",
    text: req.body.text,
    dedupeKey: req.body.requestId,
  });
  res.json({ promptId }); // works even if the session is hibernated: actor revives it
});

app.ws("/api/sessions/:id/events", async (ws, req) => {
  const session = mustGet(await hub.get(sessionId(req.params.id)));
  const since = req.query.since ? eventSeq(Number(req.query.since)) : undefined;
  for await (const envelope of session.events({ since })) {
    ws.send(JSON.stringify(envelope)); // reconnect = same route with ?since=lastSeq
  }
});

app.post("/api/sessions/:id/stop", async (req, res) => {
  const session = mustGet(await hub.get(sessionId(req.params.id)));
  await session.stop(authorFromCookie(req).id); // cancels run, pauses queue
  res.status(202).end();
});
```

## Call site 2 — Slack adapter

Thread-to-session mapping is Slack-transport knowledge, so the adapter owns it. A
reply in a known thread is a prompt on that session — multiplayer falls out for free
because `enqueue` carries the author and the actor attributes prompts, commits, and
PR co-authorship from those records.

```ts
// clients/slack/adapter.ts — inside SlackClientAdapter
async handleMessage(msg: SlackInboundMessage): Promise<void> {
  const existing = await this.threads.get(msg.thread);
  if (existing) {
    const session = await this.hub.get(existing);
    await session?.enqueue({
      author: msg.author, source: "slack", text: msg.text, dedupeKey: msg.eventId,
    });
    return; // rendering already running via follow() below
  }

  const repo = await this.classifier.classify(msg.text, msg.ctx);
  if (!repo) return this.slack.post(msg.thread, cantClassifyBlocks());

  const session = await this.hub.create({
    repo, author: msg.author, source: "slack",
    firstPrompt: msg.text, idempotencyKey: msg.eventId,
  });
  await this.threads.set(msg.thread, session.id);
  void this.follow(session, msg.thread); // renders SessionEvents → Block Kit until closed
}
```

The agent's "post status to Slack" tool never touches Slack: it emits an
`agent.status` event on the session stream, and `follow()` renders it — the same event
shows up in the web UI without extra wiring.

## Call site 3 — GitHub webhook

Branch names derive from session ids (`inspect/{sessionId}`), so routing a webhook is
a pure function — no branch→session table to keep in sync.

```ts
// clients/web/webhooks.ts
app.post("/api/github/webhook", async (req, res) => {
  const parsed = github.parseWebhook({ headers: req.headers, body: req.rawBody });
  if (parsed.kind === "invalid") return res.status(400).end();
  if (parsed.kind === "ignored") return res.status(202).end();
  await hub.routeWebhook(parsed); // derives SessionId from branch; unknown → dropped
  res.status(202).end();          // pr merged/closed → actor transitions to closed
});
```

## Inside the sandbox (for orientation, not a public API)

The agent runtime adapter maps `SessionCapabilities` — granted by the actor when it
opens the agent connection — onto OpenCode plugins: `caps.gate()` backs a
`tool.execute.before` hook that rejects write/edit tools while the gate is `syncing`
(reads pass); `caps.postStatus` becomes the status tool; `caps.spawnChild` /
`caps.childStatus` become the fan-out tools, which loop back into `hub.create`.
