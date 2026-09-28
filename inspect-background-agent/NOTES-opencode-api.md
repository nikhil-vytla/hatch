# OpenCode from Node/TypeScript

These notes cover the installed `opencode-ai` and `@opencode-ai/sdk` version
1.18.11. The examples use the package's default SDK export, not its separate
`@opencode-ai/sdk/v2` preview.

## 1. Start the server

`opencode-ai` installs a binary named `opencode`. Start the headless server with:

```sh
./node_modules/.bin/opencode serve --hostname 127.0.0.1 --port 4096
# The same command from an npm script is: opencode serve --hostname 127.0.0.1 --port 4096
```

It prints:

```text
opencode server listening on http://127.0.0.1:4096
```

There is no `/api` prefix. The base URL is the printed URL. The CLI reports its
port option as `0`, but version 1.18.11 resolves an omitted or zero port to 4096.
Passing an explicit port is clearer. The SDK helper below defaults to
`127.0.0.1:4096` and returns the parsed URL:

```ts
import { createOpencodeServer } from "@opencode-ai/sdk";

const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 4096,
  timeout: 5_000,
});
console.log(server.url);
// Later: server.close()
```

The helper spawns an `opencode` command, so the binary must be on `PATH`.
Running the program through an npm script puts `node_modules/.bin` on `PATH`.

## 2. Create a session and send a prompt

The working directory is request context, not part of the session-create JSON
body. Supply it as the `directory` query parameter for raw HTTP. The SDK's
`directory` option handles this context for every call.

Raw HTTP:

```http
POST /session?directory=%2Fabsolute%2Fproject
Content-Type: application/json

{"title":"optional title"}
```

The response is a `Session` object whose `id` is used below.

```http
POST /session/{sessionID}/message?directory=%2Fabsolute%2Fproject
Content-Type: application/json

{"parts":[{"type":"text","text":"Explain this repository"}]}
```

`/message` waits for completion and returns:

```json
{"info":{"...":"assistant message fields"},"parts":[]}
```

For event-driven callers, send the same body to
`POST /session/{sessionID}/prompt_async?...`. It accepts the prompt and returns
HTTP 204 immediately. A prompt body can also select a model:

```json
{
  "model": {"providerID": "anthropic", "modelID": "provider-model-id"},
  "parts": [{"type": "text", "text": "Explain this repository"}]
}
```

SDK equivalents:

```ts
const created = await client.session.create({
  body: { title: "optional title" },
  throwOnError: true,
});
const session = created.data;

await client.session.promptAsync({
  path: { id: session.id },
  body: { parts: [{ type: "text", text: "Explain this repository" }] },
  throwOnError: true,
});
```

Use `client.session.prompt(...)` instead of `promptAsync(...)` when a blocking
response is preferable.

## 3. SSE events

Subscribe before sending an asynchronous prompt:

```http
GET /event?directory=%2Fabsolute%2Fproject
Accept: text/event-stream
```

Each SSE frame has JSON in its `data` field:

```text
data: {"id":"evt_...","type":"server.connected","properties":{}}

```

The SDK parses frames and exposes an async generator:

```ts
const result = await client.event.subscribe({ signal });
for await (const event of result.stream) {
  // event.type is the discriminant
}
```

Useful event types are:

- `message.part.updated`: `properties.delta` carries streamed text and
  `properties.part.sessionID` identifies the session.
- `session.status`: reports `busy`, `retry`, or `idle`.
- `session.idle`: completion signal in `properties.sessionID`.
- `session.error`: terminal provider or session error.

The directory event stream can contain several sessions, so filter by session
ID. Open the stream before calling `promptAsync`; otherwise a fast completion
can be missed. The first event on a new connection is `server.connected`, which
can be awaited as a connection barrier. The lower-level global endpoint,
`GET /global/event`, wraps each event as `{ directory, payload }`.

The generated SSE client parses JSON, supports `Last-Event-ID`, and retries
failed connections with exponential backoff. Abort its signal when done.

## 4. Minimal complete TypeScript example

```ts
import {
  createOpencodeClient,
  createOpencodeServer,
} from "@opencode-ai/sdk";

const cwd = process.argv[2] ?? process.cwd();
const prompt = process.argv[3] ?? "Summarize this project.";
const sseAbort = new AbortController();

const server = await createOpencodeServer({
  hostname: "127.0.0.1",
  port: 4096,
});

try {
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: cwd,
  });

  const created = await client.session.create({
    body: { title: "Node SDK run" },
    throwOnError: true,
  });
  const session = created.data;

  const subscription = await client.event.subscribe({
    signal: sseAbort.signal,
  });
  const events = subscription.stream[Symbol.asyncIterator]();

  // Starts the lazy SSE request and waits for "server.connected".
  const connected = await events.next();
  if (connected.done === true) throw new Error("OpenCode event stream closed");

  await client.session.promptAsync({
    path: { id: session.id },
    body: {
      parts: [{ type: "text", text: prompt }],
    },
    throwOnError: true,
  });

  for (;;) {
    const next = await events.next();
    if (next.done === true) throw new Error("OpenCode event stream closed");
    const event = next.value;

    if (
      event.type === "message.part.updated" &&
      event.properties.part.sessionID === session.id &&
      event.properties.part.type === "text" &&
      event.properties.delta
    ) {
      process.stdout.write(event.properties.delta);
    }

    if (
      event.type === "session.error" &&
      event.properties.sessionID === session.id
    ) {
      throw new Error(JSON.stringify(event.properties.error));
    }

    if (
      event.type === "session.idle" &&
      event.properties.sessionID === session.id
    ) {
      process.stdout.write("\n");
      break;
    }
  }

  await events.return(undefined);
} finally {
  sseAbort.abort();
  server.close();
}
```

This assumes OpenCode already has a default model. To choose one per prompt,
add the `model: { providerID, modelID }` object shown above.

## 5. Provider credentials

For API-key authentication, export the key before starting the Node process.
The spawned server inherits the process environment:

```sh
export ANTHROPIC_API_KEY="..."
# or
export OPENAI_API_KEY="..."
```

Only the variable for the selected provider is needed. No extra OpenCode
environment variable is required. As an alternative, `opencode auth login`
stores provider credentials in `~/.local/share/opencode/auth.json`, in which
case these environment variables are unnecessary.

OpenCode also supports explicit config substitution such as
`"apiKey": "{env:ANTHROPIC_API_KEY}"`. `createOpencodeServer({ config })` sends
that config through `OPENCODE_CONFIG_CONTENT`. For a remotely reachable server,
set `OPENCODE_SERVER_PASSWORD`; it enables HTTP Basic auth, with username
`opencode` unless `OPENCODE_SERVER_USERNAME` overrides it.
