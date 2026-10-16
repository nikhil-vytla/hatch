# Cloudflare + Modal layer

Target topology matches Ramp / Open-Inspect. Local monolith (`npm run serve`) stays the default demo. Cloud is a **second entry** that splits planes.

```
Clients (web UI on serve:cloud, bots → CF Worker)
        │
        ▼
Control plane ………… Cloudflare Worker + DOs
                     OR Node serve:cloud (SQLite SessionAgent stand-in)
        │ HTTP compute contract
        ▼
Orchestration/Execution … Modal ASGI (cloud/modal)
                     OR local compute shim (npm run compute:shim)
```

## What landed

| Piece | Path | Role |
| --- | --- | --- |
| Compute contract + client | `src/compute/client.ts` | Shared HTTP API |
| Local compute shim | `scripts/compute-shim.ts` | Modal stand-in (`backend: local-shim`) |
| Modal app | `cloud/modal/inspect_modal/app.py` | Sandboxes + Dict + Queue + same HTTP API |
| SQLite SessionAgent | `src/control/session-store-sqlite.ts` | DO-shaped durable transcript (Node) |
| Cloud control plane | `src/server/control-plane-cloud.ts` | Control → compute; same `/api` + UI |
| Cloudflare Worker | `cloud/cloudflare/` | Real `SessionAgent` + `EventBus` DOs |

## Commands

```bash
# Plane B — compute (pick one)
npm run compute:shim                          # :8790 local
# or: modal deploy cloud/modal/inspect_modal/app.py

# Plane A — control (pick one)
COMPUTE_URL=http://127.0.0.1:8790 npm run serve:cloud   # :8788 + UI
# or: cd cloud/cloudflare && npm i && npm run dev

# Prove three-plane path
npm run e2e:cloud
```

## Port boundaries

| Port | Local monolith | Cloud |
| --- | --- | --- |
| SessionStore | in-memory `Map` | SQLite store / CF SessionAgent DO |
| EventBus | memory bus | memory bus / CF EventBus DO |
| SandboxManager + Runner | in-process git + OpenCode | Compute HTTP (shim or Modal) |
| Prompt queue | `SessionQueues` | same + Modal Queue on ingest (Modal) |

## Growth still open

1. OpenCode baked into Modal image (prompt currently falls back to a note file if `opencode` missing)
2. Image cron + snapshot restore
3. Sidecars (VNC/code-server) → Screenshots tab
4. Point production web UI at CF Worker URL
5. SCM / PR authorship

## Verify

| Check | Command |
| --- | --- |
| Local monolith | `npm test && npm run e2e` |
| Three-plane | `npm run e2e:cloud` |
| Modal | `modal deploy` then `COMPUTE_URL=… npm run serve:cloud` |
| Cloudflare | `cd cloud/cloudflare && npm run dev` with shim running |
