# Topology: three planes

Source: Ramp CTO diagram (saved as [`ramp-cto-topology.mmd`](ramp-cto-topology.mmd)) plus [Modal's Inspect write-up](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal).

Our first synthesis treated "workspace" and "session" as the whole story. The CTO diagram splits the system into three planes. That split is load-bearing; collapsing it is how harnesses accidentally put prompt queues inside VMs or put image rebuilds inside session actors.

## Planes

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

## Prompt path (happy case)

1. Client HTTP posts a prompt to the Worker API (or Slack → API).
2. SessionAgent DO records authorship and durable message parts.
3. Prompt lands on Modal Queue (multiplayer fan-in without blocking the DO).
4. Session Manager drains the queue into the live sandbox's Runner.
5. Runner calls OpenCode over localhost HTTP; events stream back.
6. Runner WebSockets opencode events into SessionAgent; EventBus fans to UIs.
7. Side-car iframes (VS Code / VNC / ttyd) hit Modal tunnels through JWT proxies the Runner minted. Humans edit the same repo FS the agent uses.

## Mapping onto our hatch modules

| Real Inspect | Hatch module | Note |
| --- | --- | --- |
| SessionAgent DO | `session/` mailbox + event log | Durable transcript owner |
| EventBus DO | `control/event-bus` | Fan-out separated from persistence |
| Modal Queue | `control/prompt-ingress` | Decouples client submit from Runner drain |
| Session/Sandbox Manager + images + Dict | `workspace/` | Supply / leases / freshness (unchanged root) |
| Runner | `runner/` | Was buried in "agent runtime"; now first-class |
| OpenCode | `agent/` port | Still a port; Runner is the only caller |
| code-server / VNC / ttyd | `runner/sidecars` | JWT tunnel endpoints on SessionView |
| D1 / R2 | local adapters stubs | Metadata + artifact bags |

## What we got wrong earlier (and fixed)

- **Merged EventBus into Session.** Clients reconnecting and Slack notifications want a broadcast DO that can hibernate sockets cheaply. Session SQLite stays the source of transcript truth; EventBus is a projection fan-out.
- **No Runner.** Treating OpenCode as talking directly to the DO skips proxy/JWT tunnels, prompt webhook callbacks, and the Bun process that survives OpenCode restarts.
- **Prompt queue only inside the session actor.** Modal Queue is the cross-client ingress; the session actor still serializes *execution*, but enqueue from Slack/web/extension should not require the sandbox to be awake.
- **Flat "image".** Recipes layer: base tools → app runtime → data-plane services → platform images. Staleness and pool expiry key off generation + recipe hash.

## Hatch simplification (still intentional)

In-process EventBus and an in-memory prompt ingress stand in for DO + Modal Queue. Runner is a local object that drives the scripted agent and publishes sidecar URLs. Cross-DO leasing and real Modal tunnels remain adapter swaps, not public API.
