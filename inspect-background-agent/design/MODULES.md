# Module map (refined)

Three planes, ownership-first. Public callers still see `Inspect` → `Workspace` → `Session`.

```
src/
  kernel/              brands, Result, Clock
  identity/            Actor, tokens, conversation refs
  control/
    event-bus.ts       fan-out port (EventBus DO–shaped)
    prompt-ingress.ts  queue port (Modal Queue–shaped)
  workspace/           orchestration plane: images, pool, leases, routing
  slot/                Freshness, LeasedSlot, MutableSlot, tool effects
  session/             SessionAgent–shaped: mailbox, transcript, publish
  runner/              in-sandbox supervisor: OpenCode bridge, sidecar URLs
  agent/               OpenCode (or fake) port — only Runner calls it
  adapters/local/      in-process stand-ins for CF + Modal + sandbox
  index.ts
```

## Ownership

| Module | Owns | Maps to Inspect |
| --- | --- | --- |
| `control/event-bus` | Live subscriber fan-out, origin-tagged publish | EventBus DO |
| `control/prompt-ingress` | Cross-client enqueue while sandbox cold | Modal Queue |
| `workspace/` | Image generation, pool, leases, branch namespace | Modal Session/Sandbox Mgr + Dict + images |
| `slot/` | Sync gate capability (`admitWrites`) | Sandbox FS freshness |
| `session/` | Durable turns, authorship, PR open orchestration | SessionAgent DO |
| `runner/` | Prompt drain → agent, sidecar endpoint minting | Bun Runner + Proxy Factory |
| `agent/` | Model tool loop | OpenCode serve/SDK |

## Dependency direction

```
clients → Inspect → session + workspace
session → control (bus, ingress) + runner
runner  → agent + slot (via session-held lease)
workspace → slot acquisition
adapters/local implements all ports
```

No path from `agent/` up to `session/`. Runner is the only bridge, matching the CTO diagram's PromptHandler ↔ SessionAgent WebSocket.
