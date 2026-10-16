# Inspect hatch — capability-token API

Axis **C**: callers never hold a god-session. A factory mints narrow capability handles (`PromptHandle`, `SandboxHandle`, `EventCursor`, `PullRequestHandle`). Each handle is an opaque authority token plus a small method surface. Warm, git sync, snapshot, and agent wiring stay behind those methods.

Wire types from Modal, Durable Objects, OpenCode, Slack, and GitHub never appear on this surface.

## Quickstart

```ts
import {
  createInspect,
  memoryAdapters,
} from "@inspect/hatch";

const inspect = createInspect(memoryAdapters());

// Mint a session → receive a capability bundle (not a Session facade).
const caps = await inspect.mint({
  repo: { owner: "acme", name: "payments" },
  baseBranch: "main",
  author: { id: "user_ada", displayName: "Ada", githubLogin: "ada" },
});

// Opaque id for bookmarks / rehydrate; not an object with methods.
const sessionId = caps.sessionId;

// Keystroke hint: sandbox warm starts; caller does not await sync/boot stages.
caps.sandbox.hintWarm();

// Enqueue a prompt (queued, never interrupt-insert). Authorship is bound into the handle.
const { promptId } = await caps.prompt.enqueue({
  text: "Add idempotency keys to the charge endpoint and cover with tests.",
});

// Realtime stream for any client (web, Slack, …).
for await (const event of caps.events.subscribe({ after: null })) {
  if (event.type === "agent.token") process.stdout.write(event.text);
  if (event.type === "sandbox.sync") console.log("sync", event.gate);
  if (event.type === "prompt.completed" && event.promptId === promptId) break;
}

// Sandbox already pushed the branch; open PR with the *user* GitHub token.
const pr = await caps.pullRequest.open({
  title: "Idempotency keys on charge endpoint",
  body: "Queued via Inspect hatch demo.",
  userGithubToken: process.env.GITHUB_USER_TOKEN!, // validated at boundary
});
console.log(pr.url);
```

Rehydrate later (another client, another author) without a shared mutable Session object:

```ts
const joined = await inspect.rehydrate(sessionId, {
  id: "user_bea",
  displayName: "Bea",
  githubLogin: "bea",
});
// joined.prompt is Bea’s authorship-bound handle; same session queue & stream.
await joined.prompt.enqueue({ text: "Also update the OpenAPI spec." });
await joined.prompt.stop(); // stops the currently running prompt, if any
```

## Call site 1 — Web route (create → prompt → stream → PR)

```ts
// apps/web/app/api/sessions/route.ts
import { inspect } from "@/server/inspect"; // createInspect(adapters) singleton
import { requireUser } from "@/server/auth";

export async function POST(req: Request) {
  const user = await requireUser(req);
  const body = await req.json(); // { repo, baseBranch, text }

  const caps = await inspect.mint({
    repo: body.repo,
    baseBranch: body.baseBranch,
    author: user.toAuthor(),
  });

  caps.sandbox.hintWarm();
  const { promptId } = await caps.prompt.enqueue({ text: body.text });

  // Return only opaque ids + one-time capability grants for the browser.
  // The browser talks via EventCursor over WebSocket using the grant.
  return Response.json({
    sessionId: caps.sessionId,
    promptId,
    eventGrant: caps.events.grantToken(),
    promptGrant: caps.prompt.grantToken(),
    sandboxGrant: caps.sandbox.grantToken(),
    prGrant: caps.pullRequest.grantToken(),
  });
}

// apps/web/lib/session-client.ts
export async function* watchSession(eventGrant: string) {
  const cursor = await inspect.eventsFromGrant(eventGrant);
  for await (const ev of cursor.subscribe({ after: null })) {
    yield ev; // domain SessionEvent — never Agents-SDK wire frames
  }
}

export async function openPr(prGrant: string, title: string, body: string, token: string) {
  const pr = await inspect.pullRequestFromGrant(prGrant);
  return pr.open({ title, body, userGithubToken: token });
}
```

## Call site 2 — Slack (thin client; classifier outside caps)

```ts
// apps/slack/handlers/mention.ts
import { inspect } from "../inspect";
import { classifyRepo } from "../repo-classifier"; // fast model; not part of session API

export async function onAppMention(msg: SlackMention) {
  const author = await slackUserToAuthor(msg.userId);
  const classified = await classifyRepo({
    text: msg.text,
    channel: msg.channelName,
    thread: msg.threadPreview,
  });
  if (classified.kind === "unknown") {
    await slack.reply(msg, "Which repo should I use?");
    return;
  }

  // Resume thread-bound session or mint a new capability bundle.
  const existingId = await threadSessions.get(msg.threadId);
  const caps = existingId
    ? await inspect.rehydrate(existingId, author)
    : await inspect.mint({
        repo: classified.repo,
        baseBranch: "main",
        author,
      });

  if (!existingId) await threadSessions.set(msg.threadId, caps.sessionId);

  caps.sandbox.hintWarm();
  await caps.prompt.enqueue({ text: msg.text });

  // Status clarity: project domain events → Block Kit. No OpenCode types here.
  for await (const ev of caps.events.subscribe({ after: msg.lastEventId ?? null })) {
    if (ev.type === "agent.status") await slack.updateStatus(msg, ev.message);
    if (ev.type === "pull_request.ready") {
      await slack.reply(msg, `Branch ready — open a PR from the web UI or react ✅`);
    }
    if (ev.type === "prompt.completed" || ev.type === "prompt.stopped") break;
  }
}
```

## Call site 3 — Agent child spawn + GitHub webhook

Child sessions are minted through a **spawn capability** handed to the runtime plugin — still not a Session facade.

```ts
// packages/agent-runtime/plugins/child-sessions.ts
export function childSessionPlugin(spawn: SpawnHandle) {
  return {
    tools: {
      spawn_session: async (args: { repo?: RepoRef; prompt: string }) => {
        const child = await spawn.child({
          repo: args.repo, // default: parent repo
          prompt: args.prompt,
          // authorship attributed to the parent prompt’s author
        });
        return { sessionId: child.sessionId };
      },
      session_status: async (args: { sessionId: string }) => {
        return spawn.status(args.sessionId as SessionId);
      },
    },
  };
}
```

GitHub webhooks hold only a **lifecycle** capability (no prompt enqueue):

```ts
// apps/api/github/webhook.ts
export async function onGitHubWebhook(raw: Request) {
  const event = await inspect.github.parseWebhook(raw); // → domain GitHubLifecycleEvent
  switch (event.type) {
    case "pull_request.merged":
    case "pull_request.closed":
    case "branch.deleted": {
      const life = await inspect.lifecycleFor(event.sessionId);
      await life.apply(event); // updates projections; idempotent
      break;
    }
  }
}
```

## What callers never do

- Coordinate image boot, git sync, or resume snapshot ordering
- Touch Modal / Durable Object / OpenCode SDK types
- Bind a session to a single author (handles rehydrate per author)
- Interrupt-insert prompts (enqueue is append-only; `stop` is explicit)
