# Module map — candidate 1 (session-as-actor)

Modules group by the knowledge they own, not by pipeline stage. The sketch is one file
for review; this is the intended layout.

| Module | Owns (the knowledge that changes together) | Public surface | Key files |
| --- | --- | --- | --- |
| `core` | Identity (branded ids), time, git/GitHub value types, branch↔session derivation | id constructors, `branchFor`/`sessionForBranch` | `core/ids.ts`, `core/refs.ts` |
| `session` | What a session **is**: phase machine, sync gate semantics, prompt queue + attribution, event log, coordination of fleet/runtime/GitHub | `SessionHandle`, `SessionView`, `SessionEvent(Envelope)` | `session/state.ts`, `session/actor.ts`, `session/events.ts`, `session/store.ts` (port) |
| `hub` | Which sessions exist and how to reach them; create idempotency; webhook fan-in; warm-hint entry point | `SessionHub`, `createSessionHub` | `hub/hub.ts`, `hub/spawner.ts` |
| `sandbox` | Images, snapshots, warm pools, git sync mechanics, agent-server boot | `SandboxFleet`, `LiveSandbox` | `sandbox/fleet.ts` (port), `sandbox/images.ts` (internal), `sandbox/adapters/{modal,local}.ts` |
| `agent` | Agent-server protocol; wire→`AgentDelta` translation; capability→plugin mapping (sync gate hook, status tool, child-spawn tools) | `AgentRuntime`, `AgentConn`, `SessionCapabilities`, `AgentDelta` | `agent/runtime.ts` (port), `agent/adapters/{opencode,fake}.ts` |
| `github` | GitHub protocol: PR REST shapes, webhook signature + parse, app-vs-user auth | `GitHubPort`, `TokenVault`, `GitHubWebhookEvent` | `github/port.ts`, `github/adapters/{octokit,fake}.ts` |
| `clients/slack` | Slack transport only: thread↔session index, Block Kit rendering, repo classification | `SlackClientAdapter` | `clients/slack/adapter.ts`, `clients/slack/render.ts`, `clients/slack/classifier.ts` (port) |
| `clients/web` | HTTP/WS mapping only | `webRoutes` | `clients/web/routes.ts`, `clients/web/webhooks.ts` |
| `local` | Concrete wiring for the credential-free demo | `createLocalInspect` | `local/index.ts` |

## Dependency direction

```
clients/slack ─┐
clients/web  ──┼──▶ hub ──▶ session ──▶ { sandbox, agent, github } (ports only)
               │                 ▲
local ─────────┴── (only module that imports adapters) ──▶ adapters implement ports
```

- Clients import **only** the hub surface (`SessionHub`, `SessionHandle`, event types)
  plus `GitHubPort.parseWebhook` at the webhook boundary. They never import sandbox,
  agent, or store types.
- `session` depends on ports, never adapters. Adapters (`modal`, `opencode`, `octokit`,
  and their fakes) are referenced only by the `local` (and future `prod`) composition
  root.
- No module imports another module's internals: `ImageRegistry` and the warm pool are
  private to `sandbox`; the thread index is private to `clients/slack`; the event log
  format is private to `session`.

## Ownership of the tricky invariants

| Invariant | Single owner | How others see it |
| --- | --- | --- |
| Writes blocked until git sync done | `sandbox` (gate truth on `LiveSandbox`) | actor mirrors as `gate.changed` events; agent plugin polls `caps.gate()` |
| One writer per session state | `session` (actor mailbox) | clients send commands, receive events |
| Prompt ordering + stop semantics | `session` (queue in `SessionState`) | `prompt.*` events; `queuePaused` in view |
| Authorship of commits and PRs | `session` (prompt records) + `sandbox.setCommitAuthor` | PR co-author trailers; `pr.opened` carries `by` |
| Branch↔session correspondence | `core` (pure derivation) | hub routes webhooks with it |
| Image freshness / warm pool expiry | `sandbox` internal | nobody — invisible above the fleet port |
