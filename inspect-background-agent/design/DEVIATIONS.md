# Where hatch Inspect differs

Three references matter:

1. [Ramp builders post](https://builders.ramp.com/post/why-we-built-our-background-agent) (product + sandbox/API/clients spec)
2. Ramp CTO three-plane topology ([`TOPOLOGY.md`](TOPOLOGY.md), [`ramp-cto-topology.mmd`](ramp-cto-topology.mmd)) + [Modal write-up](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal)
3. [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) (Open-Inspect), the closest OSS clone

This hatch is **inspired by those**, not a fork. Local `npm run serve` is a thin end-to-end slice so we can prove agent + git + lifecycle before wiring Cloudflare and Modal.

## Short answer

| Plane | Ramp / Open-Inspect | Hatch today |
| --- | --- | --- |
| Control | Cloudflare Worker + SessionAgent DO (SQLite) + EventBus DO + D1/R2 | Single Node Hono process, in-memory session map + EventBus |
| Orchestration | Modal Session/Sandbox managers, Dict locks, Queue ingress, 30m image cron | `GitSandboxManager` under `/tmp` (seed or clone, no snapshots) |
| Execution | Modal Sandbox: Bun Runner + `opencode serve` + sidecars (code-server/VNC/ttyd) | Host process: `opencode run --dir` via SDK bridge, no sidecars |
| Clients | Web, Slack, Chrome extension, GitHub/Linear bots | Embedded web UI + REST/WS only |
| Auth / PRs | GitHub App install token for clone/push; user OAuth to open PRs as the human | Local git author only; no GitHub App, no PR open |
| Multiplayer | Many authors on one SessionAgent DO; attribution per prompt | One author field per session; follow-ups reuse that author |
| Warm start | Snapshot pool + typeahead warm + sync gate before writes | Cold seed/clone each session |
| Agent | OpenCode **server** inside sandbox, Runner bridges WS↔DO | OpenCode **CLI/run** on the control host against the sandbox dir |

We kept the **ideas** that make Inspect work (isolated git workspace, serial prompts, authorship, OpenCode, event envelopes). We deferred the **cloud machinery** that makes it scale and feel instant.

## Detail by Inspect concern

### Sandbox / images (Ramp blog "Sandbox")

| Spec | Hatch |
| --- | --- |
| Per-repo Modal image registry | None. Seed files or `git clone` into `/tmp/hatch-inspect/sandboxes` |
| Rebuild every ~30 minutes | No cron |
| Snapshot restore for follow-ups | Destroy on DELETE / TTL; follow-up reuses the live dir only while the process holds the session |
| Warm on keystroke / warm pool | No |
| Read-before-sync, block writes until fresh | Pure `Freshness` / `toolEffect` types exist in `slot/`; not wired into OpenCode plugins |
| Full eng env (Vite, Postgres, Temporal, …) | Whatever is on the host PATH; no image recipe |

### Agent (OpenCode)

| Spec | Hatch |
| --- | --- |
| OpenCode as **server-first** inside the sandbox | `OpenCodeBridge` uses run-style calls with `--dir` (host-side) |
| Bun Runner: prompt drain, JWT sidecar proxies, WS to SessionAgent | Collapsed into `control-plane.ts` calling the bridge directly |
| Plugin on `tool.execute.before` for sync gate | Not installed |
| Spawn-child sessions | Not built |
| Frontier models + org skills/MCPs | Free `opencode/*` list + `OPENCODE_MODEL`; no Ramp MCP/Sentry/Datadog wiring |

### API / control (Ramp blog "API")

| Spec | Hatch |
| --- | --- |
| Cloudflare Durable Object per session (SQLite transcript) | `Map<string, SessionRow>` in one Node process |
| Agents SDK + hibernating WebSockets | `@hono/node-ws`; sockets die with the process |
| Separate EventBus DO | In-process `createMemoryEventBus` |
| Modal Queue for prompt ingress while compute cold | `SessionQueues` promise chain (serial execution only; no durable cross-process queue) |
| D1 metadata/auth/memories, R2 artifacts | None |
| GitHub webhook → PR state | None |

### Clients

| Spec | Hatch |
| --- | --- |
| Slack + repo classifier | No |
| Polished multi-client web + mobile | Minimal embedded UI with multi-session list |
| Session archive / restore / delete | Yes locally (see [`SESSIONS.md`](SESSIONS.md)); no durable DO/snapshot yet |
| User fork + agent spawn-child | User fork yes; agent spawn-child tool no |
| code-server / VNC / ttyd iframes | No (`ideUrl`/`vncUrl`/`ttyUrl` removed with the old actor) |
| Chrome extension / React Grab | No |
| Org stats / merged-PR dashboards | No |

### What we still match on purpose

- Prompt queue is **serial per session** (Ramp's choice: queue follow-ups, don't barge in).
- Commits use the **prompting author's** name/email (local stand-in for "push as app, PR as user").
- Event envelopes carry `origin` + typed `kind` so a future EventBus DO can fan out the same shapes.
- Sandboxes are **outside** the hatch git root (`--dir` + `/tmp`) so OpenCode cannot write into this repo.
- Three-plane **ownership** in docs: control vs orchestration vs execution stay separate concerns even when all three run in one process today.

## Vs Open-Inspect ([ColeMurray/background-agents](https://github.com/ColeMurray/background-agents))

Open-Inspect is the full CF + multi-provider sandbox product (Modal, Daytona, E2B, …) plus Slack/GitHub/Linear bots, automations, multi-repo environments, child sessions, secrets, tunnels.

| Open-Inspect | Hatch |
| --- | --- |
| Monorepo: `control-plane`, `modal-infra`, `sandbox-runtime`, bots, `web` | One package: local Hono + git + OpenCode |
| CF Workers deploy | `tsx scripts/serve.ts` |
| Pluggable sandbox providers | Only local disk git |
| Single-tenant GitHub App security model | No SCM integration yet |
| Snapshot / image prebuild | No |

We studied that layout and Valet forks for the peer matrix ([`HARNESSES.md`](HARNESSES.md)). We did **not** copy packages or wire formats.

## Intentional non-goals for the local layer

Per experiment [`AGENTS.md`](../AGENTS.md): smallest product that works end-to-end, then grow. Shipping a half-wired Worker + empty Modal stub would trade a working agent for unfinished cloud complexity.

Cloud support is the **next layer**, not a rewrite of the local path. See [`CLOUD.md`](CLOUD.md).
