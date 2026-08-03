# Inspect hatch — usage (working product)

Local background coding agent. Control plane is the product surface.

## Quickstart

```bash
cd inspect-background-agent
npm install
npm run serve   # http://127.0.0.1:8787
```

Or scripted:

```ts
import { startControlPlane } from "@hatch/inspect";

const cp = await startControlPlane({ port: 8787 });
// POST /api/sessions { prompt } → OpenCode writes in /tmp sandbox
// DELETE /api/sessions/:id → disk gone
await cp.close();
```

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | ok + selected model |
| GET | `/api/models` | known-free OpenCode models |
| POST | `/api/sessions` | `{ prompt?, title?, cloneUrl?, authorName?, authorEmail? }` |
| GET | `/api/sessions/:id` | status + git diff |
| POST | `/api/sessions/:id/prompt` | `{ text }` queued serially per session |
| POST | `/api/sessions/:id/commit` | commit dirty tree as author |
| DELETE | `/api/sessions/:id` | destroy sandbox disk |
| WS | `/api/sessions/:id/events` | `SessionEventEnvelope` stream |

## Env

- `OPENCODE_MODEL` — model id under provider `opencode` (default `big-pickle`)
- `OPENCODE_PROVIDER` — default `opencode`

## Verify

```bash
npm test
npm run e2e
npm run eval:smoke
```

Cloud adapters (CF Durable Objects, Modal) are design targets in `TOPOLOGY.md`, not this local product.
