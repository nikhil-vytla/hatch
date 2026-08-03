# Module map (working local stack)

```
src/
  kernel/                 brands, Clock
  identity/               Actor, conversation/repo refs
  control/
    event-bus.ts          fan-out for WS clients
    session-queues.ts     per-session serial prompt chain
    resource-lifecycle.ts destroy + idle TTL reap
  sandbox/                GitSandboxManager (real git under /tmp)
  agent/
    opencode-bridge.ts    opencode run --dir
    models.ts             free-model list + resolve
  server/control-plane.ts Hono REST + WS UI
  session/                event types + pure queue/branch helpers
  slot/                   freshness + toolEffect policy
  index.ts
```

## Ownership

| Module | Owns |
| --- | --- |
| `server/control-plane` | HTTP/WS, session map, wiring |
| `control/session-queues` | one OpenCode turn at a time per session |
| `control/resource-lifecycle` | sandbox disk lifetime |
| `sandbox` | clone/seed, branch, commit, destroy |
| `agent` | OpenCode process + model selection |
| `session` | envelope types and pure policy (no actor god-object) |

## Dependency direction

```
scripts → server/control-plane
control-plane → sandbox + agent + control/{bus,queues,lifecycle}
control-plane → session types (envelopes only)
```

No fake `adapters/local` product path. Arena sketches stay under `arena/` as history.
