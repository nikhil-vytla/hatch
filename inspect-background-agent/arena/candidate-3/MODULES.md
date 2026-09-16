# Module map — capability-token session

Ownership groups knowledge, not pipeline stages. Public callers import only `@inspect/hatch` factory + handles.

```
@inspect/hatch
├── public/
│   ├── factory          createInspect, mint, rehydrate, *FromGrant
│   ├── handles          PromptHandle, SandboxHandle, EventCursor,
│   │                    PullRequestHandle, SpawnHandle, LifecycleHandle
│   └── types            brands, SyncGate, SessionPhase, PromptQueue*, SessionEvent
├── actor/               SessionActorPort + memory | durable-object adapters
├── sandbox/             SandboxPort + fake | modal-shaped adapters; ImageRegistryPort
├── agent/               AgentRuntimePort; plugin wiring (sync gate, status, spawn)
├── github/              GitHubPort; webhook parse → GitHubLifecycleEvent
└── clients/             thin web grant helpers, Slack mention binder (optional)
```

## Ownership

| Module | Owns | Does not own |
| --- | --- | --- |
| **public/factory** | Minting & rehydrating capability bundles; grant token encode/decode; wiring handles to ports | Sandbox boot policy details; OpenCode protocol |
| **public/handles** | Narrow authority APIs; authorship binding on `PromptHandle`; boundary parse (e.g. user GitHub token) | Queue drain algorithm internals; image registry |
| **actor/** | Per-session state: authors, prompt queue, event log, phase, gate projection, branch/PR records; idempotent lifecycle apply | VM lifecycle; model inference |
| **sandbox/** | Acquire from snapshot, warm coalesce, git sync gate callbacks, push branch, resume snapshot, ide URL | Prompt queue; PR API with user token |
| **agent/** | Runtime process in sandbox; run/stop prompt; plugin hooks that *read* gate / *call* spawn / *post* status | Session persistence; GitHub webhooks |
| **github/** | Open PR with user token; verify webhook signatures; map deliveries to `GitHubLifecycleEvent` | Deciding when a branch is ready to PR |
| **clients/** | Transport adapters (HTTP/WS/Slack) that hold grants and project `SessionEvent` → UI | Domain invariants (must call handles) |

## Who talks to whom

```
Web / Slack / Webhook
        │
        ▼
 InspectFactory ──mint/rehydrate──► SessionCapabilities (handles)
        │                                │
        │                                ├ PromptHandle ──► actor (+ agent.stop/run via drain)
        │                                ├ SandboxHandle ─► actor (phase/gate) + sandbox.hintWarm
        │                                ├ EventCursor ───► actor.readEvents
        │                                ├ PullRequestHandle ► sandbox.pushBranch + github.openPR + actor
        │                                ├ SpawnHandle ───► factory.mint (child) + actor.status
        │                                └ LifecycleHandle ► actor.applyLifecycle
        │
        ├── SessionActorPort
        ├── SandboxPort ◄── ImageRegistryPort
        ├── AgentRuntimePort ◄── plugins close over SpawnHandle + gate reader
        └── GitHubPort
```

Short chains: client → handle → (actor | sandbox | github | agent). No client → orchestrator → stage1 → stage2 pipeline modules.

## Hatch adapters

| Port | Local fake | Cloud-shaped |
| --- | --- | --- |
| `SessionActorPort` | In-memory map + async queue per `SessionId` | Cloudflare Durable Object (one SQLite DB / session) |
| `SandboxPort` | Instant acquire; timer or immediate `gate → ready` | Modal sandbox + filesystem snapshots |
| `ImageRegistryPort` | Fixture `SnapshotId` per repo | Registry rebuilt ~30m |
| `AgentRuntimePort` | Echo tokens / scripted tool calls | OpenCode server + plugins |
| `GitHubPort` | Record PRs in memory; accept test webhooks | GitHub App + user OAuth token |

## Deliberate extension points (omitted)

- Chrome MDM / extension DOM selection — future client holding same grants
- Voice — another event source into `PromptHandle.enqueue`
- Full internal MCP suite — plugins registered on `AgentRuntimePort`, not new public handles
