# Using an Inspect session

The API accepts intent and returns receipts. Sandbox boot, git sync, prompt scheduling, snapshots, branch push, and PR creation happen behind the session boundary. `watch` exposes stable product updates rather than storage records or OpenCode messages.

## Local quickstart

The local package uses an in-memory journal, fake sandbox, fake agent, and fake GitHub. It needs no Cloudflare, Modal, OpenCode, or GitHub credentials.

```ts
import { idempotencyKey, repositorySlug } from "@inspect/client";
import { createLocalInspect } from "@inspect/local";

const local = createLocalInspect({
  repositories: [
    {
      slug: repositorySlug("acme/payments"),
      defaultBranch: "main",
      files: { "README.md": "# Payments\n" },
    },
  ],
});

const ada = local.clientFor({
  subject: "local-user:ada",
  displayName: "Ada",
  githubLogin: "ada",
});

const created = await ada.sessions.create({
  repository: repositorySlug("acme/payments"),
  requestKey: idempotencyKey("demo:create"),
});

await ada.sessions.submitPrompt({
  sessionId: created.sessionId,
  text: "Add a health endpoint and its tests.",
  requestKey: idempotencyKey("demo:prompt:1"),
});

for await (const update of ada.sessions.watch({
  sessionId: created.sessionId,
  after: created.cursor,
})) {
  if (update.kind === "prompt.completed") {
    break;
  }
}

const requested = await ada.sessions.openPullRequest({
  sessionId: created.sessionId,
  title: "Add payment service health endpoint",
  requestKey: idempotencyKey("demo:pr:1"),
});

for await (const update of ada.sessions.watch({
  sessionId: created.sessionId,
  after: requested.cursor,
})) {
  if (update.kind === "pull_request.opened") {
    console.info(update.url);
    break;
  }
}
```

Submitting a prompt is enough to boot or resume the sandbox. The agent may read while git sync is running. Its write tools remain blocked until the session reports a synced revision.

## Web multiplayer

Each client authenticates as its user. The server attributes every prompt and PR request to that user. A draft activity hint starts warming on the first keystroke, but it does not create a prompt or expose a sandbox handle.

```ts
import {
  createInspectClient,
  idempotencyKey,
  repositorySlug,
  type SessionId,
} from "@inspect/client";

const alice = createInspectClient({
  endpoint: "/api/inspect",
  authenticate: () => auth.accessTokenFor("alice"),
});
const bob = createInspectClient({
  endpoint: "/api/inspect",
  authenticate: () => auth.accessTokenFor("bob"),
});

const { sessionId } = await alice.sessions.create({
  repository: repositorySlug("acme/payments"),
  requestKey: idempotencyKey(crypto.randomUUID()),
});

editor.onFirstChange(() =>
  alice.sessions.noteDraftActivity({
    sessionId,
    requestKey: idempotencyKey(`draft:${editor.draftId}`),
  }),
);

await Promise.all([
  alice.sessions.submitPrompt({
    sessionId,
    text: "Find why webhook retries create duplicate rows.",
    requestKey: idempotencyKey("alice:prompt:42"),
  }),
  bob.sessions.submitPrompt({
    sessionId,
    text: "After that, add a regression test.",
    requestKey: idempotencyKey("bob:prompt:17"),
  }),
]);

function renderSharedSession(id: SessionId): () => void {
  const abort = new AbortController();

  void (async () => {
    for await (const update of alice.sessions.watch({
      sessionId: id,
      signal: abort.signal,
    })) {
      sessionStore.apply(update);
    }
  })();

  return () => abort.abort();
}
```

The journal orders concurrent submissions. The queue projection preserves that order, so Bob's prompt waits instead of interrupting Alice's active run.

## Slack thread and user-authored PR

The Slack adapter verifies Slack input before this handler. Its thread table stores only the Inspect `SessionId`. It resolves the Slack user to an Inspect login, so the same person appears as one author in web and Slack.

```ts
import {
  createInspectClient,
  idempotencyKey,
  repositorySlug,
} from "@inspect/client";
import type { VerifiedSlackMention } from "./slack-boundary";

export async function handleInspectMention(
  message: VerifiedSlackMention,
): Promise<void> {
  const inspect = createInspectClient({
    endpoint: process.env.INSPECT_URL!,
    authenticate: () => linkedAccounts.inspectToken(message.userId),
  });

  const existing = await threadSessions.get(message.threadId);
  const sessionId =
    existing ??
    (
      await inspect.sessions.create({
        repository: repositorySlug(message.repository),
        requestKey: idempotencyKey(`slack-thread:${message.threadId}`),
      })
    ).sessionId;

  await threadSessions.putIfAbsent(message.threadId, sessionId);

  if (message.text === "stop") {
    await inspect.sessions.stop({
      sessionId,
      requestKey: idempotencyKey(`slack-stop:${message.messageId}`),
    });
    return;
  }

  await inspect.sessions.submitPrompt({
    sessionId,
    text: message.text,
    requestKey: idempotencyKey(`slack-message:${message.messageId}`),
  });
}

export async function openPrFromSlack(
  message: VerifiedSlackMention,
): Promise<void> {
  const inspect = createInspectClient({
    endpoint: process.env.INSPECT_URL!,
    authenticate: () => linkedAccounts.inspectToken(message.userId),
  });
  const sessionId = await threadSessions.require(message.threadId);

  await inspect.sessions.openPullRequest({
    sessionId,
    title: "Fix duplicate webhook deliveries",
    requestKey: idempotencyKey(`slack-pr:${message.messageId}`),
  });
}
```

`openPullRequest` records an opaque authorization grant for the authenticated caller. The sandbox subscriber pushes the branch first. The GitHub subscriber then resolves the grant and opens the PR as that user. No OAuth token enters the session journal.
