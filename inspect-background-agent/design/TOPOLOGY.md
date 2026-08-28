# Topology: three planes

Source: Ramp CTO diagram ([`ramp-cto-topology.mmd`](ramp-cto-topology.mmd)) plus [Modal's Inspect write-up](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal).

## Target (Ramp / Open-Inspect shape)

```
┌─────────────────────────────────────────────────────────────┐
│  Control plane — Cloudflare Worker                          │
│  REST → SessionAgent DO (SQLite transcript, questions)      │
│       → EventBus DO (WS fan-out, Slack notify)              │
│  D1 metadata/auth/memories · R2 screenshots/uploads         │
└───────────────────────────┬─────────────────────────────────┘
                            │ spawn / queue / locks
┌───────────────────────────▼─────────────────────────────────┐
│  Orchestration plane — Modal Python                         │
│  Session Manager · Sandbox Manager · image recipes          │
│  Dict (locks, image metadata) · Queue (prompt ingress)      │
│  Cron: rebuild snapshots ~30m                               │
└───────────────────────────┬─────────────────────────────────┘
                            │ sandbox from snapshot
┌───────────────────────────▼─────────────────────────────────┐
│  Execution plane — Modal Sandbox                            │
│  Runner (Bun): WS↔DO, prompt handler, JWT proxy factory     │
│  OpenCode serve + SDK (model providers)                     │
│  Side cars: code-server, VNC+Chromium, ttyd                 │
│  Repo FS + runner volume                                    │
└─────────────────────────────────────────────────────────────┘
```

## Local today (one process, same ownership)

```
┌─────────────────────────────────────────────────────────────┐
│  control-plane.ts (Hono + WS UI)                            │
│  SessionRow Map · EventBus · SessionQueues · Lifecycle      │
│  GitSandboxManager (/tmp) · OpenCodeBridge (host run --dir) │
└─────────────────────────────────────────────────────────────┘
```

| Plane | Target | Local stand-in |
| --- | --- | --- |
| Control | SessionAgent DO + EventBus DO | session map + memory EventBus + Hono |
| Orchestration | Modal managers + Queue + images | `GitSandboxManager` + in-process queue |
| Execution | Bun Runner + OpenCode serve + sidecars | `OpenCodeBridge` on the host |

How we diverge in full: [`DEVIATIONS.md`](DEVIATIONS.md). How we add CF + Modal without rewriting local: [`CLOUD.md`](CLOUD.md).

## Prompt path

**Target:** Client → Worker → SessionAgent records turn → Modal Queue → Runner → OpenCode → WS back to SessionAgent → EventBus → UIs.

**Local:** Client → Hono → `SessionQueues` → `OpenCodeBridge.runPrompt` → memory EventBus → WS.

Serial execution per session is the same rule in both.

## Mistakes to avoid when adding cloud

- Merging EventBus into SessionAgent (reconnect + Slack want a broadcast DO).
- Skipping Runner (sidecars/JWT and OpenCode restarts need an in-sandbox supervisor).
- Putting cross-client enqueue only inside a hot sandbox (use Modal Queue).
- Flat "one image" with no generation/recipe hash for pool expiry.
