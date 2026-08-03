# Cloudflare + Modal layer

Target: same three planes as Ramp / Open-Inspect, with the **local stack remaining the default** until each adapter is green on its own.

```
Clients (web → Slack/GitHub later)
        │
        ▼
Control plane ………… Cloudflare Worker
  SessionAgent DO     durable transcript, authorship, stop
  EventBus DO         hibernating WS fan-out
  D1 / R2             metadata, artifacts
        │ spawn / queue / locks
        ▼
Orchestration ……… Modal (Python)
  Session + Sandbox managers
  Dict locks, image metadata
  Queue prompt ingress
  Cron ~30m image rebuild + snapshot
        │ sandbox from snapshot
        ▼
Execution ………… Modal Sandbox
  Bun Runner          WS↔DO, prompt handler, JWT proxy factory
  OpenCode serve      in-sandbox
  Sidecars            code-server, VNC+Chromium, ttyd
```

Local today collapses all three into one Node process. CF + Modal **replace the stand-ins**, they do not fork a second product API.

## Port boundaries (what each plane must own)

These are the seams. Local already behaves like a trivial implementation of each.

| Port | Local stand-in | CF / Modal implementation |
| --- | --- | --- |
| `SessionStore` | `Map` + event list in memory | SessionAgent DO SQLite |
| `EventBus` | `createMemoryEventBus` | EventBus DO + hibernation |
| `PromptIngress` | `SessionQueues.enqueue` | Modal Queue (+ DO records turn) |
| `SandboxManager` | `GitSandboxManager` | Modal Sandbox Manager (snapshot boot, destroy, exec) |
| `ImageRegistry` | none (seed/clone) | Modal image recipes + 30m cron + Dict generation |
| `Runner` | `OpenCodeBridge` in-process | Bun process inside sandbox; only it talks to OpenCode |
| `Sidecars` | none | code-server / VNC / ttyd + JWT tunnels |
| `ScmAuth` | hardcoded local author | GitHub App install token + user OAuth for PRs |

Do not put prompt queues inside the sandbox. Do not put image rebuilds inside the SessionAgent DO. That split is load-bearing ([`TOPOLOGY.md`](TOPOLOGY.md)).

## Growth order (landable units)

Each unit leaves `npm test` / `npm run e2e` green on local. Cloud units get their own smoke under `scripts/` when credentials exist.

1. **Extract ports behind the control plane**  
   `startControlPlane` takes `SessionStore` / `SandboxManager` / `AgentBridge` / `EventBus`. Local wiring becomes the default inject. No behavior change.

2. **`opencode serve` Runner shape (still local)**  
   Move from host `opencode run` to a long-lived serve + HTTP/SDK inside a dedicated child (or container). Matches Ramp's server-first agent and unblocks sidecars later.

3. **Cloudflare SessionAgent + EventBus**  
   Durable transcript and WS fan-out. Prompt HTTP still enqueues; execution may still be local Runner for a while (hybrid is fine).

4. **Modal SandboxManager + Queue**  
   Replace `/tmp` git with snapshot boot. PromptIngress becomes Modal Queue. SessionQueues serial rule stays (drain one turn at a time per session).

5. **Image cron + freshness plugin**  
   30m rebuild, warm pool, OpenCode `tool.execute.before` write gate until sync completes.

6. **SCM + PR**  
   Push with install token; open PR with user token (Ramp's attribution rule).

7. **Sidecars + Slack**  
   JWT tunnels, then clients. Clients stay thin over the same session API.

## What we will not do

- Fork Open-Inspect into this hatch folder.
- Ship CF stubs that cannot create a session.
- Keep a second "fake cloud" demo path beside the working local product (already deleted once).
- Collapse EventBus into SessionAgent "to save a DO".

## Credentials / packages (when implementing)

Prefer maintained SDKs already common in this ecosystem:

- Cloudflare: Workers + Durable Objects (Agents SDK for hibernating WS, as Ramp cites)
- Modal: Modal Python sandbox APIs + snapshots (orchestration plane)
- OpenCode: typed SDK / serve (execution plane)
- Study [Open-Inspect `packages/control-plane` + `modal-infra` + `sandbox-runtime`](https://github.com/ColeMurray/background-agents) for proven wire shapes, then write our own modules under `src/` mapped to the ports above

## Verify when cloud lands

| Layer | Check |
| --- | --- |
| Local | `npm test` && `npm run e2e` && `npm run eval:smoke` (must stay green) |
| CF | Worker deploy; create session; WS receives `agent.delta`; DO survives isolate restart |
| Modal | Sandbox from snapshot; `opencode` write visible in repo FS; destroy frees sandbox |
| Hybrid | Prompt via CF → Queue → Modal Runner → events back on EventBus |

## Relation to deviations

See [`DEVIATIONS.md`](DEVIATIONS.md) for the full gap list. This file is only the path to close the control + orchestration + execution gaps without abandoning the local product.
